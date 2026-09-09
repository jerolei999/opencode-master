import { expect, test } from "bun:test"
import { SessionActor } from "../src/worker/session-actor"

test("serializes work for one session", async () => {
  const actor = new SessionActor()
  const order: string[] = []
  const first = actor.enqueue("ses_1", async () => {
    order.push("first-start")
    await new Promise((resolve) => setTimeout(resolve, 5))
    order.push("first-end")
  })
  const second = actor.enqueue("ses_1", async () => { order.push("second") })
  await Promise.all([first, second])
  expect(order).toEqual(["first-start", "first-end", "second"])
})

test("discards a reconcile observation made stale by a resume", async () => {
  const actor = new SessionActor()
  const generation = actor.generation("ses_1")
  const observation = actor.enqueueObservation("ses_1", generation, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return "old-observation"
  })
  actor.beginResume("ses_1")
  expect(await observation).toBeUndefined()
})
