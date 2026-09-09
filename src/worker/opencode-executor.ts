/**
 * Real execution backend: drives a stock `opencode serve` through its official
 * HTTP API. Zero opencode source changes (design §10.3).
 *
 * Per prompt (execute):
 *   POST /api/session { id: <master session id> }   (create/adopt, idempotent)
 *   POST /api/session/:id/prompt { prompt: { text } }
 *   poll GET /api/session/:id/context until a new assistant message appears
 *   → return the assistant text (and tool calls) as ExecutorMessages
 *
 * Credentials are injected via OPENCODE_AUTH_CONTENT (config-sync), model via
 * OPENCODE_CONFIG. The inner server only listens on 127.0.0.1 and is
 * guarded by a Basic password known only to this slave.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { Executor, ExecuteInput, ExecuteResult } from "./executor"
import type { SlaveLoad } from "../types"
import type { OpenCodeSessionSnapshotter, SessionSnapshot, SnapshotSafePoint } from "./session-snapshot"

export type OpenCodeExecutorOptions = {
  slaveId: string
  /** Executable that starts `opencode serve ...` (e.g. scripts/opencode-serve.sh). */
  opencodeBin?: string
  /** Port for the inner opencode serve. Ignored when externalBaseUrl is set. */
  port?: number
  /** Directory the slave owns (workspace). */
  directory: string
  /** Per-slave data root: XDG dirs are pointed here for full isolation. */
  dataDir: string
  /** Shared CubeFS root; native SQLite is forbidden below this path. */
  workspaceRoot?: string
  /** Directory containing the synced config and supplemental resources. */
  configDir?: string
  /** OPENCODE_AUTH_CONTENT value (config-sync output). */
  authContent?: string
  /** Explicit model passed to session.create (bypasses agent-default resolution). */
  model?: { providerID: string; id: string }
  /** Extra env (OPENCODE_DB...). */
  extraEnv?: Record<string, string>
  /** Optional native export adapter. History recovery remains the fallback. */
  snapshotter?: OpenCodeSessionSnapshotter
  /** When set, connect to an already-running opencode serve instead of spawning
   *  one (e.g. the Docker runtime on port 4096). */
  externalBaseUrl?: string
}


export function resolveOpenCodeDatabasePath(dataDir: string, workspaceRoot: string | undefined, configured: string | undefined): string {
  const databasePath = configured
    ? (isAbsolute(configured) ? resolve(configured) : resolve(dataDir, configured))
    : resolve(dataDir, "opencode.db")
  if (workspaceRoot) {
    const root = resolve(workspaceRoot)
    const outside = relative(root, databasePath)
    if (outside === "" || (outside !== ".." && !outside.startsWith(`..${sep}`) && !isAbsolute(outside))) {
      throw new Error(`OpenCode database must be worker-local and cannot be stored under CubeFS workspace: ${databasePath}`)
    }
  }
  return databasePath
}

const AUTH = `Basic ${Buffer.from("opencode:slave-internal").toString("base64")}`

/** Pending human-in-the-loop request published by opencode's question tool. */
type QuestionRequest = {
  id: string
  questions: unknown[]
  tool?: { messageID?: string; callID?: string }
}

type ContextMessage = { type: string; id?: string; text?: string; finish?: string; content?: unknown; time?: { created?: number } }

/** Project OpenCode context into the browser transcript without changing its source of truth. */
export function projectContextMessages(sessionId: string, context: ContextMessage[]): Array<{ id: string; role: "user" | "assistant" | "tool"; content: string; name?: string; reasoning?: string }> {
  return context.flatMap((message, index) => {
    if (message.type !== "user" && message.type !== "assistant" && message.type !== "tool") return []
    const parts = Array.isArray(message.content) ? message.content as Array<{ type?: string; text?: string; name?: string }> : []
    // OpenCode user messages use top-level `text`; assistant and tool messages
    // use content parts. Preserve both shapes in one normalised projection.
    const content = (typeof message.text === "string" ? message.text : parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")).trim()
    const reasoning = parts.filter((part) => part.type === "reasoning" && typeof part.text === "string").map((part) => part.text).join("\n").trim()
    if (!content && !reasoning) return []
    const name = parts.find((part) => typeof part.name === "string")?.name
    return [{ id: message.id ?? `${sessionId}:${index}`, role: message.type, content, ...(name ? { name } : {}), ...(reasoning ? { reasoning } : {}) }]
  })
}

/**
 * A turn that calls tools can emit several assistant messages. Only a message
 * with finish="stop" is the final user-visible answer; earlier text commonly
 * ends with finish="tool-calls" and must not end the bridge turn.
 */
export function extractCompletedAssistantReply(messages: ContextMessage[], knownAssistantIDs: Set<string>) {
  let reply: { id: string; text: string; reasoning: string } | undefined
  const reasoningParts: string[] = []
  for (const message of messages) {
    if (message.type !== "assistant" || !message.id || knownAssistantIDs.has(message.id)) continue
    const parts = Array.isArray(message.content) ? message.content as Array<{ type?: string; text?: string }> : []
    reasoningParts.push(...parts
      .filter((part) => part.type === "reasoning" && typeof part.text === "string")
      .map((part) => part.text as string)
      .filter((text) => text.trim().length > 0))
    if (message.finish !== "stop") continue
    const text = parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n").trim()
    if (!text) continue
    reply = { id: message.id, text, reasoning: reasoningParts.join("\n").trim() }
  }
  return reply
}

/** Return a running question only when its actual OpenCode reply id is known. */
export function extractPendingQuestionFromContext(messages: ContextMessage[]): QuestionRequest | undefined {
  for (const message of messages) {
    if (message.type !== "assistant") continue
    const parts = Array.isArray(message.content)
      ? message.content as Array<{ type?: string; id?: string; name?: string; state?: { status?: string; input?: { questions?: unknown[] } } }>
      : []
    for (const part of parts) {
      if (part.type !== "tool" || part.name !== "question" || part.state?.status !== "running" || !part.id) continue
      return { id: part.id, questions: part.state.input?.questions ?? [] }
    }
  }
  return undefined
}

/** A pending tool explains why the model is not emitting more text/reasoning. */
export function extractPendingToolFromContext(messages: ContextMessage[]) {
  for (const message of [...messages].reverse()) {
    if (message.type !== "assistant") continue
    const parts = Array.isArray(message.content)
      ? message.content as Array<{ type?: string; id?: string; name?: string; state?: { status?: string; input?: unknown } }>
      : []
    for (const part of [...parts].reverse()) {
      if (part.type !== "tool" || part.name === "question" || !part.id) continue
      if (part.state?.status !== "pending" && part.state?.status !== "running") continue
      const input = part.state.input
      const emptyInput = input === undefined || input === "" || (typeof input === "object" && input !== null && Object.keys(input).length === 0)
      return { id: part.id, name: part.name ?? "tool", status: part.state.status, emptyInput }
    }
  }
  return undefined
}

/** A new master session has no OpenCode context until its first prompt runs. */
export function isMissingOpenCodeSessionError(error: unknown): boolean {
  return error instanceof Error && error.message === "opencode context failed: 404"
}

export class OpenCodeExecutor implements Executor {
  private process?: ChildProcess
  private readonly baseUrl: string
  private readonly opts: OpenCodeExecutorOptions
  private stopped = false
  private started = false
  private readonly hydratedSessions = new Set<string>()
  private readonly sessionDirectories = new Map<string, string>()
  private readonly safePoints = new Map<string, SnapshotSafePoint>()
  constructor(opts: OpenCodeExecutorOptions) {
    this.opts = opts
    if (opts.externalBaseUrl) {
      this.baseUrl = opts.externalBaseUrl.replace(/\/+$/, "")
    } else {
      resolveOpenCodeDatabasePath(opts.dataDir, opts.workspaceRoot, opts.extraEnv?.["OPENCODE_DB"])
      this.baseUrl = `http://127.0.0.1:${opts.port}`
    }
  }


  /** Spawn `opencode serve` and wait for /global/health. Auto-restarts on crash. */
  /** Start the backend. External mode waits for the existing instance's health. */
  async start(): Promise<void> {
    this.stopped = false
    if (this.opts.externalBaseUrl) {
      await this.waitHealthy(20_000)
      this.started = true
      this.hydratedSessions.clear()
      this.sessionDirectories.clear()
      this.safePoints.clear()
      return
    }
    const occupied = await fetch(`${this.baseUrl}/global/health`, {
      headers: { authorization: AUTH },
      signal: AbortSignal.timeout(1000),
    })
      .then(() => true)
      .catch(() => false)
    if (occupied) throw new Error(`opencode port ${this.opts.port} is already in use`)
    mkdirSync(this.opts.directory, { recursive: true })
    // Seed the models.dev catalog cache: the isolated XDG cache starts empty and
    // the network fetch can time out, leaving no models selectable. Reuse the
    // user's global catalog cache when present.
    try {
      const globalModels = `${process.env["HOME"] ?? ""}/.cache/opencode/models.json`
      if (existsSync(globalModels)) {
        const cacheDir = `${this.opts.dataDir}/xdg-cache/opencode`
        mkdirSync(cacheDir, { recursive: true })
        copyFileSync(globalModels, `${cacheDir}/models.json`)
      }
    } catch {
      // non-fatal
    }
    // Credentials: write auth.json into the isolated data dir (opencode's native
    // path) in ADDITION to OPENCODE_AUTH_CONTENT — file injection is more
    // reliable than env injection in this opencode version.
    if (this.opts.authContent) {
      const authDir = `${this.opts.dataDir}/xdg-data/opencode`
      mkdirSync(authDir, { recursive: true })
      writeFileSync(`${authDir}/auth.json`, this.opts.authContent, { mode: 0o600 })
    }
    const configFile = this.configFile()
    const deepSeekApiKey = this.opts.extraEnv?.["DEEPSEEK_API_KEY"]
    if (configFile && deepSeekApiKey) {
      const config = readFileSync(configFile, "utf8")
      writeFileSync(configFile, config.replaceAll("{env:DEEPSEEK_API_KEY}", deepSeekApiKey), { mode: 0o600 })
    }
    const env: Record<string, string> = {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: "slave-internal",
      OPENCODE_LOG_LEVEL: process.env["OPENCODE_LOG_LEVEL"] ?? "DEBUG",
      // full per-slave isolation: separate data/config/cache dirs
      XDG_DATA_HOME: `${this.opts.dataDir}/xdg-data`,
      XDG_CONFIG_HOME: `${this.opts.dataDir}/xdg-config`,
      XDG_CACHE_HOME: `${this.opts.dataDir}/xdg-cache`,
      OPENCODE_DB: resolveOpenCodeDatabasePath(this.opts.dataDir, this.opts.workspaceRoot, this.opts.extraEnv?.["OPENCODE_DB"]),
      ...(configFile ? { OPENCODE_CONFIG: configFile } : {}),
      ...(this.opts.configDir ? { OPENCODE_CONFIG_DIR: this.opts.configDir } : {}),
      ...(this.opts.authContent ? { OPENCODE_AUTH_CONTENT: this.opts.authContent } : {}),
      ...this.opts.extraEnv,
    }
    if (!this.opts.opencodeBin || !this.opts.port) throw new Error("opencodeBin and port are required in spawn mode")
    this.process = spawn(this.opts.opencodeBin, ["serve", "--port", String(this.opts.port), "--hostname", "127.0.0.1"], {
      env,
      cwd: this.opts.directory,
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.hydratedSessions.clear()
    this.sessionDirectories.clear()
    this.safePoints.clear()
    const pid = this.process.pid
    this.process.stdout?.on("data", (chunk) => process.stdout.write(`[opencode:${this.opts.slaveId}] ${chunk}`))
    this.process.stderr?.on("data", (chunk) => process.stderr.write(`[opencode:${this.opts.slaveId}:err] ${chunk}`))
    this.process.on("exit", (code) => {
      console.log(`[slave ${this.opts.slaveId}] opencode exited: ${code} (pid=${pid})`)
      // crash guard: bring the inner opencode back up (unless we were stopped)
      if (!this.stopped && this.started) {
        console.log(`[slave ${this.opts.slaveId}] restarting opencode...`)
        setTimeout(() => {
          void this.start().catch((error) => console.error(`[slave ${this.opts.slaveId}] restart failed:`, (error as Error).message))
        }, 1500)
      }
    })
    this.started = true

    const deadline = Date.now() + 30_000
    for (;;) {
      if (Date.now() > deadline) throw new Error("opencode serve did not become healthy")
      try {
        const response = await fetch(`${this.baseUrl}/global/health`, { headers: { authorization: AUTH } })
        if (response.ok) return
      } catch {
        // retry
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  /** Official file-based configuration injection, resolved before spawning serve. */
  private configFile(): string | undefined {
    if (!this.opts.configDir) return
    return ["opencode.jsonc", "opencode.json"]
      .map((file) => `${this.opts.configDir}/${file}`)
      .find(existsSync)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.process?.kill("SIGTERM")
  }

  /**
   * Project the official OpenCode message log into the small transcript shape
   * consumed by the browser. This is read-only: Master never ingests or
   * reinterprets OpenCode's raw event stream.
   */
  async history(sessionId: string): Promise<Array<{ id: string; role: "user" | "assistant" | "tool"; content: string; name?: string; reasoning?: string }>> {
    await this.waitHealthy()
    let messages: ContextMessage[]
    try {
      messages = await this.messages(sessionId)
    } catch (error) {
      if (error instanceof Error && error.message === "opencode messages failed: 404") return []
      throw error
    }
    return projectContextMessages(sessionId, messages)
  }

  /**
   * Inject the prompt into the inner opencode, wait for the assistant reply,
   * and return it as durable messages. Tool calls inside the reply are
   * reported as tool messages (best-effort extraction of the final tool text).
   */
  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    await this.waitHealthy()
    const workspacePath = input.workspacePath ?? this.opts.directory
    await this.ensureSession(input.sessionId, workspacePath)
    const context = await this.context(input.sessionId)
    const conversation = context.filter((message) => message.type === "user" || message.type === "assistant" || message.type === "tool")
    // Known assistant message ids: a text.ended for an id NOT in this set is the fresh reply.
    const knownAssistant = new Set(context.filter((m) => m.type === "assistant" && typeof m.id === "string").map((m) => m.id as string))
    const restoreHistory = !this.hydratedSessions.has(input.sessionId) && input.history.length > conversation.length
    const prompt = restoreHistory
      ? [
          "<conversation-history>",
          "This is the durable transcript from before this OpenCode session was restored. Treat it as prior conversation; answer only the new user message below.",
          ...input.history.map((message) => `[${message.role}${message.name ? `:${message.name}` : ""}]\n${message.content}`),
          "</conversation-history>",
          "<new-user-message>",
          input.prompt,
          "</new-user-message>",
        ].join("\n\n")
      : input.prompt

    let replyText: string | undefined
    let replyReasoning = ""
    let completedID: string | undefined
    // opencode emits session.next.step.failed (not text.ended) when the turn is
    // interrupted or fails (e.g. "Provider turn interrupted", provider error).
    // Without this the wait loop below would spin until the 10 min deadline.
    let suspendReason: string | undefined
    const stopStream = await this.subscribeEvents(input.sessionId, {
      onDelta: input.onDelta,
      onTextEnded: (messageID, text) => {
        if (knownAssistant.has(messageID)) return
        if (replyText === undefined) replyText = text
      },
      onReasoningEnded: (messageID, text) => {
        if (!knownAssistant.has(messageID)) replyReasoning = text
      },
      onStepFailed: (messageID, error) => {
        if (knownAssistant.has(messageID)) return
        if (suspendReason === undefined) suspendReason = error
      },
    })
    try {
      await this.postJson(`/api/session/${input.sessionId}/prompt`, { prompt: { text: prompt } })
      this.hydratedSessions.add(input.sessionId)
      // 10 min: covers bash tool max timeout (10 min) plus queueing behind an
      // in-flight long tool task in the inner opencode drain.
      const deadline = Date.now() + 600_000
      // Wait until the turn fully settles: no pending question AND final text.
      // A question tool may appear after a preliminary text (model asks while
      // writing), so the loop must not exit on text alone.
      for (;;) {
        // 1) Human-in-the-loop: a question tool is waiting for user input.
        //    Yield with the interaction so the master can ask the user; the
        //    answer comes back via resume.
        const pending = await this.pendingQuestions(input.sessionId, workspacePath)
        const first = pending[0]
        if (first !== undefined) {
          this.safePoints.set(input.sessionId, "waiting_input")
          return {
            messages: [],
            status: "suspended",
            interaction: {
              id: first.id,
              type: "input",
              request: {
                requestID: first.id,
                sessionID: input.sessionId,
                questions: first.questions,
                ...(suspendReason !== undefined ? { reason: suspendReason } : {}),
              },
            },
          }
        }
        const completed = extractCompletedAssistantReply(await this.context(input.sessionId), knownAssistant)
        if (completed) {
          replyText = completed.text
          replyReasoning = completed.reasoning || replyReasoning
          completedID = completed.id
          break
        }
        // 2) Turn interrupted/failed on the opencode side (session.next.step.failed):
        //    no assistant reply will arrive. Yield the slot now.
        if (suspendReason !== undefined) {
          this.safePoints.set(input.sessionId, "idle")
          return { messages: [], status: "suspended" }
        }
        if (Date.now() > deadline) throw new Error("timed out waiting for assistant reply from opencode")
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      this.safePoints.set(input.sessionId, "idle")
      return { messages: [{ role: "assistant", content: replyText, ...(replyReasoning.trim() ? { reasoning: replyReasoning.trim() } : {}), ...(completedID ? { sourceID: completedID } : {}) }] }
    } finally {
      stopStream()
    }
  }

  /**
   * Resume a suspended interactive execution: deliver the user's answer to the
   * pending question tool, then wait for the assistant to finish the turn.
   */
  async resume(input: {
    sessionId: string
    workspacePath?: string
    turnID?: string
    leaseEpoch?: number
    interactionId: string
    answer: Record<string, unknown>
    onDelta?: ExecuteInput["onDelta"]
  }): Promise<ExecuteResult> {
    await this.waitHealthy()
    const workspacePath = input.workspacePath ?? this.sessionDirectories.get(input.sessionId) ?? this.opts.directory
    await this.ensureSession(input.sessionId, workspacePath)
    const context = await this.context(input.sessionId)
    const knownAssistant = new Set(context.filter((m) => m.type === "assistant" && typeof m.id === "string").map((m) => m.id as string))
    let replyText: string | undefined
    let replyReasoning = ""
    let completedID: string | undefined
    let suspendReason: string | undefined
    const stopStream = await this.subscribeEvents(input.sessionId, {
      onDelta: input.onDelta,

      onTextEnded: (messageID, text) => {
        if (knownAssistant.has(messageID)) return
        if (text.trim()) replyText = text
      },
      onReasoningEnded: (messageID, text) => {
        if (!knownAssistant.has(messageID)) replyReasoning = text
      },
      onStepFailed: (messageID, error) => {
        if (!knownAssistant.has(messageID) && suspendReason === undefined) suspendReason = error
      },
    })
    // Question state is directory-scoped in OpenCode. A reply without the
    // session's directory can return 200 while being delivered to a different
    // runtime context, leaving the real question visibly stuck.
    const reply = await fetch(`${this.baseUrl}/api/session/${input.sessionId}/question/${input.interactionId}/reply?directory=${encodeURIComponent(workspacePath)}`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: JSON.stringify(input.answer),
    })
    if (!reply.ok) {
      console.error(`[slave ${this.opts.slaveId}] question reply failed: ${reply.status} ${await reply.text()}`)
    }
    try {
      const deadline = Date.now() + 600_000
      for (;;) {
        const pending = await this.pendingQuestions(input.sessionId, workspacePath)
        const first = pending[0]
        if (first !== undefined) {
          this.safePoints.set(input.sessionId, "waiting_input")
          return { messages: [], status: "suspended", interaction: { id: first.id, type: "input", request: { requestID: first.id, sessionID: input.sessionId, questions: first.questions } } }
        }
        const completed = extractCompletedAssistantReply(await this.context(input.sessionId), knownAssistant)
        if (completed) {
          replyText = completed.text
          replyReasoning = completed.reasoning || replyReasoning
          completedID = completed.id
          break
        }
        if (suspendReason !== undefined) {
          this.safePoints.set(input.sessionId, "idle")
          return { messages: [], status: "suspended" }
        }
        if (Date.now() > deadline) throw new Error("timed out waiting for assistant reply from opencode")
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      this.safePoints.set(input.sessionId, "idle")
      return { messages: [{ role: "assistant", content: replyText, ...(replyReasoning.trim() ? { reasoning: replyReasoning.trim() } : {}), ...(completedID ? { sourceID: completedID } : {}) }] }
    } finally {
      stopStream()
    }
  }

  /**
   * A process may exit after OpenCode has created a question but before the
   * master sees it. Reconcile owned sessions on heartbeat to repair that gap.
   */
  async reconcile(sessionId: string): Promise<ExecuteResult | undefined> {
    await this.waitHealthy()
    try {
      const first = (await this.pendingQuestions(sessionId, this.sessionDirectories.get(sessionId) ?? this.opts.directory))[0]
      if (first) {
        this.safePoints.set(sessionId, "waiting_input")
        return {
          messages: [],
          status: "suspended",
          interaction: {
            id: first.id,
            type: "input",
            request: { requestID: first.id, sessionID: sessionId, questions: first.questions },
          },
        }
      }
      const context = await this.context(sessionId)
      const tool = extractPendingToolFromContext(context)
      if (tool) {
        return {
          messages: [{
            role: "tool",
            name: tool.name,
            content: tool.emptyInput
              ? `工具 ${tool.name} 正在等待输入，尚未开始执行。`
              : `正在执行工具 ${tool.name}。`,
            sourceID: tool.id,
          }],
          status: "suspended",
        }
      }
      const completed = extractCompletedAssistantReply(context, new Set())
      if (completed) {
        this.safePoints.set(sessionId, "idle")
        return {
          messages: [{ role: "assistant", content: completed.text, ...(completed.reasoning ? { reasoning: completed.reasoning } : {}), sourceID: completed.id }],
          status: "completed",
        }
      }
      return undefined
    } catch (error) {
      // Reconciliation precedes prompt execution. A 404 here means only that
      // this new session has not been created in OpenCode yet; let drainSession
      // create it instead of aborting the entire bridge tick.
      if (isMissingOpenCodeSessionError(error)) return undefined
      throw error
    }
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot | undefined> {
    const safePoint = this.safePoints.get(sessionId)
    if (!safePoint || !this.opts.snapshotter) return undefined
    return this.opts.snapshotter.export(sessionId, safePoint)
  }

  private async subscribeEvents(
    sessionId: string,
    handlers: {
      onDelta?: ExecuteInput["onDelta"]
      onTextEnded?: (messageID: string, text: string) => void
      onReasoningEnded?: (messageID: string, text: string) => void
      onStepFailed?: (messageID: string, error: string) => void
    },
  ): Promise<() => void> {
    const controller = new AbortController()
    // Legacy /api/event ({id,type,data}): forwards EventManifest.ServerDefinitions
    // with NO location filtering — session.next.* events (delta/ended/step.failed)
    // always arrive. The httpapi /event stream applies location filtering that
    // drops these events, and the legacy stream omits question.v2.* events, so
    // question detection relies on the context scan in pendingQuestions().
    const response = await fetch(`${this.baseUrl}/api/event`, { headers: { authorization: AUTH }, signal: controller.signal }).catch(() => undefined)
    if (!response?.ok || !response.body) {
      controller.abort()
      throw new Error("opencode event stream unavailable")
    }
    const body = response.body
    void (async () => {
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) return
          buffer += decoder.decode(chunk.value, { stream: true })
          const frames = buffer.split("\n\n")
          buffer = frames.pop() ?? ""
          for (const frame of frames) {
            const line = frame.split("\n").find((entry) => entry.startsWith("data: "))
            if (!line) continue
            const event = JSON.parse(line.slice(6)) as {
              type?: string
              data?: {
                sessionID?: string
                assistantMessageID?: string
                text?: string
                delta?: string
                error?: { type?: string; message?: string }
              }
            }
            if (event.data?.sessionID !== sessionId) continue
            switch (event.type) {
              case "session.next.text.delta":
                if (typeof event.data.delta === "string") await handlers.onDelta?.({ kind: "text", delta: event.data.delta })
                break
              case "session.next.reasoning.delta":
                if (typeof event.data.delta === "string") await handlers.onDelta?.({ kind: "reasoning", delta: event.data.delta })
                break
              case "session.next.text.ended":
                if (event.data.assistantMessageID && typeof event.data.text === "string") handlers.onTextEnded?.(event.data.assistantMessageID, event.data.text)
                break
              case "session.next.reasoning.ended":
                if (event.data.assistantMessageID && typeof event.data.text === "string") handlers.onReasoningEnded?.(event.data.assistantMessageID, event.data.text)
                break
              case "session.next.step.failed":
                if (event.data.assistantMessageID && typeof event.data.error?.message === "string") handlers.onStepFailed?.(event.data.assistantMessageID, event.data.error.message)
                break
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error(`[slave ${this.opts.slaveId}] opencode event stream failed:`, (error as Error).message)
      }
    })()
    return () => controller.abort()
  }

  /** Wait until the inner opencode is healthy (it may be restarting after a crash). */
  private async waitHealthy(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        const response = await fetch(`${this.baseUrl}/global/health`, { headers: { authorization: AUTH } })
        if (response.ok) return
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error("opencode not healthy")
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  /** Create the session in opencode using the master's session id (idempotent adopt). */
  private async ensureSession(sessionId: string, directory: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/session`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        id: sessionId,
        location: { directory },
        ...(this.opts.model ? { model: this.opts.model } : {}),
      }),
    })
    if (!response.ok) throw new Error(`opencode session create failed: ${response.status} ${await response.text()}`)
    this.sessionDirectories.set(sessionId, directory)
  }

  private async postJson(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`opencode POST ${path} failed: ${response.status} ${await response.text()}`)
  }


  private async context(sessionId: string): Promise<ContextMessage[]> {
    const response = await fetch(`${this.baseUrl}/api/session/${sessionId}/context`, {
      headers: { authorization: AUTH },
    })
    if (!response.ok) throw new Error(`opencode context failed: ${response.status}`)
    const body = (await response.json()) as { data?: ContextMessage[] }
    return body.data ?? []
  }

  /** Official SDK endpoint: `session.messages` → GET /session/:id/message. */
  private async messages(sessionId: string): Promise<ContextMessage[]> {
    const response = await fetch(`${this.baseUrl}/api/session/${sessionId}/message`, {
      headers: { authorization: AUTH },
    })
    if (!response.ok) throw new Error(`opencode messages failed: ${response.status}`)
    const body = (await response.json()) as { data?: ContextMessage[] }
    return (body.data ?? []).sort((left, right) => (left.time?.created ?? 0) - (right.time?.created ?? 0))
  }

  /**
   * Fallback human-in-the-loop detection, checked every wait-loop iteration:
   *   1) GET /question (opencode's question.list) — cheap, but the v2 question
   *      service is location-scoped and the list endpoint may miss requests.
   *   2) context scan — a tool part with name "question" and state.status
   *      "running" is authoritative and carries the full question payload
   *      (question/header/options/multiple), so a missed event cannot strand
   *      the execution slot for the full timeout.
   */
  private async pendingQuestions(sessionId: string, directory = this.sessionDirectories.get(sessionId) ?? this.opts.directory): Promise<QuestionRequest[]> {
    const pending: QuestionRequest[] = []
    try {
      // Session-scoped endpoint returns { data: [{ id: "que_...", sessionID, questions }] }
      const response = await fetch(`${this.baseUrl}/api/session/${sessionId}/question?directory=${encodeURIComponent(directory)}`, {
        headers: { authorization: AUTH },
        signal: AbortSignal.timeout(2000),
      })
      if (response.ok) {
        const body = (await response.json()) as { data?: Array<{ id?: string; sessionID?: string; questions?: unknown[] }> }
        for (const entry of body.data ?? []) {
          if (typeof entry.id === "string") {
            pending.push({ id: entry.id, questions: entry.questions ?? [] })
          }
        }
      }
    } catch {
      // non-fatal; context scan below is the authoritative fallback
    }
    if (pending.length === 0) {
      try {
        const question = extractPendingQuestionFromContext(await this.context(sessionId))
        if (question) pending.push(question)
      } catch {
        // non-fatal
      }
    }
    return pending
  }

  async load(): Promise<SlaveLoad> {
    try {
      const response = await fetch(`${this.baseUrl}/api/session/active`, {
        headers: { authorization: AUTH },
        signal: AbortSignal.timeout(2000),
      })
      if (response.ok) {
        const body = (await response.json()) as Record<string, unknown>
        return { cpuPct: 15, memPct: 20, activeDrains: Object.keys(body).length, pendingSteer: 0, pendingQueue: 0, toolProcesses: 0 }
      }
    } catch {
      // fall through
    }
    return { cpuPct: 10, memPct: 15, activeDrains: 0, pendingSteer: 0, pendingQueue: 0, toolProcesses: 0 }
  }
}
