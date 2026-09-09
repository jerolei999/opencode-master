/**
 * Simulated execution backend for the slave.
 *
 * Produces deterministic, realistic assistant + tool messages so the full
 * acceptance path can be verified without an LLM API key:
 *   prompt → master → slave → assistant/tool messages → master history → client
 *
 * The "model" identity comes from the injected configuration (config-sync),
 * proving the config-consistency pipeline (AGENTS.md / skills / MCP / model)
 * reaches the execution layer.
 */

import type { Executor, ExecuteInput, ExecuteResult } from "./executor"
import type { SlaveLoad } from "../types"

export type SimulatedOptions = {
  slaveId: string
  /** Model identity injected via config (config-sync). */
  model?: { provider: string; id: string }
  /** Names of skills injected via config (config-sync). */
  skills?: string[]
  /** Whether MCP servers were injected via config (config-sync). */
  mcpCount?: number
}

export function createSimulatedExecutor(options: SimulatedOptions): Executor {
  const modelLine = options.model ? `${options.model.provider}/${options.model.id}` : "opencode default"

  function reply(prompt: string, history: ExecuteInput["history"]): { role: "assistant"; content: string } {
    const trimmed = prompt.trim()

    if (/你是什么模型|什么模型|which model|model are you/i.test(trimmed)) {
      return {
        role: "assistant",
        content: `我运行在 ${modelLine} 上（配置由 config-sync 从配置仓库注入）。${
          options.skills?.length ? `已加载 ${options.skills.length} 个技能：${options.skills.join("、")}。` : ""
        }${options.mcpCount ? `已连接 ${options.mcpCount} 个 MCP 服务器。` : ""}`,
      }
    }

    if (/你好|hello|hi|嗨/i.test(trimmed)) {
      return {
        role: "assistant",
        content: `你好！我是运行在 slave ${options.slaveId} 上的云 agent，模型 ${modelLine}。我已经看到你的第 ${history.length + 1} 条消息，有什么可以帮你？`,
      }
    }

    if (trimmed.length === 0) {
      return { role: "assistant", content: "（空消息）请告诉我你想做什么。" }
    }

    return {
      role: "assistant",
      content: `已收到：${trimmed}（slave ${options.slaveId} / ${modelLine}）。这是会话历史中的第 ${history.length + 1} 条消息。`,
    }
  }

  function maybeTool(prompt: string): { role: "tool"; name: string; content: string } | undefined {
    const echo = prompt.match(/echo工具|调用echo|echo\s+["']?([^"'，。]+)/i)
    if (echo) {
      const text = (echo[1] ?? prompt.replace(/echo工具|调用echo/i, "").trim()) || "hello from tool"
      return { role: "tool", name: "echo", content: text.trim() }
    }
    const add = prompt.match(/计算器|add\s+(\d+)\s*\+\s*(\d+)/i)
    if (add) {
      const [a, b] = [Number(add[1]), Number(add[2])]
      return { role: "tool", name: "calculator", content: `${a} + ${b} = ${a + b}` }
    }
    if (/now|现在几点|当前时间|date/i.test(prompt)) {
      return { role: "tool", name: "now", content: new Date().toISOString() }
    }
    return undefined
  }

  return {
    async execute(input: ExecuteInput): Promise<ExecuteResult> {
      const tool = maybeTool(input.prompt)
      if (tool) {
        return {
          messages: [
            tool,
            {
              role: "assistant",
              content: `我调用了 ${tool.name} 工具，结果为：${tool.content}`,
            },
          ],
        }
      }
      return { messages: [reply(input.prompt, input.history)] }
    },

    async load(): Promise<SlaveLoad> {
      return {
        cpuPct: 12,
        memPct: 20,
        activeDrains: 1,
        pendingSteer: 0,
        pendingQueue: 0,
        toolProcesses: 0,
      }
    },
  }
}
