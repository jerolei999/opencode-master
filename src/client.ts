/**
 * opencode-master Web client — the external interface for web apps.
 *
 * The master is the ONLY visible surface: Worker addresses never leak here.
 * Usage (browser or Node/Bun):
 *
 *   const client = createMasterClient({ baseUrl: "https://master.example.com", token })
 *   const { session } = await client.createSession({ title: "fix the bug" })
 *   const { stream } = await client.prompt(session.id, { content: "..." })
 *   const events = client.stream(session.id, (event) => console.log(event))
 *   await client.endSession(session.id)
 */

export type MasterClientOptions = {
  baseUrl: string
  token: string
  fetch?: typeof fetch
}

export type SessionInfo = {
  id: string
  userId: string
  tenantId: string
  title: string
  directory?: string
  status: "pending" | "assigned" | "recovering" | "ended"
  ownerWorkerId?: string
  leaseEpoch: number
  createdAt: number
  updatedAt: number
}

export type EventPayload = {
  id: string
  sessionID: string
  tenantID: string
  turnID: string
  workerID: string
  leaseEpoch: number
  seq: string
  sourceID: string
  type: string
  data: unknown
  at: number
}

export type MasterError = {
  status: number
  code: string
  message: string
}

export class MasterClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function createMasterClient(options: MasterClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "")
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      let code = "ERROR"
      let message = response.statusText
      try {
        const payload = (await response.json()) as { error?: { code?: string; message?: string } }
        code = payload.error?.code ?? code
        message = payload.error?.message ?? message
      } catch {
        // keep defaults
      }
      throw new MasterClientError(response.status, code, message)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  return {
    baseUrl,

    /** Exchange an API key (or bootstrap key) for a JWT. */
    token(input: { apiKey: string; tenant?: string; user?: string; role?: "user" | "worker" | "admin" }) {
      return request<{ token: string; role: string; sub: string; tenant: string }>("POST", "/api/v1/auth/token", input)
    },

    createSession(input: { title?: string; directory?: string } = {}) {
      return request<{ session: SessionInfo }>("POST", "/api/v1/sessions", input)
    },

    listSessions(params: { user?: string } = {}) {
      const query = params.user ? `?user=${encodeURIComponent(params.user)}` : ""
      return request<{ sessions: SessionInfo[] }>("GET", `/api/v1/sessions${query}`)
    },

    getSession(sessionId: string) {
      return request<{ session: SessionInfo }>("GET", `/api/v1/sessions/${sessionId}`)
    },

    /** Admit a prompt; returns the SSE stream URL to subscribe to. */
    prompt(sessionId: string, input: { content: string; idempotencyKey?: string }) {
      return request<{ accepted: true; stream: string; turn: { id: string; status: string; leaseEpoch: number } }>("POST", `/api/v1/sessions/${sessionId}/prompt`, input)
    },

    /** Forward an OpenCode control request to the session's bound Worker. */
    control(sessionId: string, input: {
      type: "question.reply" | "session.abort" | "session.force"
      data: Record<string, unknown>
    }) {
      return request<{ accepted: true }>("POST", `/api/v1/sessions/${sessionId}/control`, input)
    },


    endSession(sessionId: string) {
      return request<{ ok: true }>("POST", `/api/v1/sessions/${sessionId}/end`)
    },

    /** Subscribe to the session event stream (SSE). Returns an abort function. */
    stream(
      sessionId: string,
      onEvent: (event: EventPayload) => void,
      opts: { after?: number; signal?: AbortSignal } = {},
    ): () => void {
      const after = opts.after ?? -1
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      opts.signal?.addEventListener("abort", onAbort, { once: true })
      void (async () => {
        try {
          const response = await doFetch(`${baseUrl}/api/v1/sessions/${sessionId}/events?after=${after}`, {
            headers: { authorization: `Bearer ${options.token}`, accept: "text/event-stream" },
            signal: controller.signal,
          })
          if (!response.ok || !response.body) throw new MasterClientError(response.status, "STREAM", "stream failed")
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let idx: number
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, idx)
              buffer = buffer.slice(idx + 2)
              const dataLine = frame
                .split("\n")
                .find((line) => line.startsWith("data:"))
                ?.slice(5)
                .trim()
              if (!dataLine) continue
              try {
                onEvent(JSON.parse(dataLine) as EventPayload)
              } catch {
                // skip malformed frames
              }
            }
          }
        } catch {
          // aborted or connection closed
        } finally {
          opts.signal?.removeEventListener("abort", onAbort)
        }
      })()
      return () => controller.abort()
    },
  }
}

export type MasterClient = ReturnType<typeof createMasterClient>
