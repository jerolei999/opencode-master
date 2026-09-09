/**
 * OpenCodeGateway: thin Master-side bridge to one or more stock `opencode serve`
 * instances (e.g. the Docker runtime on port 4096). The Master talks the
 * opencode native HTTP API directly; there is no separate worker process and no
 * protocol translation layer.
 *
 * Per prompt:
 *   POST /api/session { id, location: { directory }, agent }    (create/adopt, idempotent)
 *   POST /api/session/:id/prompt { prompt: { text } }
 *   subscribe GET /api/event  → session.next.* deltas → onDelta
 *   poll GET /api/session/:id/context until a new assistant reply appears
 *
 * A gateway instance is bound to one opencode instance's baseUrl. The registry
 * (heartbeat) decides which instance a session is routed to; the gateway then
 * owns that instance's native API.
 */

import type { HistoryItem } from "../types"

export type GatewayOpenCodeMessage = {
  type: string
  id?: string
  text?: string
  finish?: string
  content?: unknown
  time?: { created?: number }
}

export type GatewayOnDelta = (event: { kind: "text" | "reasoning"; delta: string }) => Promise<void>

export type GatewayRunResult = {
  /** Durable messages to append to the session journal. */
  messages: Array<{ role: "assistant" | "tool"; content: string; reasoning?: string; sourceID?: string; name?: string }>
  /** Human-in-the-loop pause request, if the model asked a question. */
  interaction?: {
    id?: string
    type: "input" | "question" | "approval"
    request: Record<string, unknown>
  }
  status?: "completed" | "suspended"
}

export type GatewayPromptInput = {
  sessionId: string
  directory: string
  content: string
  history: HistoryItem[]
  model?: { providerID: string; id: string }
  agent?: string
  onDelta?: GatewayOnDelta
}

type QuestionRequest = { id: string; questions: unknown[] }

type PendingTool = { id: string; name: string; status: string; emptyInput: boolean }

const DEFAULT_AGENT = "build"

/** Basic auth applied only when the instance requires it. */
function authHeader(baseUrl: string, username: string | undefined): string | undefined {
  if (!username) return undefined
  return `Basic ${Buffer.from(`${username}:slave-internal`).toString("base64")}`
}

/**
 * Project an OpenCode context row (user/assistant/tool) into a browser transcript
 * message without changing opencode's source of truth.
 */
export function projectContextMessages(
  sessionId: string,
  context: GatewayOpenCodeMessage[],
): Array<{ id: string; role: "user" | "assistant" | "tool"; content: string; name?: string; reasoning?: string }> {
  return context.flatMap((message, index) => {
    if (message.type !== "user" && message.type !== "assistant" && message.type !== "tool") return []
    const parts = Array.isArray(message.content) ? (message.content as Array<{ type?: string; text?: string; name?: string }>) : []
    // OpenCode user messages use top-level `text`; assistant/tool use content parts.
    const content = (typeof message.text === "string"
      ? message.text
      : parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
    ).trim()
    const reasoning = parts.filter((part) => part.type === "reasoning" && typeof part.text === "string").map((part) => part.text).join("\n").trim()
    if (!content && !reasoning) return []
    const name = parts.find((part) => typeof part.name === "string")?.name
    return [{ id: message.id ?? `${sessionId}:${index}`, role: message.type, content, ...(name ? { name } : {}), ...(reasoning ? { reasoning } : {}) }]
  })
}

function extractCompletedAssistantReply(messages: GatewayOpenCodeMessage[], knownAssistantIDs: Set<string>) {
  let reply: { id: string; text: string; reasoning: string } | undefined
  const reasoningParts: string[] = []
  for (const message of messages) {
    if (message.type !== "assistant" || !message.id || knownAssistantIDs.has(message.id)) continue
    const parts = Array.isArray(message.content) ? (message.content as Array<{ type?: string; text?: string }>) : []
    reasoningParts.push(
      ...parts.filter((part) => part.type === "reasoning" && typeof part.text === "string").map((part) => part.text as string).filter((text) => text.trim().length > 0),
    )
    if (message.finish !== "stop") continue
    const text = parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n").trim()
    if (!text) continue
    reply = { id: message.id, text, reasoning: reasoningParts.join("\n").trim() }
  }
  return reply
}

function extractPendingQuestion(messages: GatewayOpenCodeMessage[]): QuestionRequest | undefined {
  for (const message of messages) {
    if (message.type !== "assistant") continue
    const parts = Array.isArray(message.content)
      ? (message.content as Array<{ type?: string; id?: string; name?: string; state?: { status?: string; input?: { questions?: unknown[] } } }>)
      : []
    for (const part of parts) {
      if (part.type !== "tool" || part.name !== "question" || part.state?.status !== "running" || !part.id) continue
      return { id: part.id, questions: part.state.input?.questions ?? [] }
    }
  }
  return undefined
}

function extractPendingTool(messages: GatewayOpenCodeMessage[]): PendingTool | undefined {
  for (const message of [...messages].reverse()) {
    if (message.type !== "assistant") continue
    const parts = Array.isArray(message.content)
      ? (message.content as Array<{ type?: string; id?: string; name?: string; state?: { status?: string; input?: unknown } }>)
      : []
    for (const part of [...parts].reverse()) {
      if (part.type !== "tool" || part.name === "question" || !part.id) continue
      if (part.state?.status !== "pending" && part.state?.status !== "running") continue
      const input = part.state.input
      const empty = input === undefined || input === "" || (typeof input === "object" && input !== null && Object.keys(input).length === 0)
      return { id: part.id, name: part.name ?? "tool", status: part.state.status, emptyInput: empty }
    }
  }
  return undefined
}

export class OpenCodeGateway {
  private readonly baseUrl: string
  private readonly auth?: string
  /** Sessions whose active execution should be aborted at the next poll. */
  private readonly aborted = new Set<string>();

  constructor(private readonly opts: { baseUrl: string; username?: string; model?: { providerID: string; id: string }; workspaceRoot?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    this.auth = authHeader(this.baseUrl, opts.username)
  }

  /** Abort a running opencode execution for a session. Returns whether it was aborted.
   *  The in-flight `prompt()`/`resume()` poll loop notices at its next tick and yields.
   *  Also fires opencode's native `/abort` so a stuck tool call is cancelled.
   */
  async abort(sessionId: string): Promise<boolean> {
    if (!this.aborted.has(sessionId)) this.aborted.add(sessionId)
    try {
      await fetch(`${this.baseUrl}/api/session/${sessionId}/abort`, {
        method: "POST",
        headers: await this.headers(true),
        body: JSON.stringify({}),
      })
      return true
    } catch {
      return false
    }
  }

  /** Map a Master logical directory (e.g. `/workspace/alice`) to a path that exists
   *  inside the opencode instance. When `workspaceRoot` is set, a `/workspace/<x>`
   *  path is rewritten to `<workspaceRoot>/<x>`; absolute paths are left unchanged.
   *  Without a workspaceRoot the logical path is passed through verbatim.
   *  Docker Desktop bind-mounts do not resolve subdirectories reliably (realPath
   *  fails with ENOENT), so a logical `/workspace/<user>` path maps to the shared
   *  workspace root itself. Per-session isolation is provided by opencode's own
   *  session id, not by a separate directory.
   */
  private resolveDirectory(directory: string): string {
    if (!this.opts.workspaceRoot) return directory
    if (directory.startsWith("/workspace/")) return this.opts.workspaceRoot.replace(/\/+$/, "")
    return directory
  }


  /** Verify the instance is reachable. */
  async health(): Promise<boolean> {
    try {
      const headers = this.auth ? { authorization: this.auth } : undefined
      const response = await fetch(`${this.baseUrl}/global/health`, { headers, signal: AbortSignal.timeout(2000) })
      return response.ok
    } catch {
      return false
    }
  }

  private async headers(json = false): Promise<Record<string, string>> {
    return {
      ...(this.auth ? { authorization: this.auth } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
    }
  }

  /** Create or adopt the opencode session with the master's session id (idempotent). */
  async ensureSession(sessionId: string, directory: string, agent?: string, model?: { providerID: string; id: string }): Promise<void> {
    const resolvedDir = this.resolveDirectory(directory)
    const response = await fetch(`${this.baseUrl}/api/session`, {
      method: "POST",
      headers: await this.headers(true),
      body: JSON.stringify({
        id: sessionId,
        location: { directory: resolvedDir },
        ...(agent ? { agent } : {}),
        ...((model ?? this.opts.model) ? { model: model ?? this.opts.model } : {}),
      }),
    })
    if (!response.ok) throw new Error(`opencode session create failed: ${response.status} ${await response.text()}`)
  }

  private async context(sessionId: string): Promise<GatewayOpenCodeMessage[]> {
    const response = await fetch(`${this.baseUrl}/api/session/${sessionId}/context`, { headers: await this.headers() })
    if (!response.ok) throw new Error(`opencode context failed: ${response.status}`)
    const body = (await response.json()) as { data?: GatewayOpenCodeMessage[] }
    return body.data ?? []
  }

  private async pendingQuestions(sessionId: string, directory: string): Promise<QuestionRequest[]> {
    const pending: QuestionRequest[] = []
    const dir = this.resolveDirectory(directory)
    try {
      const response = await fetch(`${this.baseUrl}/api/session/${sessionId}/question?directory=${encodeURIComponent(dir)}`, {
        headers: await this.headers(),
        signal: AbortSignal.timeout(2000),
      })
      if (response.ok) {
        const body = (await response.json()) as { data?: Array<{ id?: string; sessionID?: string; questions?: unknown[] }> }
        for (const entry of body.data ?? []) {
          if (typeof entry.id === "string") pending.push({ id: entry.id, questions: entry.questions ?? [] })
        }
      }
    } catch {
      // non-fatal; context scan below is the fallback
    }
    if (pending.length === 0) {
      try {
        const question = extractPendingQuestion(await this.context(sessionId))
        if (question) pending.push(question)
      } catch {
        // non-fatal
      }
    }
    return pending
  }

  /**
   * Deliver the user's answer to the pending question tool, then wait for the
   * assistant to finish the turn.
   */
  async resume(input: {
    sessionId: string
    directory: string
    interactionId: string
    answer: Record<string, unknown>
    onDelta?: GatewayOnDelta
  }): Promise<GatewayRunResult> {
    const dir = this.resolveDirectory(input.directory)
    await this.ensureSession(input.sessionId, dir)
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
    const reply = await fetch(`${this.baseUrl}/api/session/${input.sessionId}/question/${input.interactionId}/reply?directory=${encodeURIComponent(dir)}`, {
      method: "POST",
      headers: await this.headers(true),
      body: JSON.stringify(input.answer),
    })
    if (!reply.ok) {
      console.error(`[opencode-gateway] question reply failed: ${reply.status} ${await reply.text()}`)
    }
    try {
      const deadline = Date.now() + 600_000
      for (;;) {
        if (this.aborted.has(input.sessionId)) {
          this.aborted.delete(input.sessionId)
          return { messages: [], status: "suspended" }
        }
        const pending = await this.pendingQuestions(input.sessionId, dir)
        const first = pending[0]
        if (first !== undefined) {
          return { messages: [], status: "suspended", interaction: { id: first.id, type: "input", request: { requestID: first.id, sessionID: input.sessionId, questions: first.questions } } }
        }
        const completed = extractCompletedAssistantReply(await this.context(input.sessionId), knownAssistant)
        if (completed) {
          replyText = completed.text
          replyReasoning = completed.reasoning || replyReasoning
          completedID = completed.id
          break
        }
        if (suspendReason !== undefined) return { messages: [], status: "suspended" }
        if (Date.now() > deadline) throw new Error("timed out waiting for assistant reply from opencode")
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      return {
        messages: [{ role: "assistant", content: replyText, ...(replyReasoning.trim() ? { reasoning: replyReasoning.trim() } : {}), ...(completedID ? { sourceID: completedID } : {}) }],
        status: "completed",
      }
    } finally {
      stopStream()
    }
  }

  /** Reconcile an adopted session and recover an unreported pause. */
  async reconcile(sessionId: string, directory: string): Promise<GatewayRunResult | undefined> {
    try {
      const first = (await this.pendingQuestions(sessionId, directory))[0]
      if (first) {
        return { messages: [], status: "suspended", interaction: { id: first.id, type: "input", request: { requestID: first.id, sessionID: sessionId, questions: first.questions } } }
      }
      const context = await this.context(sessionId)
      const tool = extractPendingTool(context)
      if (tool) {
        return {
          messages: [{
            role: "tool",
            name: tool.name,
            content: tool.emptyInput ? `工具 ${tool.name} 正在等待输入，尚未开始执行。` : `正在执行工具 ${tool.name}。`,
            sourceID: tool.id,
          }],
          status: "suspended",
        }
      }
      const completed = extractCompletedAssistantReply(context, new Set())
      if (completed) {
        return { messages: [{ role: "assistant", content: completed.text, ...(completed.reasoning ? { reasoning: completed.reasoning } : {}), sourceID: completed.id }], status: "completed" }
      }
      return undefined
    } catch (error) {
      if (error instanceof Error && error.message === "opencode context failed: 404") return undefined
      throw error
    }
  }

  /** Run one prompt: create/adopt session, push prompt, stream deltas, wait for reply. */
  async prompt(input: GatewayPromptInput): Promise<GatewayRunResult> {
    const dir = this.resolveDirectory(input.directory)
    await this.ensureSession(input.sessionId, dir, input.agent ?? DEFAULT_AGENT, input.model)
    const context = await this.context(input.sessionId)
    const conversation = context.filter((m) => m.type === "user" || m.type === "assistant" || m.type === "tool")
    const knownAssistant = new Set(context.filter((m) => m.type === "assistant" && typeof m.id === "string").map((m) => m.id as string))
    const restoreHistory = input.history.length > conversation.length
    const prompt = restoreHistory
      ? [
          "<conversation-history>",
          "This is the durable transcript from before this OpenCode session was restored. Treat it as prior conversation; answer only the new user message below.",
          ...input.history.map((message) => `[${message.role}${message.name ? `:${message.name}` : ""}]\n${message.content}`),
          "</conversation-history>",
          "<new-user-message>",
          input.content,
          "</new-user-message>",
        ].join("\n\n")
      : input.content

    let replyText: string | undefined
    let replyReasoning = ""
    let completedID: string | undefined
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
      const response = await fetch(`${this.baseUrl}/api/session/${input.sessionId}/prompt`, {
        method: "POST",
        headers: await this.headers(true),
        body: JSON.stringify({ prompt: { text: prompt } }),
      })
      if (!response.ok) throw new Error(`opencode prompt failed: ${response.status} ${await response.text()}`)
      const deadline = Date.now() + 600_000
      for (;;) {
        if (this.aborted.has(input.sessionId)) {
          this.aborted.delete(input.sessionId)
          return { messages: [], status: "suspended" }
        }
        const pending = await this.pendingQuestions(input.sessionId, dir)
        const first = pending[0]
        if (first !== undefined) {
          return {
            messages: [],
            status: "suspended",
            interaction: { id: first.id, type: "input", request: { requestID: first.id, sessionID: input.sessionId, questions: first.questions, ...(suspendReason !== undefined ? { reason: suspendReason } : {}) } },
          }
        }
        const completed = extractCompletedAssistantReply(await this.context(input.sessionId), knownAssistant)
        if (completed) {
          replyText = completed.text
          replyReasoning = completed.reasoning || replyReasoning
          completedID = completed.id
          break
        }
        if (suspendReason !== undefined) return { messages: [], status: "suspended" }
        if (Date.now() > deadline) throw new Error("timed out waiting for assistant reply from opencode")
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      return {
        messages: [{ role: "assistant", content: replyText, ...(replyReasoning.trim() ? { reasoning: replyReasoning.trim() } : {}), ...(completedID ? { sourceID: completedID } : {}) }],
        status: "completed",
      }
    } finally {
      stopStream()
    }
  }

  /** Subscribe to opencode's `/api/event` stream and route deltas for one session. */
  private async subscribeEvents(
    sessionId: string,
    handlers: {
      onDelta?: GatewayOnDelta
      onTextEnded?: (messageID: string, text: string) => void
      onReasoningEnded?: (messageID: string, text: string) => void
      onStepFailed?: (messageID: string, error: string) => void
    },
  ): Promise<() => void> {
    const controller = new AbortController()
    const response = await fetch(`${this.baseUrl}/api/event`, { headers: await this.headers(), signal: controller.signal }).catch(() => undefined)
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
              data?: { sessionID?: string; assistantMessageID?: string; text?: string; delta?: string; error?: { type?: string; message?: string } }
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
        if (!controller.signal.aborted) console.error("[opencode-gateway] event stream failed:", (error as Error).message)
      }
    })()
    return () => controller.abort()
  }
}
