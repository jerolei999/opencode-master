import { expect, test } from "bun:test"
import { OpenCodeExecutor, extractCompletedAssistantReply, extractPendingQuestionFromContext, extractPendingToolFromContext, isMissingOpenCodeSessionError, projectContextMessages, resolveOpenCodeDatabasePath } from "../src/worker/opencode-executor"

test("keeps native OpenCode SQLite outside the shared CubeFS workspace", () => {
  expect(resolveOpenCodeDatabasePath("/var/lib/worker-1", "/mnt/cubefs", undefined)).toBe("/var/lib/worker-1/opencode.db")
  expect(() => resolveOpenCodeDatabasePath("/var/lib/worker-1", "/mnt/cubefs", "/mnt/cubefs/ws_1/opencode.db")).toThrow("worker-local")
})

test("selects the final assistant message after tool calls", () => {
  const reply = extractCompletedAssistantReply([
    { id: "old", type: "assistant", finish: "stop", content: [{ type: "text", text: "old reply" }] },
    { id: "interim", type: "assistant", finish: "tool-calls", content: [{ type: "text", text: "I will create it." }] },
    { id: "final", type: "assistant", finish: "stop", content: [
      { type: "reasoning", text: "The file was written." },
      { type: "text", text: "Created login.html." },
    ] },
  ], new Set(["old"]))

  expect(reply).toEqual({ id: "final", text: "Created login.html.", reasoning: "The file was written." })
})

test("keeps reasoning emitted by intermediate tool-call messages", () => {
  const reply = extractCompletedAssistantReply([
    { id: "turn-1", type: "assistant", finish: "tool-calls", content: [{ type: "reasoning", text: "I will inspect the files." }] },
    { id: "turn-2", type: "assistant", finish: "tool-calls", content: [{ type: "reasoning", text: "The structure is clear." }] },
    { id: "final", type: "assistant", finish: "stop", content: [{ type: "text", text: "Created the page." }] },
  ], new Set())

  expect(reply).toEqual({ id: "final", text: "Created the page.", reasoning: "I will inspect the files.\nThe structure is clear." })
})

test("finds a recoverable running question from the opencode context", () => {
  const question = extractPendingQuestionFromContext([
    { type: "assistant", id: "msg_old", content: [] },
    {
      type: "assistant",
      id: "msg_waiting",
      content: [{
        type: "tool",
        id: "que_real",
        name: "question",
        state: { status: "running", input: { questions: [{ question: "Pick one" }] } },
      }],
    },
  ])

  expect(question).toEqual({ id: "que_real", questions: [{ question: "Pick one" }] })
})

test("does not fabricate an unreplyable question id from context", () => {
  const question = extractPendingQuestionFromContext([{
    type: "assistant",
    content: [{
      type: "tool",
      name: "question",
      state: { status: "running", input: { questions: [{ question: "Pick one" }] } },
    }],
  }])

  expect(question).toBeUndefined()
})

test("only treats an OpenCode context 404 as an uninitialized session", () => {
  expect(isMissingOpenCodeSessionError(new Error("opencode context failed: 404"))).toBe(true)
  expect(isMissingOpenCodeSessionError(new Error("opencode context failed: 500"))).toBe(false)
  expect(isMissingOpenCodeSessionError(new Error("network timeout"))).toBe(false)
})

test("finds a pending non-question tool and reports an empty input", () => {
  const tool = extractPendingToolFromContext([{
    type: "assistant",
    content: [{ type: "tool", id: "call_write", name: "write", state: { status: "pending", input: "" } }],
  }])

  expect(tool).toEqual({ id: "call_write", name: "write", status: "pending", emptyInput: true })
})

test("projects an OpenCode user text field into transcript history", () => {
  expect(projectContextMessages("ses_1", [{ id: "msg_u", type: "user", text: "show this query" }])).toEqual([
    { id: "msg_u", role: "user", content: "show this query" },
  ])
})

test("reads UI history from the official OpenCode message endpoint in chronological order", async () => {
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    paths.push(url)
    if (url.endsWith("/global/health")) return new Response("{}")
    if (url.endsWith("/message")) return Response.json({ data: [
      { id: "a1", type: "assistant", time: { created: 2 }, content: [{ type: "text", text: "answer" }] },
      { id: "u1", type: "user", time: { created: 1 }, text: "query" },
    ] })
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  try {
    const executor = new OpenCodeExecutor({ slaveId: "test", opencodeBin: "opencode", port: 1, directory: "/tmp/test", dataDir: "/tmp/test" })
    expect(await executor.history("ses_history")).toEqual([
      { id: "u1", role: "user", content: "query" },
      { id: "a1", role: "assistant", content: "answer" },
    ])
    expect(paths.some((path) => path.endsWith("/api/session/ses_history/message"))).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("forwards reasoning deltas emitted after a question answer", async () => {
  const originalFetch = globalThis.fetch
  let contextReads = 0
  const encoder = new TextEncoder()
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith("/global/health") || url.endsWith("/api/session")) return new Response("{}")
    if (url.endsWith("/api/event")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"session.next.reasoning.delta","data":{"sessionID":"ses_resume","delta":"选择后继续推理"}}\n\n'))
        },
      })
      return new Response(stream)
    }
    if (url.includes("/question?")) return Response.json({ data: [] })
    if (url.includes("/question/que_resume/reply")) return new Response("{}")
    if (url.endsWith("/context")) {
      contextReads++
      return Response.json({ data: contextReads < 4 ? [] : [{
        id: "msg_final",
        type: "assistant",
        finish: "stop",
        content: [{ type: "text", text: "完成" }],
      }] })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  try {
    const executor = new OpenCodeExecutor({ slaveId: "test", opencodeBin: "opencode", port: 1, directory: "/tmp/test", dataDir: "/tmp/test" })
    const deltas: string[] = []
    await executor.resume({
      sessionId: "ses_resume",
      interactionId: "que_resume",
      answer: { answers: [["继续"]] },
      onDelta: async (event) => { deltas.push(event.delta) },
    })
    expect(deltas).toEqual(["选择后继续推理"])
  } finally {
    globalThis.fetch = originalFetch
  }
})
