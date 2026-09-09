import { expect, test } from "bun:test"
import { openDatabase } from "../src/db/client"
import { WorkerRegistry } from "../src/services/worker-registry"
import { SessionService } from "../src/services/session-service"
import { WorkspaceService } from "../src/services/workspace-service"
import { Master } from "../src/http/server"
import type { Config } from "../src/config"

const config: Config = { port: 0, host: "127.0.0.1", dbPath: ":memory:", jwtSecret: "test", jwtTTLSeconds: 3600, heartbeatTimeoutMs: 1000, leaseTTLMs: 1000, schedulerIntervalMs: 1000, bootstrapApiKey: "key", maxSessionsPerUser: 0, placementCandidates: 3, workerProxyCredential: "internal" }

test("rehome increments the lease epoch and changes the owner", async () => {
  const db = openDatabase(":memory:")
  const registry = new WorkerRegistry(db, () => 100)
  await registry.register({ id: "w1", address: "http://w1" })
  await registry.register({ id: "w2", address: "http://w2" })
  const sessions = new SessionService(db, registry, new WorkspaceService(db, () => 100), config, () => 100)
  const assignment = await sessions.create({ tenantId: "t1", userId: "u1" })
  const rehomed = await sessions.rehomeWorkerSessions(assignment.worker.id)
  const current = await sessions.get(assignment.session.id)

  expect(rehomed).toEqual([assignment.session.id])
  expect(current?.session.ownerWorkerId).not.toBe(assignment.worker.id)
  expect(current?.session.leaseEpoch).toBe(2)
})

test("master rejects an old worker event after rehome", async () => {
  const master = new Master({ config, db: openDatabase(":memory:"), autoScheduler: false })
  const adminResponse = await master.fetch(new Request("http://master/api/v1/auth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: "key", user: "ops", role: "admin" }) }))
  const admin = (await adminResponse.json() as { token: string }).token
  const register = async (id: string) => master.fetch(new Request("http://master/api/v1/workers/register", { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ id, address: `http://${id}` }) }))
  await register("w1")
  await register("w2")
  const userResponse = await master.fetch(new Request("http://master/api/v1/auth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: "key", user: "alice", role: "user" }) }))
  const user = (await userResponse.json() as { token: string }).token
  const created = await master.fetch(new Request("http://master/api/v1/sessions", { method: "POST", headers: { authorization: `Bearer ${user}`, "content-type": "application/json" }, body: JSON.stringify({}) }))
  const session = (await created.json() as { session: { id: string; ownerWorkerId: string; leaseEpoch: number } }).session
  const oldOwner = session.ownerWorkerId
  const oldWorkerToken = (await (await register(oldOwner)).json() as { token: string }).token
  const turn = await master.turns.createOrGet({ sessionId: session.id, userId: "alice", content: "hello", clientKey: "old", workerId: oldOwner, leaseEpoch: session.leaseEpoch })
  await master.sessions.rehomeWorkerSessions(oldOwner)
  const response = await master.fetch(new Request(`http://master/api/v1/workers/${oldOwner}/events`, { method: "POST", headers: { authorization: `Bearer ${oldWorkerToken}`, "content-type": "application/json" }, body: JSON.stringify({ sessionID: session.id, turnID: turn.turn.id, leaseEpoch: session.leaseEpoch, sourceID: `${oldOwner}:old`, type: "session.idle", data: {} }) }))
  expect(response.status).toBe(409)
})
