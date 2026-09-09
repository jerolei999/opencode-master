/**
 * Master session directory. It stores ownership and access control only.
 * Prompts, questions, and OpenCode events remain on the owning Worker.
 */
import { and, desc, eq, ne } from "drizzle-orm"
import type { DB } from "../db/client"
import { sessions } from "../db/schema"
import type { SessionRow, WorkerView } from "../types"
import type { Config } from "../config"
import type { WorkerRegistry } from "./worker-registry"
import type { WorkspaceService } from "./workspace-service"
import { buildRing, candidates } from "../placement/consistent-hash"
import { pickLeastLoaded } from "../placement/load"
import { newID } from "../util"

export class QuotaExceededError extends Error {
  constructor(readonly userId: string, readonly max: number) { super(`user ${userId} exceeded max sessions: ${max}`) }
}
export class NoWorkerAvailableError extends Error { constructor() { super("no healthy worker available") } }
export class SessionNotFoundError extends Error { constructor(readonly sessionId: string) { super(`session not found: ${sessionId}`) } }
export type SessionAssignment = { session: SessionRow; worker: WorkerView }

export class SessionService {
  constructor(
    private db: DB,
    private registry: WorkerRegistry,
    private workspaceService: WorkspaceService,
    private cfg: Config,
    private now: () => number = Date.now,
  ) {}

  private toRow(row: typeof sessions.$inferSelect): SessionRow {
    return {
      id: row.id, userId: row.user_id, tenantId: row.tenant_id, title: row.title,
      workspaceId: row.workspace_id ?? undefined, directory: row.directory ?? undefined,
      status: row.status as SessionRow["status"], ownerWorkerId: row.owner_worker_id ?? undefined,
      leaseEpoch: row.lease_epoch,
      createdAt: row.created_at, updatedAt: row.updated_at, endedAt: row.ended_at ?? undefined,
    }
  }

  async getRow(sessionId: string): Promise<SessionRow | undefined> {
    const row = await this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
    return row ? this.toRow(row) : undefined
  }

  async place(userId: string, excludeWorkerId?: string): Promise<WorkerView | undefined> {
    const healthy = (await this.registry.healthyWorkers()).filter((worker) => worker.id !== excludeWorkerId)
    if (!healthy.length) return undefined
    const byId = new Map(healthy.map((worker) => [worker.id, worker]))
    const ring = buildRing(healthy.map((worker) => ({ id: worker.id })))
    const preferred = candidates(ring, userId, this.cfg.placementCandidates, (id) => byId.has(id))
    return pickLeastLoaded(preferred.map((id) => byId.get(id) as WorkerView)) ?? pickLeastLoaded(healthy)
  }

  async create(input: { tenantId: string; userId: string; title?: string; directory?: string }): Promise<SessionAssignment> {
    if (this.cfg.maxSessionsPerUser > 0) {
      const active = await this.db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.user_id, input.userId), ne(sessions.status, "ended"))).all()
      if (active.length >= this.cfg.maxSessionsPerUser) throw new QuotaExceededError(input.userId, this.cfg.maxSessionsPerUser)
    }
    const worker = await this.place(input.userId)
    if (!worker) throw new NoWorkerAvailableError()
    const workspace = await this.workspaceService.getOrCreate({ userId: input.userId, tenantId: input.tenantId, path: input.directory })
    const now = this.now()
    const id = newID("ses")
    await this.db.insert(sessions).values({
      id, user_id: input.userId, tenant_id: input.tenantId, title: input.title ?? "", workspace_id: workspace.id,
      directory: workspace.path, status: "assigned", owner_worker_id: worker.id, lease_epoch: 1, created_at: now, updated_at: now,
    })
    const session = await this.getRow(id)
    if (!session) throw new Error(`session missing after create: ${id}`)
    return { session, worker }
  }

  async get(sessionId: string): Promise<{ session: SessionRow; worker?: WorkerView } | undefined> {
    const session = await this.getRow(sessionId)
    if (!session) return undefined
    return { session, worker: session.ownerWorkerId ? await this.registry.get(session.ownerWorkerId) : undefined }
  }

  async list(input: { tenantId?: string; userId?: string; status?: SessionRow["status"] }): Promise<SessionRow[]> {
    const conditions = []
    if (input.tenantId) conditions.push(eq(sessions.tenant_id, input.tenantId))
    if (input.userId) conditions.push(eq(sessions.user_id, input.userId))
    if (input.status) conditions.push(eq(sessions.status, input.status))
    const where = conditions.length ? and(...conditions) : undefined
    const rows = where ? await this.db.select().from(sessions).where(where).orderBy(desc(sessions.updated_at)).all() : await this.db.select().from(sessions).orderBy(desc(sessions.updated_at)).all()
    return rows.map((row) => this.toRow(row))
  }

  async workerForPrompt(sessionId: string): Promise<WorkerView> {
    const session = await this.getRow(sessionId)
    if (!session) throw new SessionNotFoundError(sessionId)
    const owner = session.ownerWorkerId ? await this.registry.get(session.ownerWorkerId) : undefined
    if (owner?.status === "ok") return owner
    const worker = await this.place(session.userId, session.ownerWorkerId)
    if (!worker) throw new NoWorkerAvailableError()
    await this.db.update(sessions).set({ owner_worker_id: worker.id, lease_epoch: session.leaseEpoch + 1, status: "assigned", updated_at: this.now() }).where(eq(sessions.id, sessionId))
    return worker
  }

  /** Rehome sessions whose worker has just become unhealthy. Epoch fencing
   * makes every in-flight report from the old worker invalid immediately. */
  async rehomeWorkerSessions(workerId: string): Promise<string[]> {
    const rows = await this.db.select().from(sessions).where(and(eq(sessions.owner_worker_id, workerId), ne(sessions.status, "ended"))).all()
    const rehomed: string[] = []
    for (const row of rows) {
      const worker = await this.place(row.user_id, workerId)
      await this.db.update(sessions).set({ owner_worker_id: worker?.id ?? null, lease_epoch: row.lease_epoch + 1, status: "recovering", updated_at: this.now() }).where(eq(sessions.id, row.id))
      rehomed.push(row.id)
    }
    return rehomed
  }


  async updateTitle(sessionId: string, title: string): Promise<void> {
    await this.db.update(sessions).set({ title, updated_at: this.now() }).where(eq(sessions.id, sessionId))
  }

  async end(sessionId: string): Promise<void> {
    const now = this.now()
    await this.db.update(sessions).set({ status: "ended", ended_at: now, updated_at: now, owner_worker_id: null }).where(eq(sessions.id, sessionId))
  }
}
