import { and, desc, eq, inArray } from "drizzle-orm"
import type { DB } from "../db/client"
import { sessions, turns } from "../db/schema"
import type { TurnRow } from "../types"
import { newID } from "../util"

export class ActiveTurnError extends Error {
  constructor(readonly sessionId: string) { super(`session ${sessionId} already has an active turn`) }
}

export class StaleTurnLeaseError extends Error {
  constructor(readonly turnId: string) { super(`turn ${turnId} lease is stale`) }
}

export class TurnService {
  constructor(private db: DB, private now: () => number = Date.now) {}

  private toRow(row: typeof turns.$inferSelect): TurnRow {
    return {
      id: row.id, sessionId: row.session_id, userId: row.user_id, content: row.content,
      clientKey: row.client_key, status: row.status as TurnRow["status"], leaseEpoch: row.lease_epoch,
      assignedWorkerId: row.assigned_worker_id, ...(row.error_message ? { errorMessage: row.error_message } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at, ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    }
  }

  async get(id: string): Promise<TurnRow | undefined> {
    const row = await this.db.select().from(turns).where(eq(turns.id, id)).get()
    return row ? this.toRow(row) : undefined
  }

  async active(sessionId: string): Promise<TurnRow | undefined> {
    const row = await this.db.select().from(turns).where(and(eq(turns.session_id, sessionId), inArray(turns.status, ["pending", "leased"]))).orderBy(desc(turns.updated_at)).get()
    return row ? this.toRow(row) : undefined
  }

  async latest(sessionId: string): Promise<TurnRow | undefined> {
    const row = await this.db.select().from(turns).where(eq(turns.session_id, sessionId)).orderBy(desc(turns.created_at)).get()
    return row ? this.toRow(row) : undefined
  }

  async createOrGet(input: { sessionId: string; userId: string; content: string; clientKey?: string; workerId: string; leaseEpoch: number }): Promise<{ turn: TurnRow; created: boolean }> {
    const clientKey = input.clientKey?.trim() || `turn:${input.sessionId}:${this.now()}:${newID("key")}`
    const existing = await this.db.select().from(turns).where(and(eq(turns.session_id, input.sessionId), eq(turns.client_key, clientKey))).get()
    if (existing) return { turn: this.toRow(existing), created: false }
    const active = await this.db.select({ id: turns.id }).from(turns).where(and(eq(turns.session_id, input.sessionId), inArray(turns.status, ["pending", "leased"]))).get()
    if (active) throw new ActiveTurnError(input.sessionId)
    const now = this.now()
    const id = newID("turn")
    await this.db.insert(turns).values({
      id, session_id: input.sessionId, user_id: input.userId, content: input.content,
      client_key: clientKey, status: "pending", lease_epoch: input.leaseEpoch,
      assigned_worker_id: input.workerId, created_at: now, updated_at: now,
    })
    const row = await this.get(id)
    if (!row) throw new Error(`turn missing after create: ${id}`)
    return { turn: row, created: true }
  }

  async lease(id: string, workerId: string, leaseEpoch: number): Promise<boolean> {
    const current = await this.db.select({ id: turns.id }).from(turns).where(and(eq(turns.id, id), eq(turns.assigned_worker_id, workerId), eq(turns.lease_epoch, leaseEpoch), inArray(turns.status, ["pending", "leased"]))).get()
    if (!current) return false
    await this.db.update(turns).set({ status: "leased", updated_at: this.now() }).where(eq(turns.id, id)).run()
    return true
  }

  async complete(id: string, workerId: string, leaseEpoch: number): Promise<boolean> {
    const now = this.now()
    const current = await this.db.select({ id: turns.id }).from(turns).where(and(eq(turns.id, id), eq(turns.assigned_worker_id, workerId), eq(turns.lease_epoch, leaseEpoch), inArray(turns.status, ["pending", "leased"]))).get()
    if (!current) return false
    await this.db.update(turns).set({ status: "completed", updated_at: now, completed_at: now }).where(eq(turns.id, id)).run()
    return true
  }

  async completeOrThrow(id: string, workerId: string, leaseEpoch: number): Promise<void> {
    if (!await this.complete(id, workerId, leaseEpoch)) throw new StaleTurnLeaseError(id)
  }

  async fail(id: string, workerId: string, leaseEpoch: number, message: string): Promise<boolean> {
    const current = await this.db.select({ id: turns.id }).from(turns).where(and(eq(turns.id, id), eq(turns.assigned_worker_id, workerId), eq(turns.lease_epoch, leaseEpoch), inArray(turns.status, ["pending", "leased"]))).get()
    if (!current) return false
    await this.db.update(turns).set({ status: "failed", error_message: message, updated_at: this.now() }).where(eq(turns.id, id)).run()
    return true
  }

  async isCurrentLease(sessionId: string, workerId: string, leaseEpoch: number): Promise<boolean> {
    const row = await this.db.select({ owner: sessions.owner_worker_id, epoch: sessions.lease_epoch }).from(sessions).where(eq(sessions.id, sessionId)).get()
    return row?.owner === workerId && row.epoch === leaseEpoch
  }
}
