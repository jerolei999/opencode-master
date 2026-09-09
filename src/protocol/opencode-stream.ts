/**
 * Browser-safe envelope for an event observed from OpenCode. The OpenCode
 * event type and data are deliberately retained, so Master never becomes a
 * second interpretation layer for normal turn traffic.
 */
export type OpenCodeStreamEvent = {
  id: string
  sessionID: string
  workerID: string
  source: "opencode" | "worker"
  type: string
  data: unknown
  at: number
}

export type OpenCodeControlRequest = {
  type: "question.reply" | "session.abort" | "session.force"
  data: Record<string, unknown>
}

export function wrapOpenCodeEvent(
  sessionID: string,
  workerID: string,
  type: string,
  data: unknown,
  id: number,
  at = Date.now(),
): OpenCodeStreamEvent {
  return { id: String(id), sessionID, workerID, source: "opencode", type, data, at }
}

/** Worker-only status events are explicit rather than masquerading as OpenCode. */
export function workerStreamEvent(
  sessionID: string,
  workerID: string,
  type: string,
  data: unknown,
  id: number,
  at = Date.now(),
): OpenCodeStreamEvent {
  return { id: String(id), sessionID, workerID, source: "worker", type, data, at }
}

export function isTerminalOpenCodeEvent(event: Pick<OpenCodeStreamEvent, "type">): boolean {
  return event.type === "session.idle" || event.type === "session.completed" || event.type === "session.error"
}
