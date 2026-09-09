import { expect, test } from "bun:test"
import { isTerminalOpenCodeEvent, wrapOpenCodeEvent } from "../src/protocol/opencode-stream"

test("wraps an OpenCode event without changing its type or data", () => {
  const data = { delta: "plan" }
  const event = wrapOpenCodeEvent("ses_1", "worker_1", "session.next.reasoning.delta", data, 7, 123)

  expect(event).toEqual({
    id: "7",
    sessionID: "ses_1",
    workerID: "worker_1",
    source: "opencode",
    type: "session.next.reasoning.delta",
    data,
    at: 123,
  })
})

test("only recognizes explicit terminal events", () => {
  expect(isTerminalOpenCodeEvent({ type: "session.idle" })).toBe(true)
  expect(isTerminalOpenCodeEvent({ type: "session.next.text.delta" })).toBe(false)
})
