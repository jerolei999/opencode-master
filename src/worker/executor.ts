/**
 * Slave executor abstraction (design §10, opencode-slave wrapper).
 *
 * The slave is the only component that talks to an execution backend. Two
 * implementations share the same message contract:
 *   - SimulatedExecutor: deterministic in-process replies (used for the
 *     end-to-end acceptance run; produces REAL assistant/tool messages that
 *     flow master → history exactly like a live model would).
 *   - OpenCodeExecutor: spawns a stock `opencode serve` and drives it through
 *     its official HTTP API (zero opencode source changes).
 */

import type { SlaveLoad } from "../types"
import type { SessionSnapshot } from "./session-snapshot"

/** A durable message produced by an execution backend. */
export type ExecutorMessage =
  | { role: "assistant"; content: string; reasoning?: string; sourceID?: string }
  | { role: "tool"; name: string; content: string; sourceID?: string }

export type HistoryItem = {
  role: "user" | "assistant" | "tool"
  content: string
  name?: string
}

export type ExecuteInput = {
  sessionId: string
  /** Durable master turn identity and fencing epoch. */
  turnID?: string
  leaseEpoch?: number
  /** Persistent workspace path resolved by the master workspace layer. */
  workspacePath?: string
  /** The prompt content admitted by the master. */
  prompt: string
  /** Prompt sequence number (per session, from the master). */
  promptSeq: number
  /** Conversation history so far (rebuilt from master events). */
  history: HistoryItem[]
  /** Slave id, for self-identification in replies. */
  slaveId: string
  /** Live text or reasoning fragment from the execution backend. */
  onDelta?: (event: { kind: "text" | "reasoning"; delta: string }) => Promise<void>
}

export type ExecuteResult = {
  messages: ExecutorMessage[]
  /** Execution yielded and released the worker slot. */
  status?: "completed" | "suspended"
  /** Optional human-in-the-loop pause request. */
  interaction?: {
    id?: string
    type: "question" | "approval" | "input"
    request: Record<string, unknown>
  }
}

export interface Executor {
  /** Execute one prompt; returns the messages to push as durable events. */
  execute(input: ExecuteInput): Promise<ExecuteResult>
  /** Current load snapshot for the heartbeat. */
  load(): Promise<SlaveLoad>
  /** Resume a suspended interactive execution on the same backend session. */
  resume?(input: {
    sessionId: string
    workspacePath?: string
    turnID?: string
    leaseEpoch?: number
    interactionId: string
    answer: Record<string, unknown>
    /** Live fragments emitted while continuing after a human answer. */
    onDelta?: ExecuteInput["onDelta"]
  }): Promise<ExecuteResult>
  /** Inspect an adopted backend session and recover an unreported pause. */
  reconcile?(sessionId: string): Promise<ExecuteResult | undefined>
  /** Export a native session only after the executor reaches a safe point. */
  snapshot?(sessionId: string): Promise<SessionSnapshot | undefined>
  /** Release any executor-owned processes before the slave exits. */
  stop?(): Promise<void>
}

export function historyFromEvents(
  prompts: Array<{ content: string; seq: number }>,
  messages: Array<{ role: string; content: string; name?: string; promptSeq?: number }>,
): HistoryItem[] {
  const items: Array<{ at: number; seq: number; item: HistoryItem }> = []
  for (const prompt of prompts) {
    items.push({ at: prompt.seq, seq: prompt.seq, item: { role: "user", content: prompt.content } })
  }
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") continue
    items.push({
      at: message.promptSeq ?? 0.5,
      seq: items.length,
      item: { role: message.role, content: message.content, ...(message.name ? { name: message.name } : {}) },
    })
  }
  items.sort((a, b) => a.at - b.at || a.seq - b.seq)
  return items.map((entry) => entry.item)
}
