import { integer, real, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core"
import type { SessionStatus, TurnStatus, WorkerCapacity, WorkerLoad, WorkerStatus } from "../types"

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(), name: text("name").notNull(), created_at: integer("created_at").notNull(),
})
export const users = sqliteTable("users", {
  id: text("id").primaryKey(), tenant_id: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }), email: text("email"), created_at: integer("created_at").notNull(),
})
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(), user_id: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), key_hash: text("key_hash").notNull(), label: text("label"), revoked: integer("revoked", { mode: "boolean" }).notNull().default(false), created_at: integer("created_at").notNull(),
})
export const workers = sqliteTable("workers", {
  id: text("id").primaryKey(), address: text("address").notNull(), region: text("region"), version: text("version"), config_version: text("config_version"), status: text("status").$type<WorkerStatus>().notNull(),
  capacity: text("capacity", { mode: "json" }).$type<WorkerCapacity>().notNull().default({}),
  load: text("load", { mode: "json" }).$type<WorkerLoad>().notNull().default({ cpuPct: 0, memPct: 0, activeDrains: 0, pendingSteer: 0, pendingQueue: 0, toolProcesses: 0 }),
  last_heartbeat_at: integer("last_heartbeat_at"), first_seen_at: integer("first_seen_at").notNull(),
})
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(), user_id: text("user_id").notNull(), tenant_id: text("tenant_id").notNull(), path: text("path").notNull(), created_at: integer("created_at").notNull(), updated_at: integer("updated_at").notNull(),
})
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), user_id: text("user_id").notNull(), tenant_id: text("tenant_id").notNull(), title: text("title").notNull().default(""), workspace_id: text("workspace_id"), directory: text("directory"), status: text("status").$type<SessionStatus>().notNull().default("pending"), owner_worker_id: text("owner_worker_id"), lease_epoch: integer("lease_epoch").notNull().default(1), created_at: integer("created_at").notNull(), updated_at: integer("updated_at").notNull(), ended_at: integer("ended_at"),
})
export const turns = sqliteTable("turns", {
  id: text("id").primaryKey(), session_id: text("session_id").notNull(), user_id: text("user_id").notNull(), content: text("content").notNull(), client_key: text("client_key").notNull(), status: text("status").$type<TurnStatus>().notNull().default("pending"), lease_epoch: integer("lease_epoch").notNull(), assigned_worker_id: text("assigned_worker_id").notNull(), error_message: text("error_message"), created_at: integer("created_at").notNull(), updated_at: integer("updated_at").notNull(), completed_at: integer("completed_at"),
}, (table) => ({ sessionClientKey: uniqueIndex("turns_session_client_key").on(table.session_id, table.client_key) }))
export const sessionEvents = sqliteTable("session_events", {
  id: text("id").primaryKey(), session_id: text("session_id").notNull(), tenant_id: text("tenant_id").notNull(), turn_id: text("turn_id").notNull(), worker_id: text("worker_id").notNull(), lease_epoch: integer("lease_epoch").notNull(), seq: integer("seq").notNull(), source_id: text("source_id").notNull(), type: text("type").notNull(), data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(), received_at: integer("received_at").notNull(),
}, (table) => ({ sessionSource: uniqueIndex("session_events_session_source").on(table.session_id, table.source_id), sessionSeq: index("session_events_session_seq").on(table.session_id, table.seq) }))
export const usage = sqliteTable("usage", {
  id: text("id").primaryKey(), session_id: text("session_id").notNull(), tokens_in: integer("tokens_in").notNull().default(0), tokens_out: integer("tokens_out").notNull().default(0), cost: real("cost").notNull().default(0), recorded_at: integer("recorded_at").notNull(),
})
