import { expect, test } from "bun:test"
import { WorkerProxyServer } from "../src/worker/proxy-server"
import { WorkerStreamHub } from "../src/worker/stream-hub"

test("accepts a prompt only with the internal credential", async () => {
  const hub = new WorkerStreamHub("worker_1")
  const prompts: Array<{ sessionID: string; content: string }> = []
  const proxy = new WorkerProxyServer({
    hub,
    authorize: (request) => request.headers.get("authorization") === "Bearer internal",
    prompt: async (input) => { prompts.push({ sessionID: input.sessionID, content: input.content }) },
    control: async () => {},
    history: async () => [],
  })

  const denied = await proxy.fetch(new Request("http://worker/sessions/ses_1/prompt", { method: "POST", body: JSON.stringify({ content: "hello" }) }))
  const accepted = await proxy.fetch(new Request("http://worker/sessions/ses_1/prompt", {
    method: "POST",
    headers: { authorization: "Bearer internal", "content-type": "application/json" },
    body: JSON.stringify({ content: "hello", turnID: "turn_1", leaseEpoch: 1 }),
  }))

  expect(denied.status).toBe(401)
  expect(accepted.status).toBe(202)
  expect(prompts).toEqual([{ sessionID: "ses_1", content: "hello" }])
})

test("replays buffered native events through SSE", async () => {
  const hub = new WorkerStreamHub("worker_1", { now: () => 123 })
  hub.publish("ses_1", "session.next.reasoning.delta", { delta: "continue" })
  const proxy = new WorkerProxyServer({
    hub,
    authorize: () => true,
    prompt: async () => {},
    control: async () => {},
    history: async () => [],
  })

  const response = await proxy.fetch(new Request("http://worker/sessions/ses_1/stream"))
  const reader = response.body!.getReader()
  const first = await reader.read()
  const second = await reader.read()
  await reader.cancel()

  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(new TextDecoder().decode(first.value)).toContain(": connected")
  expect(new TextDecoder().decode(second.value)).toContain('"type":"session.next.reasoning.delta"')
})

test("returns a session transcript from the Worker tracking layer", async () => {
  const proxy = new WorkerProxyServer({
    hub: new WorkerStreamHub("worker_1"),
    authorize: () => true,
    prompt: async () => {},
    control: async () => {},
    history: async (sessionID) => [{ id: "msg_1", role: "user", content: `query for ${sessionID}` }],
  })

  const response = await proxy.fetch(new Request("http://worker/sessions/ses_1/history"))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ messages: [{ id: "msg_1", role: "user", content: "query for ses_1" }] })
})

test("opens an idle SSE stream immediately", async () => {
  const proxy = new WorkerProxyServer({
    hub: new WorkerStreamHub("worker_1"), authorize: () => true, prompt: async () => {}, control: async () => {}, history: async () => [],
  })
  const response = await proxy.fetch(new Request("http://worker/sessions/ses_empty/stream"))
  const reader = response.body!.getReader()
  const first = await reader.read()
  await reader.cancel()
  expect(new TextDecoder().decode(first.value)).toContain(": connected")
})
