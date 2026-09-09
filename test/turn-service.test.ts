import { expect, test } from "bun:test"
import { openDatabase } from "../src/db/client"
import { TurnService, StaleTurnLeaseError } from "../src/services/turn-service"

test("creates one durable turn for a repeated client idempotency key", async () => {
  const service = new TurnService(openDatabase(":memory:"), () => 100)
  const first = await service.createOrGet({ sessionId: "ses_1", userId: "u1", content: "hello", clientKey: "client_1", workerId: "w1", leaseEpoch: 1 })
  const second = await service.createOrGet({ sessionId: "ses_1", userId: "u1", content: "hello", clientKey: "client_1", workerId: "w1", leaseEpoch: 1 })

  expect(first.created).toBe(true)
  expect(second.created).toBe(false)
  expect(second.turn.id).toBe(first.turn.id)
})

test("rejects a second active turn for the same session", async () => {
  const service = new TurnService(openDatabase(":memory:"), () => 100)
  await service.createOrGet({ sessionId: "ses_1", userId: "u1", content: "first", clientKey: "client_1", workerId: "w1", leaseEpoch: 1 })

  await expect(service.createOrGet({ sessionId: "ses_1", userId: "u1", content: "second", clientKey: "client_2", workerId: "w1", leaseEpoch: 1 })).rejects.toThrow("active turn")
})

test("completes only with the current worker lease epoch", async () => {
  const service = new TurnService(openDatabase(":memory:"), () => 100)
  const { turn } = await service.createOrGet({ sessionId: "ses_1", userId: "u1", content: "hello", clientKey: "client_1", workerId: "w1", leaseEpoch: 3 })

  expect(await service.complete(turn.id, "w1", 2)).toBe(false)
  await expect(service.completeOrThrow(turn.id, "w1", 2)).rejects.toBeInstanceOf(StaleTurnLeaseError)
  expect(await service.complete(turn.id, "w1", 3)).toBe(true)
  expect((await service.get(turn.id))?.status).toBe("completed")
})
