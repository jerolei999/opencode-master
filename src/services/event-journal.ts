import { and, asc, desc, eq, gt } from "drizzle-orm"
import type { DB } from "../db/client"
import { sessionEvents, turns } from "../db/schema"
import type { HistoryItem, MasterEvent } from "../types"
import { newID } from "../util"

type AppendInput = Omit<MasterEvent, "id" | "seq" | "sessionID" | "tenantID" | "turnID" | "workerID" | "leaseEpoch" | "sourceID" | "at"> & {
  sessionId: string; tenantId: string; turnId: string; workerId: string; leaseEpoch: number; sourceId: string
}

export class EventJournal {
  private subscribers = new Map<string, Set<(event: MasterEvent) => void>>()

  constructor(private db: DB, private now: () => number = Date.now) {}

  private toEvent(row: typeof sessionEvents.$inferSelect): MasterEvent {
    return { id: row.id, sessionID: row.session_id, tenantID: row.tenant_id, turnID: row.turn_id, workerID: row.worker_id, leaseEpoch: row.lease_epoch, seq: String(row.seq), sourceID: row.source_id, type: row.type, data: row.data, at: row.received_at }
  }

  async append(input: AppendInput): Promise<MasterEvent> {
    const existing = await this.db.select().from(sessionEvents).where(and(eq(sessionEvents.session_id, input.sessionId), eq(sessionEvents.source_id, input.sourceId))).get()
    if (existing) return this.toEvent(existing)
    const latest = await this.db.select({ seq: sessionEvents.seq }).from(sessionEvents).where(eq(sessionEvents.session_id, input.sessionId)).orderBy(desc(sessionEvents.seq)).get()
    const row = { id: newID("evt"), session_id: input.sessionId, tenant_id: input.tenantId, turn_id: input.turnId, worker_id: input.workerId, lease_epoch: input.leaseEpoch, seq: (latest?.seq ?? 0) + 1, source_id: input.sourceId, type: input.type, data: input.data, received_at: this.now() }
    await this.db.insert(sessionEvents).values(row)
    const event = this.toEvent(row)
    for (const subscriber of this.subscribers.get(input.sessionId) ?? []) subscriber(event)
    return event
  }

  async replay(sessionId: string, after?: string): Promise<MasterEvent[]> {
    const rows = await this.db.select().from(sessionEvents).where(after === undefined ? eq(sessionEvents.session_id, sessionId) : and(eq(sessionEvents.session_id, sessionId), gt(sessionEvents.seq, Number(after)))).orderBy(asc(sessionEvents.seq)).all()
    return rows.map((row) => this.toEvent(row))
  }

  subscribe(sessionId: string, listener: (event: MasterEvent) => void): () => void {
    const listeners = this.subscribers.get(sessionId) ?? new Set<(event: MasterEvent) => void>()
    listeners.add(listener)
    this.subscribers.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.subscribers.delete(sessionId)
    }
  }

  async history(sessionId: string): Promise<HistoryItem[]> {
    const promptRows = await this.db.select({ content: turns.content, createdAt: turns.created_at }).from(turns).where(eq(turns.session_id, sessionId)).orderBy(asc(turns.created_at)).all()
    const events = await this.replay(sessionId)
    const messageEvents = events.filter((event) => event.type === "worker.turn.message")
    const messages = messageEvents.map((event) => {
      const raw = (event.data.message ?? event.data) as Record<string, unknown>
      if (raw.role !== "assistant" && raw.role !== "tool" && raw.role !== "user") return undefined
      if (typeof raw.content !== "string") return undefined
      return { ...(typeof raw.id === "string" ? { id: raw.id } : {}), role: raw.role, content: raw.content, ...(typeof raw.name === "string" ? { name: raw.name } : {}), ...(typeof raw.reasoning === "string" ? { reasoning: raw.reasoning } : {}) } as HistoryItem
    }).filter((value): value is HistoryItem => Boolean(value))
    const out: Array<{ at: number; index: number; item: HistoryItem }> = []
    for (const row of promptRows) out.push({ at: row.createdAt, index: out.length, item: { role: "user", content: row.content } })
    for (const [index, message] of messages.entries()) out.push({ at: messageEvents[index]?.at ?? Number.MAX_SAFE_INTEGER, index: out.length, item: message })
    out.sort((a, b) => a.at - b.at || a.index - b.index)
    return out.map((entry) => entry.item)
  }
}
