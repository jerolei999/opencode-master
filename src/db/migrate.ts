import type { Database } from "bun:sqlite"

/** Thin-Master schema. Legacy Slave tables are deliberately never created or read. */
const DDL = [
  `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, email TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key_hash TEXT NOT NULL, label TEXT, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, address TEXT NOT NULL, region TEXT, version TEXT, config_version TEXT, status TEXT NOT NULL, capacity TEXT NOT NULL DEFAULT '{}', load TEXT NOT NULL DEFAULT '{"cpuPct":0,"memPct":0,"activeDrains":0,"pendingSteer":0,"pendingQueue":0,"toolProcesses":0}', last_heartbeat_at INTEGER, first_seen_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', workspace_id TEXT, directory TEXT, status TEXT NOT NULL DEFAULT 'pending', owner_worker_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER)`,
  `ALTER TABLE sessions ADD COLUMN workspace_id TEXT`,
  `ALTER TABLE sessions ADD COLUMN owner_worker_id TEXT`,
  `ALTER TABLE sessions ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 1`,
  `CREATE INDEX IF NOT EXISTS sessions_user_status ON sessions(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS sessions_tenant ON sessions(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS sessions_worker_owner ON sessions(owner_worker_id)`,
  `CREATE INDEX IF NOT EXISTS workspaces_user ON workspaces(user_id)`,
  `CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL, content TEXT NOT NULL, client_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', lease_epoch INTEGER NOT NULL, assigned_worker_id TEXT NOT NULL, error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS turns_session_client_key ON turns(session_id, client_key)`,
  `CREATE INDEX IF NOT EXISTS turns_session_status ON turns(session_id, status)`,
  `CREATE TABLE IF NOT EXISTS session_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tenant_id TEXT NOT NULL, turn_id TEXT NOT NULL, worker_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL, seq INTEGER NOT NULL, source_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, received_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS session_events_session_source ON session_events(session_id, source_id)`,
  `CREATE INDEX IF NOT EXISTS session_events_session_seq ON session_events(session_id, seq)`,
  `CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, recorded_at INTEGER NOT NULL)`,
]

export function migrate(sqlite: Database) {
  for (const ddl of DDL) {
    try { sqlite.run(ddl) } catch (error) {
      if (ddl.startsWith("ALTER TABLE")) continue
      throw error
    }
  }
}
