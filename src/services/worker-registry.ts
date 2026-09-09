/** Worker registry: register / heartbeat / status / liveness sweep. */

import { eq, sql } from "drizzle-orm"
import type { DB } from "../db/client"
import { workers } from "../db/schema"
import type { Instruction, WorkerCapacity, WorkerLoad, WorkerStatus, WorkerView } from "../types"

export const EMPTY_LOAD: WorkerLoad = {
  cpuPct: 0,
  memPct: 0,
  activeDrains: 0,
  pendingSteer: 0,
  pendingQueue: 0,
  toolProcesses: 0,
}

export class WorkerRegistry {
  private readonly pendingInstructions = new Map<string, Instruction[]>()

  constructor(
    private db: DB,
    private now: () => number = Date.now,
  ) {}

  enqueueInstruction(workerId: string, instruction: Instruction): void {
    const list = this.pendingInstructions.get(workerId) ?? []
    list.push(instruction)
    this.pendingInstructions.set(workerId, list)
  }

  private toView(row: typeof workers.$inferSelect): WorkerView {
    return {
      id: row.id,
      address: row.address,
      region: row.region ?? undefined,
      version: row.version ?? undefined,
      configVersion: row.config_version ?? undefined,
      status: row.status as WorkerStatus,
      load: row.load,
      capacity: row.capacity,
      lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
      firstSeenAt: row.first_seen_at,
    }
  }

  async register(input: {
    id: string
    address: string
    region?: string
    version?: string
    capacity?: WorkerCapacity
  }): Promise<WorkerView> {
    const now = this.now()
    const existing = await this.db.select().from(workers).where(eq(workers.id, input.id)).get()
    if (existing) {
      await this.db
        .update(workers)
        .set({
          address: input.address,
          region: input.region ?? existing.region,
          version: input.version ?? existing.version,
          capacity: input.capacity ?? existing.capacity,
          status: "ok",
          last_heartbeat_at: now,
        })
        .where(eq(workers.id, input.id))
    } else {
      await this.db.insert(workers).values({
        id: input.id,
        address: input.address,
        region: input.region ?? null,
        version: input.version ?? null,
        status: "ok",
        capacity: input.capacity ?? {},
        load: EMPTY_LOAD,
        last_heartbeat_at: now,
        first_seen_at: now,
      })
    }
    const view = await this.get(input.id)
    if (!view) throw new Error(`worker ${input.id} missing after register`)
    return view
  }

  async get(id: string): Promise<WorkerView | undefined> {
    const row = await this.db.select().from(workers).where(eq(workers.id, id)).get()
    return row ? this.toView(row) : undefined
  }

  async list(): Promise<WorkerView[]> {
    const rows = await this.db.select().from(workers).orderBy(workers.id).all()
    return rows.map((row) => this.toView(row))
  }

  /** Workers eligible for new placement: status ok (not draining, not unhealthy). */
  async healthyWorkers(): Promise<WorkerView[]> {
    const rows = await this.db.select().from(workers).where(eq(workers.status, "ok")).all()
    return rows.map((row) => this.toView(row))
  }

  async heartbeat(
    id: string,
    load: WorkerLoad,
    configVersion?: string,
  ): Promise<{ view: WorkerView; instructions: Instruction[] }> {
    const row = await this.db.select().from(workers).where(eq(workers.id, id)).get()
    if (!row) throw new HeartbeatUnknownWorkerError(id)
    const now = this.now()
    // A previously-unhealthy worker that heartbeats again self-heals.
    const status: WorkerStatus = row.status === "unhealthy" ? "ok" : (row.status as WorkerStatus)
    await this.db
      .update(workers)
      .set({ load, last_heartbeat_at: now, status, ...(configVersion ? { config_version: configVersion } : {}) })
      .where(eq(workers.id, id))
    const view = this.toView({ ...row, load, last_heartbeat_at: now, status, config_version: configVersion ?? row.config_version })
    const queued = this.pendingInstructions.get(id) ?? []
    this.pendingInstructions.delete(id)
    const instructions: Instruction[] = queued.length > 0
      ? queued
      : status === "draining" ? [{ type: "drain" }] : [{ type: "none" }]
    return { view, instructions }
  }

  async setStatus(id: string, status: WorkerStatus): Promise<WorkerView | undefined> {
    await this.db.update(workers).set({ status }).where(eq(workers.id, id))
    return this.get(id)
  }

  /**
   * Mark workers with a stale heartbeat as unhealthy; returns their IDs.
   * Design §M3/M4: heartbeat timeout → unhealthy → leases taken over.
   */
  async sweep(timeoutMs: number): Promise<string[]> {
    const cutoff = this.now() - timeoutMs
    const stale = await this.db
      .select()
      .from(workers)
      .where(sql`${workers.last_heartbeat_at} IS NULL OR ${workers.last_heartbeat_at} < ${cutoff}`)
      .all()
    const ids: string[] = []
    for (const row of stale) {
      if (row.status === "unhealthy") continue
      await this.db.update(workers).set({ status: "unhealthy" }).where(eq(workers.id, row.id))
      ids.push(row.id)
    }
    return ids
  }
}

export class HeartbeatUnknownWorkerError extends Error {
  constructor(readonly workerID: string) {
    super(`unknown worker: ${workerID}`)
  }
}
