import { expect, test } from "bun:test"
import { Master } from "../src/http/server"
import { openDatabase } from "../src/db/client"
import type { Config } from "../src/config"

const config: Config = {
  port: 0, host: "127.0.0.1", dbPath: ":memory:", jwtSecret: "test-secret", jwtTTLSeconds: 3600,
  heartbeatTimeoutMs: 15_000, leaseTTLMs: 60_000, schedulerIntervalMs: 60_000,
  bootstrapApiKey: "dev-admin-key", maxSessionsPerUser: 0, placementCandidates: 3, workerProxyCredential: "internal",
}

async function token(master: Master, role: "admin" | "user" = "admin") {
  const response = await master.fetch(new Request("http://master/api/v1/auth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: "dev-admin-key", user: role === "admin" ? "ops" : "alice", role }) }))
  return (await response.json() as { token: string }).token
}
async function call(master: Master, method: string, path: string, auth?: string, body?: unknown) {
  return master.fetch(new Request(`http://master${path}`, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }))
}

test("Master forwards prompt, control and SSE to the session Worker", async () => {
  const upstreamRequests: Array<{ path: string; body?: unknown }> = []
  const worker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
    const path = new URL(request.url).pathname
    upstreamRequests.push({ path, body: request.method === "GET" ? undefined : await request.json() })
    if (path.endsWith("/stream")) return new Response("id: 1\ndata: {\"type\":\"session.next.reasoning.delta\"}\n\n", { headers: { "content-type": "text/event-stream" } })
    if (path.endsWith("/history")) return Response.json({ messages: [{ id: "msg_1", role: "user", content: "persisted query" }] })
    return Response.json({ accepted: true }, { status: 202 })
  } })
  const master = new Master({ config, db: openDatabase(":memory:"), autoScheduler: false })
  const admin = await token(master)
  const registered = await call(master, "POST", "/api/v1/workers/register", admin, { id: "w1", address: `http://127.0.0.1:${worker.port}` })
  expect(registered.status).toBe(201)
  const workerToken = (await registered.json() as { token: string }).token
  const user = await token(master, "user")
  const created = await call(master, "POST", "/api/v1/sessions", user, { title: "direct" })
  const session = (await created.json() as { session: { id: string; workspaceId?: string; ownerWorkerId: string; leaseEpoch: number } }).session
  expect(session.ownerWorkerId).toBe("w1")
  const prompt = await call(master, "POST", `/api/v1/sessions/${session.id}/prompt`, user, { content: "hello" })
  expect(prompt.status).toBe(202)
  const turn = (await prompt.json() as { turn: { id: string } }).turn
  await call(master, "POST", "/api/v1/workers/w1/events", workerToken, { sessionID: session.id, turnID: turn.id, leaseEpoch: session.leaseEpoch ?? 1, sourceID: "w1:1", type: "worker.turn.message", data: { message: { id: "msg_1", role: "assistant", content: "persisted reply" } } })
  const history = await call(master, "GET", `/api/v1/sessions/${session.id}/messages`, user)
  expect(await history.json()).toEqual({ messages: [{ role: "user", content: "hello" }, { id: "msg_1", role: "assistant", content: "persisted reply" }] })
  expect((await call(master, "POST", `/api/v1/sessions/${session.id}/control`, user, { type: "question.reply", data: { interactionID: "q1", answer: { answers: ["yes"] } } })).status).toBe(202)
  expect((upstreamRequests[0]?.body as { workspaceID?: string }).workspaceID).toBe(session.workspaceId)
  const stream = await call(master, "GET", `/api/v1/sessions/${session.id}/events`, user)
  expect(stream.status).toBe(200)
  const reader = stream.body?.getReader()
  await reader?.read()
  const streamChunk = await reader?.read()
  await reader?.cancel()
  expect(new TextDecoder().decode(streamChunk?.value)).toContain("worker.turn.message")
  expect(upstreamRequests.map((entry) => entry.path)).toEqual([`/sessions/${session.id}/prompt`, `/sessions/${session.id}/control`])
  worker.stop(true)
})

test("Worker heartbeats require the registration-issued Worker token", async () => {
  const master = new Master({ config, db: openDatabase(":memory:"), autoScheduler: false })
  const admin = await token(master)
  const register = await call(master, "POST", "/api/v1/workers/register", admin, { id: "w1", address: "http://worker" })
  const workerToken = (await register.json() as { token: string }).token
  expect((await call(master, "POST", "/api/v1/workers/w1/heartbeat", workerToken, { load: { cpuPct: 0, memPct: 0, activeDrains: 0, pendingSteer: 0, pendingQueue: 0, toolProcesses: 0 } })).status).toBe(200)
  expect((await call(master, "POST", "/api/v1/workers/w1/heartbeat", admin, {})).status).toBe(401)
})
