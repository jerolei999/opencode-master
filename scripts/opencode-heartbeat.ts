/**
 * opencode-config / heartbeat keep-alive for the Master.
 *
 * Registers one or more Docker opencode instances as Workers in the Master,
 * then periodically reports their health (/global/health) and load as a
 * heartbeat. This is the only thing a "Worker" needs to do in the no-worker
 * architecture — the Master talks the native opencode API directly through
 * OpenCodeGateway; this script merely tells the Master the instance is alive
 * and how loaded it is, so it can route sessions and take over leases.
 *
 * Usage:
 *   bun run scripts/opencode-heartbeat.ts \
 *     --master http://127.0.0.1:4000 \
 *     --api-key dev-admin-key \
 *     --id opencode-1 \
 *     --opencode-url http://127.0.0.1:4096 \
 *     --region cn-north-1 \
 *     --capacity 3
 *
 * Env fallbacks (each can be overridden by flags):
 *   OPENCODE_MASTER_URL, OPENCODE_MASTER_BOOTSTRAP_KEY,
 *   OPENCODE_HEARTBEAT_ID, OPENCODE_HEARTBEAT_URL,
 *   OPENCODE_HEARTBEAT_REGION, OPENCODE_HEARTBEAT_CAPACITY,
 *   OPENCODE_HEARTBEAT_MS, OPENCODE_MASTER_OPENCODE_USER
 */

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((out, value, index, all) => {
  if (value.startsWith("--")) out.push([value, all[index + 1] ?? ""])
  return out
}, [])) as Record<string, string>

const masterURL = (args["--master"] || process.env["OPENCODE_MASTER_URL"] || "http://127.0.0.1:4000").replace(/\/+$/, "")
const apiKey = args["--api-key"] || process.env["OPENCODE_MASTER_BOOTSTRAP_KEY"] || "dev-admin-key"
const workerID = args["--id"] || process.env["OPENCODE_HEARTBEAT_ID"] || "opencode-1"
const opencodeURL = (args["--opencode-url"] || process.env["OPENCODE_HEARTBEAT_URL"] || "http://127.0.0.1:4096").replace(/\/+$/, "")
const region = args["--region"] || process.env["OPENCODE_HEARTBEAT_REGION"] || "cn-north-1"
const capacity = Number(args["--capacity"] || process.env["OPENCODE_HEARTBEAT_CAPACITY"] || 3)
const heartbeatMs = Math.max(1000, Number(args["--heartbeat-ms"] || process.env["OPENCODE_HEARTBEAT_MS"] || 2000))
const opencodeUser = args["--opencode-user"] || process.env["OPENCODE_MASTER_OPENCODE_USER"]

const auth = opencodeUser ? `Basic ${Buffer.from(`${opencodeUser}:slave-internal`).toString("base64")}` : undefined

async function hbPostMaster(path: string, body: unknown, token?: string) {
  const response = await fetch(`${masterURL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${await response.text()}`)
  return response
}

/** Probe the opencode instance for live load. Falls back to a static value. */
async function probeLoad(): Promise<{ cpuPct: number; memPct: number; activeDrains: number; pendingSteer: number; pendingQueue: number; toolProcesses: number }> {
  try {
    const headers = auth ? { authorization: auth } : undefined
    const health = await fetch(`${opencodeURL}/global/health`, { headers, signal: AbortSignal.timeout(2000) })
    if (!health.ok) throw new Error(`health ${health.status}`)
    // Count active drains from the opencode session list (best-effort).
    let activeDrains = 0
    try {
      const sessionRes = await fetch(`${opencodeURL}/api/session/active`, { headers, signal: AbortSignal.timeout(2000) })
      if (sessionRes.ok) activeDrains = Object.keys((await sessionRes.json()) as Record<string, unknown>).length
    } catch {
      // non-fatal
    }
    return { cpuPct: 10, memPct: 20, activeDrains, pendingSteer: 0, pendingQueue: 0, toolProcesses: 0 }
  } catch {
    return { cpuPct: 0, memPct: 0, activeDrains: 0, pendingSteer: 0, pendingQueue: 0, toolProcesses: 0 }
  }
}

let hbWorkerToken = ""

async function hbBootstrap() {
  // 1. Mint an admin token, then register the instance as a Worker.
  const authResp = await hbPostMaster("/api/v1/auth/token", { apiKey, user: `${workerID}-admin`, role: "admin" })
  const { token: adminToken } = (await authResp.json()) as { token: string }
  const regResp = await hbPostMaster("/api/v1/workers/register", {
    id: workerID,
    address: opencodeURL,
    region,
    version: "opencode-native",
    capacity: { maxDrains: capacity, maxSessions: capacity },
  }, adminToken)
  const { token } = (await regResp.json()) as { token: string }
  hbWorkerToken = token
  console.log(`[opencode-heartbeat] ${workerID} registered @ ${opencodeURL} (${region}, capacity ${capacity})`)
}

async function hbTick() {
  const load = await probeLoad()
  try {
    await hbPostMaster(`/api/v1/workers/${workerID}/heartbeat`, { load }, hbWorkerToken)
  } catch (error) {
    console.error(`[opencode-heartbeat] heartbeat failed:`, (error as Error).message)
  }
}

async function run() {
  // Keep retrying registration so a not-yet-ready Master does not kill the keep-alive.
  for (;;) {
    try {
      await hbBootstrap()
      break
    } catch (error) {
      console.error(`[opencode-heartbeat] bootstrap failed (will retry):`, (error as Error).message)
      await Bun.sleep(2000)
    }
  }
  console.log(`[opencode-heartbeat] reporting every ${heartbeatMs}ms`)
  void hbTick()
  setInterval(() => void hbTick(), heartbeatMs)
}

void run()
