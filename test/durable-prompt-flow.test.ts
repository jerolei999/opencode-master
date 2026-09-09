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

test("persists a prompt before dispatch and replays durable history after worker shutdown", async () => {
  let promptCalls = 0
  const promptBodies: unknown[] = []
  const worker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/prompt")) { promptCalls++; promptBodies.push(await request.json()); return Response.json({ accepted: true }, { status: 202 }) }
    return Response.json({ accepted: true }, { status: 202 })
  } })
  const worker2 = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith("/prompt")) { promptCalls++; promptBodies.push(await request.json()); return Response.json({ accepted: true }, { status: 202 }) }
    return Response.json({ accepted: true }, { status: 202 })
  } })
  const master = new Master({ config, db: openDatabase(":memory:"), autoScheduler: false })
  const admin = await token(master)
  const registered = await call(master, "POST", "/api/v1/workers/register", admin, { id: "w1", address: `http://127.0.0.1:${worker.port}` })
  const workerToken = (await registered.json() as { token: string }).token
  await call(master, "POST", "/api/v1/workers/register", admin, { id: "w2", address: `http://127.0.0.1:${worker2.port}` })
  const user = await token(master, "user")
  const created = await call(master, "POST", "/api/v1/sessions", user, { title: "durable" })
  const session = (await created.json() as { session: { id: string; leaseEpoch: number } }).session

  const first = await call(master, "POST", `/api/v1/sessions/${session.id}/prompt`, user, { content: "hello", idempotencyKey: "same-request" })
  const retry = await call(master, "POST", `/api/v1/sessions/${session.id}/prompt`, user, { content: "hello", idempotencyKey: "same-request" })
  expect(first.status).toBe(202)
  expect(retry.status).toBe(202)
  const firstBody = await first.json() as { turn: { id: string; status: string } }
  const secondBody = await retry.json() as { turn: { id: string } }
  expect(firstBody.turn.status).toBe("leased")
  expect(secondBody.turn.id).toBe(firstBody.turn.id)
  expect(promptCalls).toBe(1)

  const event = await call(master, "POST", "/api/v1/workers/w1/events", workerToken, { sessionID: session.id, turnID: firstBody.turn.id, leaseEpoch: session.leaseEpoch, sourceID: "w1:1", type: "worker.turn.message", data: { message: { id: "m1", role: "assistant", content: "world" } } })
  expect(event.status).toBe(202)
  await call(master, "POST", "/api/v1/workers/w1/events", workerToken, { sessionID: session.id, turnID: firstBody.turn.id, leaseEpoch: session.leaseEpoch, sourceID: "w1:2", type: "session.idle", data: {} })

  const history = await call(master, "GET", `/api/v1/sessions/${session.id}/messages`, user)
  expect(await history.json()).toEqual({ messages: [{ role: "user", content: "hello" }, { id: "m1", role: "assistant", content: "world" }] })
  await master.sessions.rehomeWorkerSessions("w1")
  const secondPrompt = await call(master, "POST", `/api/v1/sessions/${session.id}/prompt`, user, { content: "again", idempotencyKey: "second-request" })
  expect(secondPrompt.status).toBe(202)
  expect((promptBodies[1] as { history: unknown[] }).history).toEqual([{ role: "user", content: "hello" }, { id: "m1", role: "assistant", content: "world" }])
  const stream = await call(master, "GET", `/api/v1/sessions/${session.id}/events`, user)
  const reader = stream.body?.getReader()
  const connected = await reader?.read()
  const chunk = await reader?.read()
  await reader?.cancel()
  expect(new TextDecoder().decode(connected?.value)).toContain("connected")
  expect(new TextDecoder().decode(chunk?.value)).toContain("worker.turn.message")
  worker.stop(true)
  worker2.stop(true)
})
