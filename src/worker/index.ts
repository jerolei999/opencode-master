/**
 * Worker is the only process between Master and OpenCode. It owns OpenCode,
 * exposes a private HTTP/SSE proxy, and emits no Master-facing chunk events.
 */
import { OpenCodeExecutor } from "./opencode-executor"
import { SessionActor } from "./session-actor"
import { WorkerProxyServer } from "./proxy-server"
import { WorkerStreamHub } from "./stream-hub"
import { MasterEventReporter } from "./event-reporter"
import { MountedWorkspaceAdapter } from "../workspace/mounted-adapter"
import { WorkspaceRuntime } from "./workspace-runtime"
import { FileSessionSnapshotStore, OpenCodeSessionSnapshotter } from "./session-snapshot"
import type { WorkerEventEnvelope } from "../types"

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((out, value, index, all) => {
  if (value.startsWith("--")) out.push([value, all[index + 1] ?? ""])
  return out
}, [])) as Record<string, string>

const workerID = args["--id"] || "worker-1"
const port = Number(args["--port"] || 15100)
const openCodePort = Number(args["--opencode-port"] || 14100)
const masterURL = (args["--master"] || "http://127.0.0.1:4299").replace(/\/+$/, "")
const apiKey = args["--api-key"] || "dev-admin-key"
const credential = args["--credential"] || process.env["OPENCODE_WORKER_PROXY_CREDENTIAL"] || ""
const configuredCubeFSPath = args["--cubefs-mount"] || process.env["CUBEFS_MOUNT_PATH"]
const directory = configuredCubeFSPath || args["--workspace-dir"] || `${process.cwd()}/data/workers/${workerID}/workspace`
const dataDir = args["--data-dir"] || `${process.cwd()}/data/workers/${workerID}`
const snapshotDir = args["--snapshot-dir"] || `${directory}/.opencode-snapshots`

if (!credential) throw new Error("Worker proxy credential is required")

const snapshotter = args["--enable-opencode-snapshot"] === "true" || process.env["OPENCODE_ENABLE_SNAPSHOT"] === "1"
  ? new OpenCodeSessionSnapshotter({ binary: args["--opencode-bin"] || "opencode", dataDir, store: new FileSessionSnapshotStore(snapshotDir) })
  : undefined

const executor = new OpenCodeExecutor({
  slaveId: workerID,
  opencodeBin: args["--opencode-bin"] || "opencode",
  port: openCodePort,
  directory,
  dataDir,
  workspaceRoot: directory,
  ...(snapshotter ? { snapshotter } : {}),
})
const workspaceRuntime = new WorkspaceRuntime(new MountedWorkspaceAdapter({
  root: directory,
  requireExistingMount: Boolean(args["--require-cubefs-mount"] || configuredCubeFSPath),
}))
const hub = new WorkerStreamHub(workerID)
const actors = new SessionActor()
let reportEvent: (event: WorkerEventEnvelope) => Promise<void> = async () => {}

async function publish(sessionID: string, turnID: string, leaseEpoch: number, type: string, data: Record<string, unknown>): Promise<void> {
  const event = hub.publish(sessionID, type, data)
  await reportEvent({ sessionID, turnID, leaseEpoch, sourceID: `${workerID}:${event.id}`, type, data })
}

async function publishSnapshot(sessionID: string, turnID: string, leaseEpoch: number): Promise<void> {
  try {
    const snapshot = await executor.snapshot?.(sessionID)
    if (snapshot) await publish(sessionID, turnID, leaseEpoch, "worker.session.snapshot", { safePoint: snapshot.safePoint, exportedAt: snapshot.exportedAt })
  } catch (error) {
    await publish(sessionID, turnID, leaseEpoch, "worker.snapshot.error", { message: (error as Error).message })
  }
}

await workspaceRuntime.start()
await executor.start()
const proxy = new WorkerProxyServer({
  hub,
  authorize: (request) => request.headers.get("authorization") === `Bearer ${credential}`,
  prompt: async (input) => {
    void actors.enqueue(input.sessionID, async () => {
      const workspacePath = await workspaceRuntime.prepare(input.workspaceID ?? input.sessionID)
      const result = await executor.execute({
        sessionId: input.sessionID,
        turnID: input.turnID,
        leaseEpoch: input.leaseEpoch,
        prompt: input.content,
        promptSeq: 1,
        history: input.history,
        workspacePath,
        slaveId: workerID,
        onDelta: async ({ kind, delta }) => {
          await publish(input.sessionID, input.turnID, input.leaseEpoch, kind === "reasoning" ? "session.next.reasoning.delta" : "session.next.text.delta", { sessionID: input.sessionID, delta })
        },
      })
      if (result.interaction) await publish(input.sessionID, input.turnID, input.leaseEpoch, "worker.question.snapshot", result.interaction as unknown as Record<string, unknown>)
      for (const message of result.messages) await publish(input.sessionID, input.turnID, input.leaseEpoch, "worker.turn.message", message as unknown as Record<string, unknown>)
      await publishSnapshot(input.sessionID, input.turnID, input.leaseEpoch)
      await publish(input.sessionID, input.turnID, input.leaseEpoch, result.interaction ? "session.waiting_input" : "session.idle", {})
    }).catch((error) => void publish(input.sessionID, input.turnID, input.leaseEpoch, "worker.execution.error", { message: (error as Error).message }).catch((reportError) => console.error(`[worker ${workerID}] event report failed`, reportError)))
  },
  control: async (input) => {
    const sessionID = input.sessionID
    const request = input.request
    if (request.type !== "question.reply" || !executor.resume) return
    const interactionID = request.data["interactionID"]
    const answer = request.data["answer"]
    if (typeof interactionID !== "string" || !answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("question reply requires interactionID and answer")
    void actors.enqueue(sessionID, async () => {
      const workspacePath = await workspaceRuntime.prepare(input.workspaceID ?? sessionID)
      await publish(sessionID, input.turnID, input.leaseEpoch, "worker.question.resolved", { interactionID })
      const result = await executor.resume!({ sessionId: sessionID, workspacePath, turnID: input.turnID, leaseEpoch: input.leaseEpoch, interactionId: interactionID, answer: answer as Record<string, unknown>, onDelta: async ({ kind, delta }) => {
        await publish(sessionID, input.turnID, input.leaseEpoch, kind === "reasoning" ? "session.next.reasoning.delta" : "session.next.text.delta", { sessionID, delta })
      } })
      if (result.interaction) await publish(sessionID, input.turnID, input.leaseEpoch, "worker.question.snapshot", result.interaction as unknown as Record<string, unknown>)
      for (const message of result.messages) await publish(sessionID, input.turnID, input.leaseEpoch, "worker.turn.message", message as unknown as Record<string, unknown>)
      await publishSnapshot(sessionID, input.turnID, input.leaseEpoch)
      await publish(sessionID, input.turnID, input.leaseEpoch, result.interaction ? "session.waiting_input" : "session.idle", {})
    }).catch((error) => void publish(sessionID, input.turnID, input.leaseEpoch, "worker.execution.error", { message: (error as Error).message }).catch((reportError) => console.error(`[worker ${workerID}] event report failed`, reportError)))
  },
  history: (sessionID) => executor.history(sessionID),
})

Bun.serve({ port, hostname: "127.0.0.1", fetch: (request) => proxy.fetch(request) })
console.log(`[worker ${workerID}] proxy listening on 127.0.0.1:${port}`)

const tokenResponse = await fetch(`${masterURL}/api/v1/auth/token`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ apiKey, user: workerID }),
})
if (!tokenResponse.ok) throw new Error(`could not authenticate Worker: ${tokenResponse.status}`)
const adminToken = (await tokenResponse.json() as { token: string }).token
const registerResponse = await fetch(`${masterURL}/api/v1/workers/register`, {
  method: "POST",
  headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
  body: JSON.stringify({ id: workerID, address: `http://127.0.0.1:${port}`, version: "opencode-worker" }),
})
if (!registerResponse.ok) throw new Error(`could not register Worker: ${registerResponse.status}`)
const workerToken = (await registerResponse.json() as { token: string }).token
const eventReporter = new MasterEventReporter(masterURL, workerToken, workerID)
reportEvent = (event) => eventReporter.report(event)
setInterval(() => {
  void fetch(`${masterURL}/api/v1/workers/${workerID}/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ load: { cpuPct: 10, memPct: 15, activeDrains: 0, pendingSteer: 0, pendingQueue: 0, toolProcesses: 0 } }),
  }).catch((error) => console.error(`[worker ${workerID}] heartbeat failed:`, error))
}, 1_500)
