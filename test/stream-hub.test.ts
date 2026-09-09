import { expect, test } from "bun:test"
import { WorkerStreamHub } from "../src/worker/stream-hub"

test("replays only events newer than a browser last-event id", () => {
  const hub = new WorkerStreamHub("worker_1", { capacity: 3, now: () => 123 })
  hub.publish("ses_1", "session.next.reasoning.delta", { delta: "one" })
  hub.publish("ses_1", "session.next.text.delta", { delta: "two" })
  hub.publish("ses_1", "session.idle", {})

  expect(hub.replay("ses_1", "1").map((event) => event.type)).toEqual([
    "session.next.text.delta",
    "session.idle",
  ])
})

test("keeps the replay buffer bounded per session", () => {
  const hub = new WorkerStreamHub("worker_1", { capacity: 2, now: () => 123 })
  hub.publish("ses_1", "one", {})
  hub.publish("ses_1", "two", {})
  hub.publish("ses_1", "three", {})

  expect(hub.replay("ses_1").map((event) => event.type)).toEqual(["two", "three"])
})
