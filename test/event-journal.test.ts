import { expect, test } from "bun:test"
import { openDatabase } from "../src/db/client"
import { EventJournal } from "../src/services/event-journal"

test("appends events in session order and replays after a worker is gone", async () => {
  const journal = new EventJournal(openDatabase(":memory:"), () => 100)
  const first = await journal.append({ sessionId: "ses_1", tenantId: "t1", turnId: "turn_1", workerId: "w1", leaseEpoch: 1, sourceId: "w1:1", type: "session.next.text.delta", data: { delta: "hello" } })
  const second = await journal.append({ sessionId: "ses_1", tenantId: "t1", turnId: "turn_1", workerId: "w1", leaseEpoch: 1, sourceId: "w1:2", type: "session.idle", data: {} })

  expect(first.seq).toBe("1")
  expect(second.seq).toBe("2")
  expect((await journal.replay("ses_1")).map((event) => event.type)).toEqual(["session.next.text.delta", "session.idle"])
  expect((await journal.replay("ses_1", "1")).map((event) => event.type)).toEqual(["session.idle"])
})

test("retries with the same source id return one durable event", async () => {
  const journal = new EventJournal(openDatabase(":memory:"))
  const input = { sessionId: "ses_1", tenantId: "t1", turnId: "turn_1", workerId: "w1", leaseEpoch: 1, sourceId: "w1:1", type: "worker.turn.message", data: { message: { role: "assistant", content: "done" } } }
  const first = await journal.append(input)
  const second = await journal.append(input)
  expect(second.id).toBe(first.id)
  expect((await journal.replay("ses_1"))).toHaveLength(1)
})

test("projects durable turns and messages into history", async () => {
  const db = openDatabase(":memory:")
  const journal = new EventJournal(db)
  const { turns } = await import("../src/db/schema")
  await db.insert(turns).values({ id: "turn_1", session_id: "ses_1", user_id: "u1", content: "hello", client_key: "k1", status: "completed", lease_epoch: 1, assigned_worker_id: "w1", created_at: 1, updated_at: 2, completed_at: 2 })
  await journal.append({ sessionId: "ses_1", tenantId: "t1", turnId: "turn_1", workerId: "w1", leaseEpoch: 1, sourceId: "w1:1", type: "worker.turn.message", data: { message: { id: "m1", role: "assistant", content: "world" } } })

  expect(await journal.history("ses_1")).toEqual([
    { role: "user", content: "hello" },
    { id: "m1", role: "assistant", content: "world" },
  ])
})
