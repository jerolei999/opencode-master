import type { OpenCodeControlRequest } from "../protocol/opencode-stream"
import type { HistoryItem } from "../types"
import { WorkerStreamHub } from "./stream-hub"

export type WorkerPromptInput = { sessionID: string; workspaceID?: string; content: string; turnID: string; leaseEpoch: number; history: HistoryItem[] }
export type WorkerControlInput = { sessionID: string; workspaceID?: string; turnID: string; leaseEpoch: number; request: OpenCodeControlRequest }

type WorkerProxyOptions = {
  hub: WorkerStreamHub
  authorize: (request: Request) => boolean | Promise<boolean>
  prompt: (input: WorkerPromptInput) => Promise<void>
  control: (input: WorkerControlInput) => Promise<void>
  /** Stable session projection read from OpenCode, used to hydrate the UI. */
  history: (sessionID: string) => Promise<Array<{ id: string; role: "user" | "assistant" | "tool"; content: string; name?: string; reasoning?: string }>>
}

/** Private Worker API consumed by Master, never directly by a browser. */
export class WorkerProxyServer {
  constructor(private readonly options: WorkerProxyOptions) {}

  async fetch(request: Request): Promise<Response> {
    if (!(await this.options.authorize(request))) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    const url = new URL(request.url)
    const match = url.pathname.match(/^\/sessions\/([^/]+)\/(prompt|control|stream|history)$/)
    if (!match) return new Response(JSON.stringify({ error: "not found" }), { status: 404 })
    const [, sessionID, action] = match
    if (action === "stream" && request.method === "GET") return this.stream(sessionID!, request.headers.get("last-event-id") ?? undefined)
    if (action === "history" && request.method === "GET") return Response.json({ messages: await this.options.history(sessionID!) })
    if (action === "prompt" && request.method === "POST") return this.prompt(sessionID!, request)
    if (action === "control" && request.method === "POST") return this.control(sessionID!, request)
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 })
  }

  private async prompt(sessionID: string, request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as { content?: unknown; workspaceID?: unknown; turnID?: unknown; leaseEpoch?: unknown; history?: unknown } | undefined
    if (!body || typeof body.content !== "string" || !body.content.trim() || typeof body.turnID !== "string" || !body.turnID || typeof body.leaseEpoch !== "number" || !Number.isInteger(body.leaseEpoch)) return new Response(JSON.stringify({ error: "content, turnID and integer leaseEpoch are required" }), { status: 400 })
    await this.options.prompt({ sessionID, workspaceID: typeof body.workspaceID === "string" ? body.workspaceID : undefined, content: body.content, turnID: body.turnID, leaseEpoch: body.leaseEpoch, history: Array.isArray(body.history) ? body.history as HistoryItem[] : [] })
    return Response.json({ accepted: true }, { status: 202 })
  }

  private async control(sessionID: string, request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as (OpenCodeControlRequest & { workspaceID?: unknown; turnID?: unknown; leaseEpoch?: unknown }) | undefined
    if (!body || (body.type !== "question.reply" && body.type !== "session.abort" && body.type !== "session.force") || !body.data || typeof body.data !== "object" || typeof body.turnID !== "string" || !body.turnID || typeof body.leaseEpoch !== "number" || !Number.isInteger(body.leaseEpoch)) {
      return new Response(JSON.stringify({ error: "control request requires type, data, turnID and integer leaseEpoch" }), { status: 400 })
    }
    const { workspaceID, turnID, leaseEpoch, ...control } = body
    await this.options.control({ sessionID, workspaceID: typeof workspaceID === "string" ? workspaceID : undefined, turnID: turnID as string, leaseEpoch: leaseEpoch as number, request: control })
    return Response.json({ accepted: true }, { status: 202 })
  }

  private stream(sessionID: string, after?: string): Response {
    let unsubscribe: (() => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder()
        const send = (event: unknown) => controller.enqueue(encoder.encode(`id: ${(event as { id: string }).id}\ndata: ${JSON.stringify(event)}\n\n`))
        // Flush headers even if this session has no buffered event yet. Without
        // an initial SSE comment, fetch() can wait indefinitely for the first
        // token and the UI remains falsely stuck in “connecting”.
        controller.enqueue(encoder.encode(": connected\n\n"))
        for (const event of this.options.hub.replay(sessionID, after)) send(event)
        unsubscribe = this.options.hub.subscribe(sessionID, send)
      },
      cancel: () => unsubscribe?.(),
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })
  }
}
