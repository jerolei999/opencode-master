import { expect, test } from "bun:test"
import { MasterEventReporter } from "../src/worker/event-reporter"
import { WorkerProxyServer } from "../src/worker/proxy-server"
import { WorkerStreamHub } from "../src/worker/stream-hub"

test("reports a semantic event with stable source identity and retries transient failures", async () => {
  const requests: Request[] = []
  let attempts = 0
  const reporter = new MasterEventReporter("http://master", "worker-token", "w1", async (input, init) => {
    requests.push(new Request(String(input), init))
    attempts++
    return attempts === 1 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 202 })
  }, { retryDelayMs: 0 })

  await reporter.report({ sessionID: "ses_1", turnID: "turn_1", leaseEpoch: 2, sourceID: "w1:7", type: "worker.turn.message", data: { message: { role: "assistant", content: "done" } } })
  expect(attempts).toBe(2)
  expect(requests[1]?.url).toBe("http://master/api/v1/workers/w1/events")
  expect(await requests[1]?.json()).toMatchObject({ sourceID: "w1:7", leaseEpoch: 2 })
})

test("worker prompt contract carries turn identity and lease epoch", async () => {
  const received: unknown[] = []
  const proxy = new WorkerProxyServer({
    hub: new WorkerStreamHub("w1"), authorize: () => true,
    prompt: async (input) => { received.push(input) }, control: async () => {}, history: async () => [],
  })
  const response = await proxy.fetch(new Request("http://worker/sessions/ses_1/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "hello", turnID: "turn_1", leaseEpoch: 2 }) }))
  expect(response.status).toBe(202)
  expect(received).toEqual([{ sessionID: "ses_1", content: "hello", turnID: "turn_1", leaseEpoch: 2, history: [] }])
})

test("worker control contract carries turn identity and lease epoch", async () => {
  const received: unknown[] = []
  const proxy = new WorkerProxyServer({
    hub: new WorkerStreamHub("w1"), authorize: () => true,
    prompt: async () => {}, control: async (input) => { received.push(input) }, history: async () => [],
  })
  const response = await proxy.fetch(new Request("http://worker/sessions/ses_1/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "question.reply", data: { interactionID: "q1", answer: { answers: ["yes"] } }, turnID: "turn_1", leaseEpoch: 2 }) }))
  expect(response.status).toBe(202)
  expect(received).toEqual([{ sessionID: "ses_1", turnID: "turn_1", leaseEpoch: 2, request: { type: "question.reply", data: { interactionID: "q1", answer: { answers: ["yes"] } } } }])
})
