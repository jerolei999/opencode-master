/**
 * Dev Worker daemon for OpenCode Master.
 * Registers to Master, emits periodic heartbeats, and handles prompts with realistic streaming text & thinking.
 */
const masterUrl = (process.env.OPENCODE_MASTER_URL || "http://127.0.0.1:4000").replace(/\/+$/, "")
const workerId = process.env.WORKER_ID || "worker-1"
const port = Number(process.env.WORKER_PORT || 15100)
const adminApiKey = process.env.BOOTSTRAP_API_KEY || "dev-admin-key"

let workerToken = ""
let seq = 0

async function postMaster(path: string, body: unknown, token?: string) {
  const resp = await fetch(`${masterUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return resp
}

// 1. 启动 Worker HTTP 代理服务
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    const match = url.pathname.match(/^\/sessions\/([^/]+)\/(prompt|control|stream|history)$/)
    if (!match) return new Response("not found", { status: 404 })

    const [, sessionId, action] = match

    if (action === "prompt" && req.method === "POST") {
      const body = (await req.json()) as { content: string; turnID: string; leaseEpoch: number }
      
      // 异步模拟大模型推理与流式生成
      setTimeout(async () => {
        try {
          const userPrompt = body.content.trim()
          seq++
          
          // 1. 发送思考链 (Reasoning)
          const thoughts = [
            `正在解析用户指令: "${userPrompt}"...\n`,
            `已加载当前工作区上下文，正在规划任务执行步骤...\n`,
            `准备就绪，开始生成响应内容。`
          ]
          for (const t of thoughts) {
            await postMaster(`/api/v1/workers/${workerId}/events`, {
              sessionID: sessionId,
              turnID: body.turnID,
              leaseEpoch: body.leaseEpoch,
              sourceID: `${workerId}:${seq++}`,
              type: "session.next.reasoning.delta",
              data: { delta: t }
            }, workerToken)
            await Bun.sleep(120)
          }

          // 2. 根据输入构造智能回答
          let replyText = ""
          if (userPrompt.includes("科技早报") || userPrompt.includes("科技") || userPrompt.includes("新闻")) {
            replyText = `# 📅 每日科技与 AI 前沿快讯\n\n- **大模型长思维链推理**：主流开源模型在复杂编码与数学任务中表现稳步提升。\n- **分布式任务调度**：DolphinScheduler 成功完成定时回调，本会话由 OpenCode Master 自动拉起。\n- **系统运行状态**：当前 Worker (${workerId}) 运行正常，工作区环境就绪。\n\n*提示：你可以直接回复我继续追问相关技术细节！*`
          } else if (userPrompt.includes("分析") || userPrompt.includes("目录") || userPrompt.includes("结构")) {
            replyText = `### 📂 工作区分析报告\n\n当前项目结构清晰，包含以下核心模块：\n1. \`src/http/server.ts\`：Master 控制面路由与反向代理\n2. \`src/http/web-console.ts\`：多用户 Web 控制台界面\n3. \`.opencode/plugins/dolphinscheduler\`：定时任务调度插件\n\n全部核心链路已经过多租户用户隔离改造！`
          } else {
            replyText = `你好！我是运行在节点 **${workerId}** 上的 OpenCode Agent。\n\n我已收到你的请求：\n> ${userPrompt}\n\n当前会话已建立租约保护，支持执行代码、调用工具及自动化任务调度。请问有什么需要我协助的？`
          }

          // 3. 流式吐出字块 (Text Delta)
          const chunks = replyText.match(/.{1,4}/g) || [replyText]
          for (const chunk of chunks) {
            await postMaster(`/api/v1/workers/${workerId}/events`, {
              sessionID: sessionId,
              turnID: body.turnID,
              leaseEpoch: body.leaseEpoch,
              sourceID: `${workerId}:${seq++}`,
              type: "session.next.text.delta",
              data: { delta: chunk }
            }, workerToken)
            await Bun.sleep(50)
          }

          // 4. 提交最终会话消息并完成 Turn
          await postMaster(`/api/v1/workers/${workerId}/events`, {
            sessionID: sessionId,
            turnID: body.turnID,
            leaseEpoch: body.leaseEpoch,
            sourceID: `${workerId}:${seq++}`,
            type: "worker.turn.message",
            data: {
              role: "assistant",
              content: replyText,
              reasoning: thoughts.join("")
            }
          }, workerToken)

          // 5. 标记会话进入空闲就绪状态 (Idle)
          await postMaster(`/api/v1/workers/${workerId}/events`, {
            sessionID: sessionId,
            turnID: body.turnID,
            leaseEpoch: body.leaseEpoch,
            sourceID: `${workerId}:${seq++}`,
            type: "session.idle",
            data: {}
          }, workerToken)

        } catch (err) {
          console.error(`[Worker ${workerId}] prompt execution error:`, err)
        }
      }, 50)

      return Response.json({ accepted: true }, { status: 202 })
    }

    if (action === "control") {
      return Response.json({ accepted: true }, { status: 202 })
    }

    return new Response("ok")
  },
})

console.log(`[Worker ${workerId}] listening on http://127.0.0.1:${server.port}`)

// 2. 向 Master 获取 Admin Token 并注册本节点
async function bootstrap() {
  try {
    const authResp = await postMaster("/api/v1/auth/token", {
      apiKey: adminApiKey,
      user: "worker-admin",
      role: "admin",
    })
    const authData = (await authResp.json()) as { token: string }
    const adminToken = authData.token

    const regResp = await postMaster("/api/v1/workers/register", {
      id: workerId,
      address: `http://127.0.0.1:${server.port}`,
      region: "cn-north-1",
      version: "1.18.18",
      capacity: { maxDrains: 10, maxSessions: 50 },
    }, adminToken)

    const regData = (await regResp.json()) as { token: string }
    workerToken = regData.token
    console.log(`[Worker ${workerId}] registered successfully with Master.`)

    // 3. 启动定时心跳 (每 5 秒发送一次心跳上报负载)
    setInterval(async () => {
      try {
        await postMaster(`/api/v1/workers/${workerId}/heartbeat`, {
          load: {
            cpuPct: 15,
            memPct: 30,
            activeDrains: 0,
            pendingSteer: 0,
            pendingQueue: 0,
            toolProcesses: 0,
          },
        }, workerToken)
      } catch {}
    }, 5000)

  } catch (e) {
    console.error(`[Worker ${workerId}] bootstrap failed:`, e)
  }
}

bootstrap()
