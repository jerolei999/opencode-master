/** Thin Master: auth, placement, and transparent proxying to Workers. */
import type { Server } from "bun"
import { loadConfig, type Config } from "../config"
import { openDatabase, type DB } from "../db/client"
import { IdentityService } from "../services/identity"
import { WorkerRegistry, HeartbeatUnknownWorkerError, EMPTY_LOAD } from "../services/worker-registry"
import { SessionService, NoWorkerAvailableError, QuotaExceededError, SessionNotFoundError } from "../services/session-service"
import { WorkspaceService } from "../services/workspace-service"
import { ActiveTurnError, StaleTurnLeaseError, TurnService } from "../services/turn-service"
import { EventJournal } from "../services/event-journal"
import { Scheduler, type SchedulerReport } from "../services/scheduler"
import type { AuthContext, WorkerLoad, HistoryItem, TurnRow } from "../types"
import { Router } from "./router"
import { apiError, json, readJson } from "./helpers"
import { webAppHtml } from "./web-console"
import { OpenCodeGateway } from "../services/opencode-gateway"
export type MasterOptions = { config?: Config; db?: DB; now?: () => number; autoScheduler?: boolean }

export class Master {
  readonly config: Config
  readonly db: DB
  readonly now: () => number
  readonly identity: IdentityService
  readonly registry: WorkerRegistry
  readonly workspace: WorkspaceService
  readonly sessions: SessionService
  readonly turns: TurnService
  readonly events: EventJournal
  readonly scheduler: Scheduler
  private router = new Router()
  private stopScheduler?: () => void
  private server?: Server<Record<string, never>>
  /** Optional direct bridge to a native opencode instance (no Worker layer). */
  private gateway?: OpenCodeGateway

  constructor(opts: MasterOptions = {}) {
    this.config = opts.config ?? loadConfig()
    this.now = opts.now ?? Date.now
    this.db = opts.db ?? openDatabase(this.config.dbPath)
    this.identity = new IdentityService(this.db, this.config.jwtSecret, this.config.jwtTTLSeconds, this.now)
    this.registry = new WorkerRegistry(this.db, this.now)
    this.workspace = new WorkspaceService(this.db, this.now)
    this.sessions = new SessionService(this.db, this.registry, this.workspace, this.config, this.now)
    this.turns = new TurnService(this.db, this.now)
    this.events = new EventJournal(this.db, this.now)
    this.scheduler = new Scheduler(this.registry, this.config, this.sessions)
    if (this.config.opencodeBaseUrl) {
      this.gateway = new OpenCodeGateway({ baseUrl: this.config.opencodeBaseUrl, username: this.config.opencodeUser, model: this.config.opencodeModel, workspaceRoot: this.config.opencodeWorkspaceRoot })
    }
    this.buildRoutes()
    if (opts.autoScheduler ?? true) this.stopScheduler = this.scheduler.start()
  }

  private async authenticate(req: Request): Promise<AuthContext | null> {
    const header = req.headers.get("authorization")
    if (!header) return null
    const [scheme, token] = header.split(" ")
    if (scheme !== "Bearer" || !token) return null
    if (token.startsWith("omk_")) {
      const owner = await this.identity.userForApiKey(token)
      return owner ? { sub: owner.user, tenant: owner.tenant, role: "user" } : null
    }
    return this.identity.verifyToken(token)
  }

  private async guard(req: Request, roles: AuthContext["role"][], handler: (auth: AuthContext) => Promise<Response> | Response): Promise<Response> {
    const auth = await this.authenticate(req)
    if (!auth || !roles.includes(auth.role)) return apiError(401, "UNAUTHORIZED", "missing or invalid credentials")
    try { return await handler(auth) } catch (error) { return this.mapError(error) }
  }
  private admin(req: Request, fn: (auth: AuthContext) => Promise<Response> | Response) { return this.guard(req, ["admin"], fn) }
  private user(req: Request, fn: (auth: AuthContext) => Promise<Response> | Response) { return this.guard(req, ["user", "admin"], fn) }
  private worker(req: Request, id: string, fn: () => Promise<Response> | Response) {
    return this.guard(req, ["worker"], (auth) => auth.sub === id ? fn() : apiError(403, "FORBIDDEN", "worker token does not match worker id"))
  }
  private async ownedSession(auth: AuthContext, sessionId: string) {
    const got = await this.sessions.get(sessionId)
    if (!got) return { error: apiError(404, "SESSION_NOT_FOUND", `session not found: ${sessionId}`) }
    if (auth.role === "user" && got.session.userId !== auth.sub) return { error: apiError(403, "FORBIDDEN", "not your session") }
    return { got }
  }
  private mapError(error: unknown): Response {
    if (error instanceof QuotaExceededError) return apiError(429, "QUOTA_EXCEEDED", error.message)
    if (error instanceof NoWorkerAvailableError) return apiError(503, "NO_WORKER_AVAILABLE", error.message)
    if (error instanceof SessionNotFoundError) return apiError(404, "SESSION_NOT_FOUND", error.message)
    if (error instanceof HeartbeatUnknownWorkerError) return apiError(404, "WORKER_NOT_FOUND", error.message)
    if (error instanceof ActiveTurnError) return apiError(409, "ACTIVE_TURN", error.message)
    if (error instanceof StaleTurnLeaseError) return apiError(409, "STALE_TURN_LEASE", error.message)
    if (error instanceof SyntaxError) return apiError(400, "BAD_REQUEST", "invalid JSON body")
    console.error("[opencode-master] internal error", error)
    return apiError(500, "INTERNAL", "internal server error")
  }

  private buildRoutes(): void {
    this.router.add("GET", "/healthz", () => json({ ok: true, service: "opencode-master" }))
    this.router.add("GET", "/", () => new Response(webAppHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }))
    this.router.add("POST", "/api/v1/auth/token", (req) => this.handleToken(req))
    this.router.add("POST", "/api/v1/workers/register", (req) => this.admin(req, (auth) => this.registerWorker(req, auth)))
    this.router.add("POST", "/api/v1/workers/:id/heartbeat", (req, p) => this.worker(req, p["id"] as string, () => this.heartbeat(req, p["id"] as string)))
    this.router.add("POST", "/api/v1/workers/:id/events", (req, p) => this.worker(req, p["id"] as string, () => this.ingestWorkerEvent(req, p["id"] as string)))
    this.router.add("GET", "/api/v1/admin/workers", (req) => this.admin(req, () => this.listWorkers()))
    this.router.add("GET", "/api/v1/admin/sessions", (req) => this.admin(req, () => this.listAllSessions()))
    this.router.add("POST", "/api/v1/admin/sweep", (req) => this.admin(req, () => this.sweep()))
    this.router.add("POST", "/api/v1/sessions", (req) => this.user(req, (auth) => this.createSession(req, auth)))
    this.router.add("GET", "/api/v1/sessions", (req) => this.user(req, (auth) => this.listSessions(req, auth)))
    this.router.add("GET", "/api/v1/sessions/:id", (req, p) => this.user(req, (auth) => this.getSession(p["id"] as string, auth)))
    this.router.add("GET", "/api/v1/sessions/:id/messages", (req, p) => this.user(req, (auth) => this.messages(p["id"] as string, auth)))
    this.router.add("POST", "/api/v1/sessions/:id/prompt", (req, p) => this.user(req, (auth) => this.prompt(req, p["id"] as string, auth)))
    this.router.add("POST", "/api/v1/sessions/:id/control", (req, p) => this.user(req, (auth) => this.control(req, p["id"] as string, auth)))
    this.router.add("POST", "/api/v1/sessions/:id/end", (req, p) => this.user(req, (auth) => this.end(p["id"] as string, auth)))
    this.router.add("POST", "/api/v1/sessions/:id/stop", (req, p) => this.user(req, (auth) => this.end(p["id"] as string, auth)))
    this.router.add("GET", "/api/v1/sessions/:id/events", (req, p) => this.user(req, (auth) => this.stream(req, p["id"] as string, auth)))
    this.router.add("GET", "/api/v1/status", (req) => this.user(req, () => this.status()))
    this.router.add("GET", "/api/v1/nodes", (req) => this.user(req, () => this.nodes()))
    this.router.add("POST", "/api/v1/auth/apikeys", (req) => this.user(req, (auth) => this.createApiKey(req, auth)))
    this.router.add("GET", "/api/v1/auth/me", (req) => this.user(req, (auth) => json({ user: auth.sub, tenant: auth.tenant, role: auth.role })))
    this.router.add("PATCH", "/api/v1/sessions/:id", (req, p) => this.user(req, (auth) => this.renameSession(req, p["id"] as string, auth)))
    this.router.add("DELETE", "/api/v1/sessions/:id", (req, p) => this.user(req, (auth) => this.end(p["id"] as string, auth)))
    this.router.add("POST", "/api/v1/schedules/trigger", (req) => this.handleScheduleTrigger(req))
    this.router.add("GET", "/api/v1/sessions/:id/status", (req, p) => this.user(req, (auth) => this.sessionStatus(p["id"] as string, auth)))
  }

  private async handleToken(req: Request): Promise<Response> {
    const body = await readJson<{ apiKey?: string; tenant?: string; user?: string; role?: string; email?: string }>(req)
    if (!body.apiKey) return apiError(400, "BAD_REQUEST", "apiKey required")
    if (body.apiKey === this.config.bootstrapApiKey) {
      const tenant = body.tenant ?? "default", user = body.user ?? "admin"
      const role = body.role === "worker" ? "worker" : body.role === "user" ? "user" : "admin"
      await this.identity.ensureUser(tenant, user, body.email)
      return json({ token: await this.identity.issueToken({ sub: user, tenant, role }), role, sub: user, tenant })
    }
    const owner = await this.identity.userForApiKey(body.apiKey)
    if (!owner) return apiError(401, "UNAUTHORIZED", "invalid api key")
    return json({ token: await this.identity.issueToken({ sub: owner.user, tenant: owner.tenant, role: "user" }), role: "user", sub: owner.user, tenant: owner.tenant })
  }
  private async createApiKey(req: Request, auth: AuthContext) {
    if (auth.role !== "user") return apiError(403, "FORBIDDEN", "only users can create API keys")
    const body = await readJson<{ label?: string }>(req)
    return json({ apiKey: await this.identity.createApiKey(auth.sub, body.label) }, 201)
  }
  private async registerWorker(req: Request, auth: AuthContext) {
    const body = await readJson<{ id?: string; address?: string; region?: string; version?: string; capacity?: { maxDrains?: number; maxSessions?: number } }>(req)
    if (!body.id || !body.address) return apiError(400, "BAD_REQUEST", "id and address required")
    const worker = await this.registry.register({ id: body.id, address: body.address, region: body.region, version: body.version, capacity: body.capacity })
    return json({ worker, token: await this.identity.issueToken({ sub: body.id, tenant: auth.tenant, role: "worker" }) }, 201)
  }
  private async heartbeat(req: Request, id: string) {
    const body = await readJson<{ load?: WorkerLoad; configVersion?: string }>(req)
    const { view } = await this.registry.heartbeat(id, body.load ?? EMPTY_LOAD, body.configVersion)
    return json({ status: view.status })
  }
  private async listWorkers() { return json({ workers: await this.registry.list() }) }
  private async listAllSessions() { return json({ sessions: await this.sessions.list({}) }) }
  private async sweep() { return json(await this.scheduler.runOnce() satisfies SchedulerReport) }
  private async createSession(req: Request, auth: AuthContext) {
    const body = await readJson<{ title?: string; directory?: string }>(req)
    return json(await this.sessions.create({ tenantId: auth.tenant, userId: auth.sub, title: body.title, directory: body.directory }), 201)
  }
  private async listSessions(req: Request, auth: AuthContext) {
    const userId = new URL(req.url).searchParams.get("user")
    if (userId && auth.role !== "admin") return apiError(403, "FORBIDDEN", "only admins may filter by user")
    return json({ sessions: await this.sessions.list({ userId: userId ?? auth.sub }) })
  }
  private async getSession(id: string, auth: AuthContext) { const result = await this.ownedSession(auth, id); return result.error ?? json({ session: result.got?.session }) }
  private async messages(id: string, auth: AuthContext) {
    const owned = await this.ownedSession(auth, id)
    if (owned.error) return owned.error
    return json({ messages: await this.events.history(id) })
  }
  private async proxy(workerAddress: string, path: string, init: RequestInit): Promise<Response> {
    const credential = this.config.workerProxyCredential
    if (!credential) return apiError(503, "WORKER_UNAVAILABLE", "worker proxy credential is not configured")
    try {
      return await fetch(`${workerAddress.replace(/\/+$/, "")}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${credential}` } })
    } catch { return apiError(502, "WORKER_UNREACHABLE", "worker proxy is unreachable") }
  }
  private async prompt(req: Request, id: string, auth: AuthContext) {
    const owned = await this.ownedSession(auth, id); if (owned.error) return owned.error
    const body = await readJson<{ content?: string; idempotencyKey?: string }>(req); if (!body.content?.trim()) return apiError(400, "BAD_REQUEST", "content required")
    const worker = await this.sessions.workerForPrompt(id)
    const session = (await this.sessions.get(id))?.session
    if (!session) return apiError(404, "SESSION_NOT_FOUND", `session not found: ${id}`)
    const priorHistory = await this.events.history(id)
    const admitted = await this.turns.createOrGet({ sessionId: id, userId: auth.sub, content: body.content, clientKey: body.idempotencyKey, workerId: worker.id, leaseEpoch: session.leaseEpoch })
    if (!admitted.created) return json({ accepted: true, stream: `/api/v1/sessions/${id}/events`, turn: admitted.turn }, 202)
    if (!await this.turns.lease(admitted.turn.id, worker.id, session.leaseEpoch)) throw new StaleTurnLeaseError(admitted.turn.id)
    if (this.gateway) {
      void this.runGatewayPrompt({ sessionId: id, userId: auth.sub, directory: session.directory ?? session.workspaceId ?? id, turn: admitted.turn, workerId: worker.id, leaseEpoch: session.leaseEpoch, content: body.content, history: priorHistory })
      const turn = await this.turns.get(admitted.turn.id)
      return json({ accepted: true, stream: `/api/v1/sessions/${id}/events`, turn }, 202)
    }
    const response = await this.proxy(worker.address, `/sessions/${id}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: body.content, workspaceID: session.workspaceId ?? id, turnID: admitted.turn.id, leaseEpoch: session.leaseEpoch, history: priorHistory }) })
    if (!response.ok) { await this.turns.fail(admitted.turn.id, worker.id, session.leaseEpoch, `worker returned ${response.status}`); return apiError(502, "WORKER_PROMPT_FAILED", `worker returned ${response.status}`) }
    const turn = await this.turns.get(admitted.turn.id)
    return json({ accepted: true, stream: `/api/v1/sessions/${id}/events`, turn }, 202)
  }

  private async runGatewayPrompt(input: {
    sessionId: string
    userId: string
    directory: string
    turn: TurnRow
    workerId: string
    leaseEpoch: number
    content: string
    history: HistoryItem[]
  }): Promise<void> {
    if (!this.gateway) return
    const { sessionId, userId, turn, workerId, leaseEpoch } = input
    const emit = async (type: string, data: Record<string, unknown>) => {
      await this.events.append({ sessionId, tenantId: userId, turnId: turn.id, workerId, leaseEpoch, sourceId: `${workerId}:${type}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, type, data })
    }
    const onDelta = async ({ kind, delta }: { kind: "text" | "reasoning"; delta: string }) => {
      await emit(kind === "reasoning" ? "session.next.reasoning.delta" : "session.next.text.delta", { sessionID: sessionId, delta })
    }
    try {
      const result = await this.gateway.prompt({
        sessionId,
        directory: input.directory,
        content: input.content,
        history: input.history,
        onDelta,
      })
      if (result.interaction) {
        await emit("worker.question.snapshot", result.interaction as unknown as Record<string, unknown>)
        for (const message of result.messages) await emit("worker.turn.message", message as unknown as Record<string, unknown>)
        await emit("session.waiting_input", {})
      } else {
        for (const message of result.messages) await emit("worker.turn.message", message as unknown as Record<string, unknown>)
        await this.turns.complete(turn.id, workerId, leaseEpoch)
        await emit("session.idle", {})
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.turns.fail(turn.id, workerId, leaseEpoch, message)
      await emit("worker.execution.error", { message })
    }
  }

  private async runGatewayResume(input: {
    sessionId: string
    directory: string
    turn: TurnRow
    workerId: string
    leaseEpoch: number
    interactionId: string
    answer: Record<string, unknown>
  }): Promise<void> {
    if (!this.gateway) return
    const { sessionId, turn, workerId, leaseEpoch } = input
    const emit = async (type: string, data: Record<string, unknown>) => {
      await this.events.append({ sessionId, tenantId: turn.userId, turnId: turn.id, workerId, leaseEpoch, sourceId: `${workerId}:${type}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, type, data })
    }
    const onDelta = async ({ kind, delta }: { kind: "text" | "reasoning"; delta: string }) => {
      await emit(kind === "reasoning" ? "session.next.reasoning.delta" : "session.next.text.delta", { sessionID: sessionId, delta })
    }
    try {
      await emit("worker.question.resolved", { interactionID: input.interactionId })
      const result = await this.gateway.resume({
        sessionId,
        directory: input.directory,
        interactionId: input.interactionId,
        answer: input.answer,
        onDelta,
      })
      if (result.interaction) {
        await emit("worker.question.snapshot", result.interaction as unknown as Record<string, unknown>)
        for (const message of result.messages) await emit("worker.turn.message", message as unknown as Record<string, unknown>)
        await emit("session.waiting_input", {})
      } else {
        for (const message of result.messages) await emit("worker.turn.message", message as unknown as Record<string, unknown>)
        await this.turns.complete(turn.id, workerId, leaseEpoch)
        await emit("session.idle", {})
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.turns.fail(turn.id, workerId, leaseEpoch, message)
      await emit("worker.execution.error", { message })
    }
  }

  private async ingestWorkerEvent(req: Request, workerId: string) {
    const body = await readJson<{ sessionID?: string; turnID?: string; leaseEpoch?: number; sourceID?: string; type?: string; data?: Record<string, unknown> }>(req)
    if (!body.sessionID || !body.turnID || typeof body.leaseEpoch !== "number" || !body.sourceID || !body.type || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) return apiError(400, "BAD_REQUEST", "sessionID, turnID, leaseEpoch, sourceID, type and data are required")
    const turn = await this.turns.get(body.turnID)
    if (!turn || turn.sessionId !== body.sessionID || turn.assignedWorkerId !== workerId || turn.leaseEpoch !== body.leaseEpoch || !await this.turns.isCurrentLease(body.sessionID, workerId, body.leaseEpoch)) return apiError(409, "STALE_LEASE", "worker lease is no longer current")
    const session = (await this.sessions.get(body.sessionID))?.session
    if (!session) return apiError(404, "SESSION_NOT_FOUND", `session not found: ${body.sessionID}`)
    const event = await this.events.append({ sessionId: body.sessionID, tenantId: session.tenantId, turnId: body.turnID, workerId, leaseEpoch: body.leaseEpoch, sourceId: body.sourceID, type: body.type, data: body.data })
    if (body.type === "session.idle") await this.turns.complete(body.turnID, workerId, body.leaseEpoch)
    if (body.type === "worker.execution.error") await this.turns.fail(body.turnID, workerId, body.leaseEpoch, typeof body.data.message === "string" ? body.data.message : "worker execution failed")
    return json({ accepted: true, event }, 202)
  }
  private async control(req: Request, id: string, auth: AuthContext) {
    const owned = await this.ownedSession(auth, id); if (owned.error) return owned.error
    const worker = owned.got?.worker; if (!worker || worker.status !== "ok") return apiError(503, "WORKER_UNAVAILABLE", "session worker is unavailable")
    const body = await readJson<Record<string, unknown>>(req)
    const turn = await this.turns.active(id)
    if (!turn || turn.assignedWorkerId !== worker.id || !await this.turns.isCurrentLease(id, worker.id, turn.leaseEpoch)) return apiError(409, "STALE_TURN_LEASE", "no active turn for the current worker lease")
    const session = (await this.sessions.get(id))?.session
    if (this.gateway && body.type === "question.reply") {
      const data = body.data as Record<string, unknown> | undefined
      const interactionID = typeof data?.interactionID === "string" ? data.interactionID : undefined
      const answer = data?.answer
      if (!interactionID || !answer || typeof answer !== "object" || Array.isArray(answer)) return apiError(400, "BAD_REQUEST", "question.reply requires interactionID and answer")
      void this.runGatewayResume({ sessionId: id, directory: session?.directory ?? session?.workspaceId ?? id, turn, workerId: worker.id, leaseEpoch: turn.leaseEpoch, interactionId: interactionID, answer: answer as Record<string, unknown> })
      return json({ accepted: true }, 202)
    }
    const response = await this.proxy(worker.address, `/sessions/${id}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, workspaceID: session?.workspaceId ?? id, turnID: turn.id, leaseEpoch: turn.leaseEpoch }) })
    if (!response.ok) return apiError(502, "WORKER_CONTROL_FAILED", `worker returned ${response.status}`)
    return json({ accepted: true }, 202)
  }
  private async end(id: string, auth: AuthContext) { const owned = await this.ownedSession(auth, id); if (owned.error) return owned.error; await this.sessions.end(id); await this.gateway?.abort(id); return json({ ok: true }) }
  private async renameSession(req: Request, id: string, auth: AuthContext) {
    const owned = await this.ownedSession(auth, id)
    if (owned.error) return owned.error
    const body = await readJson<{ title?: string }>(req)
    if (!body.title?.trim()) return apiError(400, "BAD_REQUEST", "title required")
    await this.sessions.updateTitle(id, body.title.trim())
    const updated = (await this.sessions.get(id))?.session
    return json({ ok: true, session: updated })
  }
  private async handleScheduleTrigger(req: Request): Promise<Response> {
    const auth = await this.authenticate(req)
    const body = await readJson<{
      userId?: string
      tenantId?: string
      taskName?: string
      prompt?: string
      webhookUrl?: string
    }>(req)
    if (!body.taskName?.trim() || !body.prompt?.trim()) {
      return apiError(400, "BAD_REQUEST", "taskName and prompt are required")
    }
    let userId = body.userId?.trim()
    let tenantId = body.tenantId?.trim() || "default"
    if (auth) {
      if (auth.role === "user") {
        userId = auth.sub
        tenantId = auth.tenant
      } else if (auth.role === "admin" && !userId) {
        userId = auth.sub
      }
    }
    if (!userId) {
      return apiError(400, "BAD_REQUEST", "userId required for scheduled trigger")
    }
    await this.identity.ensureUser(tenantId, userId)
    const title = `⏰ 定时任务 · ${body.taskName.trim()}`
    const created = await this.sessions.create({
      tenantId,
      userId,
      title,
      directory: `/workspace/${userId}`,
    })
    const sessionId = created.session.id
    const worker = await this.sessions.workerForPrompt(sessionId)
    const session = (await this.sessions.get(sessionId))?.session
    if (!session) return apiError(500, "INTERNAL", `failed to load session: ${sessionId}`)
    const clientKey = `sched_${body.taskName.trim()}_${Date.now()}`
    const admitted = await this.turns.createOrGet({
      sessionId,
      userId,
      content: body.prompt.trim(),
      clientKey,
      workerId: worker.id,
      leaseEpoch: session.leaseEpoch,
    })
    if (!await this.turns.lease(admitted.turn.id, worker.id, session.leaseEpoch)) {
      throw new StaleTurnLeaseError(admitted.turn.id)
    }
    if (this.gateway) {
      void this.runGatewayPrompt({ sessionId, userId, directory: session.directory ?? session.workspaceId ?? sessionId, turn: admitted.turn, workerId: worker.id, leaseEpoch: session.leaseEpoch, content: body.prompt.trim(), history: [] })
      return json({ accepted: true, sessionId, turn: admitted.turn, workerId: worker.id, stream: `/api/v1/sessions/${sessionId}/events` }, 202)
    }
    const response = await this.proxy(worker.address, `/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: body.prompt.trim(),
        workspaceID: session.workspaceId ?? sessionId,
        turnID: admitted.turn.id,
        leaseEpoch: session.leaseEpoch,
        history: [],
      }),
    })
    if (!response.ok) {
      await this.turns.fail(admitted.turn.id, worker.id, session.leaseEpoch, `worker returned ${response.status}`)
      return apiError(502, "WORKER_PROMPT_FAILED", `worker returned ${response.status}`)
    }
    const turn = await this.turns.get(admitted.turn.id)
    return json({
      accepted: true,
      sessionId,
      turn,
      workerId: worker.id,
      stream: `/api/v1/sessions/${sessionId}/events`,
    }, 202)
  }
  private async sessionStatus(id: string, auth: AuthContext) {
    const owned = await this.ownedSession(auth, id)
    if (owned.error) return owned.error
    const s = owned.got.session
    const activeTurn = await this.turns.active(id)
    const latestTurn = await this.turns.latest(id)
    let execStatus: "running" | "idle" | "error" | "ended" | "assigned" = "idle"
    if (s.status === "ended") {
      execStatus = "ended"
    } else if (activeTurn) {
      execStatus = "running"
    } else if (latestTurn?.status === "failed") {
      execStatus = "error"
    } else if (latestTurn?.status === "completed") {
      execStatus = "idle"
    } else {
      execStatus = (s.status as any) || "assigned"
    }
    return json({
      id: s.id,
      userId: s.userId,
      title: s.title,
      status: execStatus,
      rawStatus: s.status,
      activeTurn: activeTurn ? { id: activeTurn.id, status: activeTurn.status } : null,
      latestTurn: latestTurn ? { id: latestTurn.id, status: latestTurn.status, errorMessage: latestTurn.errorMessage } : null,
      ownerWorkerId: s.ownerWorkerId,
      updatedAt: s.updatedAt,
    })
  }
  private async stream(req: Request, id: string, auth: AuthContext) {
    const owned = await this.ownedSession(auth, id); if (owned.error) return owned.error
    const after = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after") ?? undefined
    let unsubscribe: (() => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder()
        const sent = new Set<string>()
        const send = (event: unknown) => {
          const id = (event as { id: string }).id
          if (sent.has(id)) return
          sent.add(id)
          controller.enqueue(encoder.encode(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`))
        }
        controller.enqueue(encoder.encode(": connected\n\n"))
        unsubscribe = this.events.subscribe(id, send)
        void this.events.replay(id, after).then((events) => events.forEach(send)).catch(() => controller.error(new Error("event replay failed")))
      },
      cancel: () => unsubscribe?.(),
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })
  }
  private async status() { const available = (await this.registry.healthyWorkers()).length; return json({ status: available ? "available" : "unavailable", available }) }
  private async nodes() { return json({ nodes: await this.registry.list() }) }
  async fetch(req: Request): Promise<Response> { return await this.router.route(req) ?? apiError(404, "NOT_FOUND", "no such route") }
  start(): { url: string; stop: () => Promise<void> } {
    if (this.server) throw new Error("master already started")
    this.server = Bun.serve({ port: this.config.port, hostname: this.config.host, fetch: (req) => this.fetch(req) })
    const url = `http://${this.server.hostname}:${this.server.port}`
    return { url, stop: async () => { this.stopScheduler?.(); await this.server?.stop(true) } }
  }
  stop(): void { this.stopScheduler?.(); void this.server?.stop(true) }
}
