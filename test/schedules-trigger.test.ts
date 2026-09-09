import { expect, test } from "bun:test"
import { Master } from "../src/http/server"
import { openDatabase } from "../src/db/client"
import type { Config } from "../src/config"

const config: Config = {
  port: 0,
  host: "127.0.0.1",
  dbPath: ":memory:",
  jwtSecret: "test-secret",
  jwtTTLSeconds: 3600,
  heartbeatTimeoutMs: 15_000,
  leaseTTLMs: 60_000,
  schedulerIntervalMs: 60_000,
  bootstrapApiKey: "dev-admin-key",
  maxSessionsPerUser: 0,
  placementCandidates: 3,
  workerProxyCredential: "internal",
}

async function token(master: Master, user = "alice", role: "admin" | "user" = "user") {
  const response = await master.fetch(
    new Request("http://master/api/v1/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "dev-admin-key", user, role }),
    }),
  )
  return ((await response.json()) as { token: string }).token
}

async function call(master: Master, method: string, path: string, auth?: string, body?: unknown) {
  return master.fetch(
    new Request(`http://master${path}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

test("Master schedules trigger endpoint and web session management", async () => {
  const workerReceived: Array<{ path: string; body?: unknown }> = []

  // 1. 启动模拟 Worker
  const worker = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      workerReceived.push({ path, body: req.method === "GET" ? undefined : await req.json() })
      return Response.json({ accepted: true }, { status: 202 })
    },
  })

  try {
    const master = new Master({ config, db: openDatabase(":memory:"), autoScheduler: false })
    const adminToken = await token(master, "admin", "admin")

    // 注册 Worker 节点
    const reg = await call(master, "POST", "/api/v1/workers/register", adminToken, {
      id: "w1",
      address: `http://127.0.0.1:${worker.port}`,
    })
    expect(reg.status).toBe(201)

    // 2. 测试 DolphinScheduler 回调触发 Master: POST /api/v1/schedules/trigger
    const triggerResp = await call(master, "POST", "/api/v1/schedules/trigger", adminToken, {
      userId: "alice",
      taskName: "daily-tech-news",
      prompt: "每天9点查询科技热点并整理早报",
    })
    expect(triggerResp.status).toBe(202)
    const triggerData = (await triggerResp.json()) as {
      accepted: boolean
      sessionId: string
      workerId: string
    }
    expect(triggerData.accepted).toBe(true)
    expect(triggerData.workerId).toBe("w1")

    // 验证下发到 Worker 的请求
    expect(workerReceived.length).toBe(1)
    expect(workerReceived[0].path).toBe(`/sessions/${triggerData.sessionId}/prompt`)
    expect((workerReceived[0].body as { content?: string }).content).toBe("每天9点查询科技热点并整理早报")

    // 3. 验证该定时任务已经成为 Alice 的真实 Session
    const aliceToken = await token(master, "alice", "user")
    const sessionDetail = await call(master, "GET", `/api/v1/sessions/${triggerData.sessionId}`, aliceToken)
    expect(sessionDetail.status).toBe(200)
    const s = ((await sessionDetail.json()) as { session: { title: string; userId: string } }).session
    expect(s.title).toBe("⏰ 定时任务 · daily-tech-news")
    expect(s.userId).toBe("alice")

    // 4. 测试 GET /api/v1/auth/me
    const meResp = await call(master, "GET", "/api/v1/auth/me", aliceToken)
    expect(meResp.status).toBe(200)
    const meData = (await meResp.json()) as { user: string; tenant: string; role: string }
    expect(meData.user).toBe("alice")
    expect(meData.role).toBe("user")

    // 5. 测试 PATCH /api/v1/sessions/:id (重命名会话)
    const renameResp = await call(master, "PATCH", `/api/v1/sessions/${triggerData.sessionId}`, aliceToken, {
      title: "我的科技早报定制版",
    })
    expect(renameResp.status).toBe(200)
    const renamed = ((await renameResp.json()) as { session: { title: string } }).session
    expect(renamed.title).toBe("我的科技早报定制版")

    // 6. 测试异步状态探针端点: GET /api/v1/sessions/:id/status
    // 此时 Turn 正在运行中 (leased/running)
    const statusResp1 = await call(master, "GET", `/api/v1/sessions/${triggerData.sessionId}/status`, aliceToken)
    expect(statusResp1.status).toBe(200)
    const statusData1 = (await statusResp1.json()) as { status: string; activeTurn: { id: string } }
    expect(statusData1.status).toBe("running")
    expect(statusData1.activeTurn.id).toBe(triggerData.turn.id)

    // 模拟 Worker 完成该 Turn，上报 session.idle
    const workerToken = ((await reg.json()) as { token: string }).token
    await call(master, "POST", "/api/v1/workers/w1/events", workerToken, {
      sessionID: triggerData.sessionId,
      turnID: triggerData.turn.id,
      leaseEpoch: 1,
      sourceID: "w1:test:idle",
      type: "session.idle",
      data: {},
    })

    // 再次探针查询状态，应立刻更新为 idle (已就绪/完成)
    const statusResp2 = await call(master, "GET", `/api/v1/sessions/${triggerData.sessionId}/status`, aliceToken)
    expect(statusResp2.status).toBe(200)
    const statusData2 = (await statusResp2.json()) as { status: string }
    expect(statusData2.status).toBe("idle")

    // 7. 测试 DELETE /api/v1/sessions/:id (删除/结束会话)
    const delResp = await call(master, "DELETE", `/api/v1/sessions/${triggerData.sessionId}`, aliceToken)
    expect(delResp.status).toBe(200)

    const endedSession = await call(master, "GET", `/api/v1/sessions/${triggerData.sessionId}`, aliceToken)
    expect(((await endedSession.json()) as { session: { status: string } }).session.status).toBe("ended")
  } finally {
    worker.stop(true)
  }
})
