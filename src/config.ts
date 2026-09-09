/** Environment-driven configuration for the master coordinator. */
export type Config = {
  /** HTTP listen port. */
  port: number
  /** HTTP listen hostname. */
  host: string
  /** SQLite database path (":memory:" supported for tests). */
  dbPath: string
  /** HS256 JWT signing secret. */
  jwtSecret: string
  /** JWT lifetime in seconds. */
  jwtTTLSeconds: number
  /** A slave is considered dead after this many ms without a heartbeat. */
  heartbeatTimeoutMs: number
  /** Session lease TTL in ms; renewed on slave heartbeat. */
  leaseTTLMs: number
  /** Scheduler sweep interval in ms. */
  schedulerIntervalMs: number
  /** Bootstrap API key minting admin tokens (dev). */
  bootstrapApiKey: string
  /** Max concurrent non-ended sessions per user (0 = unlimited). */
  maxSessionsPerUser: number
  /** Number of candidate slaves considered per user (affinity ring). */
  placementCandidates: number
  /**
   * Command template used to spawn managed slaves from the admin API.
   * JSON array with {id}/{port}/{dir} placeholders, e.g.:
   * ["bun","run","/abs/src/slave/index.ts","--master","http://127.0.0.1:4097","--id","{id}","--opencode-port","{port}","--data-dir","{dir}","--config-repo","/abs/config-repo"]
   */
  slaveSpawnCmd?: string[]
  /** Credential Master presents to the private Worker proxy. */
  workerProxyCredential?: string
}

const num = (raw: string | undefined, fallback: number) => {
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const jwtSecret = env["OPENCODE_MASTER_JWT_SECRET"] ?? "dev-secret-change-me"
  if (jwtSecret === "dev-secret-change-me" && env["OPENCODE_MASTER_ENV"] !== "test") {
    console.warn("[opencode-master] WARNING: using default JWT secret; set OPENCODE_MASTER_JWT_SECRET in production")
  }
  return {
    port: num(env["OPENCODE_MASTER_PORT"], 4097),
    host: env["OPENCODE_MASTER_HOST"] ?? "0.0.0.0",
    dbPath: env["OPENCODE_MASTER_DB"] ?? "./data/master.db",
    jwtSecret,
    jwtTTLSeconds: num(env["OPENCODE_MASTER_JWT_TTL"], 8 * 60 * 60),
    heartbeatTimeoutMs: num(env["OPENCODE_MASTER_HEARTBEAT_TIMEOUT_MS"], 15_000),
    leaseTTLMs: num(env["OPENCODE_MASTER_LEASE_TTL_MS"], 60_000),
    schedulerIntervalMs: num(env["OPENCODE_MASTER_SCHEDULER_INTERVAL_MS"], 5_000),
    bootstrapApiKey: env["OPENCODE_MASTER_BOOTSTRAP_KEY"] ?? "dev-admin-key",
    // Unlimited by default. Set a positive value only when an installation
    // explicitly needs a per-user concurrent-session quota.
    maxSessionsPerUser: num(env["OPENCODE_MASTER_MAX_SESSIONS_PER_USER"], 0),
    placementCandidates: num(env["OPENCODE_MASTER_PLACEMENT_CANDIDATES"], 3),
    slaveSpawnCmd: env["OPENCODE_MASTER_SLAVE_SPAWN_CMD"]
      ? (JSON.parse(env["OPENCODE_MASTER_SLAVE_SPAWN_CMD"]) as string[])
      : undefined,
    workerProxyCredential: env["OPENCODE_WORKER_PROXY_CREDENTIAL"] ?? "dev-proxy-key",
  }
}
