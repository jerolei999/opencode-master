import { expect, test } from "bun:test"
import { OpenCodeGateway, projectContextMessages } from "../src/services/opencode-gateway"

/** A minimal in-memory opencode that honors the native HTTP API surface the bridge uses. */
function fakeOpenCode() {
  const contexts = new Map<string, Array<Record<string, unknown>>>()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      const parts = url.pathname.split("/").filter(Boolean)

      // POST /api/session
      if (request.method === "POST" && parts.join("/") === "api/session") {
        const body = await request.json() as { id?: string }
        if (!body.id) return Response.json({ error: "missing id" }, { status: 400 })
        contexts.set(body.id, [])
        return Response.json({ data: { id: body.id } })
      }

      // POST /api/session/:id/prompt
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "session" && parts[3] === "prompt") {
        const id = parts[2]!
        const body = await request.json() as { prompt?: { text?: string } }
        const text = body.prompt?.text ?? ""
        const ctx = contexts.get(id) ?? []
        ctx.push({ type: "user", text })
        ctx.push({ type: "assistant", content: [{ type: "text", text: `echo: ${text}` }], finish: "stop", id: "msg_reply" })
        contexts.set(id, ctx)
        return Response.json({ data: { admittedSeq: ctx.length } })
      }

      // GET /api/session/:id/context
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "session" && parts[3] === "context") {
        const id = parts[2]!
        return Response.json({ data: contexts.get(id) ?? [] })
      }

      // GET /api/session/:id/message (history projection)
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "session" && parts[3] === "message") {
        const id = parts[2]!
        return Response.json({ data: contexts.get(id) ?? [] })
      }

      // GET /api/event — SSE stream, instantly sends the reply's delta then text.ended
      if (request.method === "GET" && parts.join("/") === "api/event") {
        return new Response(
          "data: {\"type\":\"session.next.text.delta\",\"data\":{\"sessionID\":\"s1\",\"delta\":\"hi\"}}\n\n" +
          "data: {\"type\":\"session.next.text.ended\",\"data\":{\"sessionID\":\"s1\",\"assistantMessageID\":\"msg_reply\",\"text\":\"hi\"}}\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      }

      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}` }
}

test("creates a session, pushes a prompt and returns the assistant reply", async () => {
  const { server, url } = fakeOpenCode()
  const gateway = new OpenCodeGateway({ baseUrl: url })
  const deltas: string[] = []
  const result = await gateway.prompt({
    sessionId: "s1",
    directory: "/workspace/alice",
    content: "hello",
    history: [],
    onDelta: async ({ kind, delta }) => { if (kind === "text") deltas.push(delta) },
  })
  expect(result.status).toBe("completed")
  expect(result.messages[0]?.role).toBe("assistant")
  expect(result.messages[0]?.content).toBe("echo: hello")
  expect(result.messages[0]?.sourceID).toBe("msg_reply")
  server.stop(true)
})

test("projects opencode context into transcript messages", () => {
  const projected = projectContextMessages("s1", [
    { type: "user", text: "the question" },
    { type: "assistant", content: [{ type: "text", text: "an answer" }], id: "m1" },
  ])
  expect(projected[0]).toMatchObject({ role: "user", content: "the question" })
  expect(projected[1]).toMatchObject({ role: "assistant", content: "an answer", id: "m1" })
})
