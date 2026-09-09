import { wrapOpenCodeEvent, type OpenCodeStreamEvent } from "../protocol/opencode-stream"

type StreamHubOptions = { capacity?: number; now?: () => number }
type SessionBuffer = {
  nextID: number
  events: OpenCodeStreamEvent[]
  subscribers: Set<(event: OpenCodeStreamEvent) => void>
}

/** In-memory OpenCode stream fan-out owned by one Worker. */
export class WorkerStreamHub {
  private readonly sessions = new Map<string, SessionBuffer>()
  private readonly capacity: number
  private readonly now: () => number

  constructor(private readonly workerID: string, options: StreamHubOptions = {}) {
    this.capacity = options.capacity ?? 2_000
    this.now = options.now ?? Date.now
  }

  publish(sessionID: string, type: string, data: unknown): OpenCodeStreamEvent {
    const buffer = this.session(sessionID)
    const event = wrapOpenCodeEvent(sessionID, this.workerID, type, data, buffer.nextID++, this.now())
    buffer.events.push(event)
    if (buffer.events.length > this.capacity) buffer.events.splice(0, buffer.events.length - this.capacity)
    for (const subscriber of buffer.subscribers) subscriber(event)
    return event
  }

  replay(sessionID: string, after?: string): OpenCodeStreamEvent[] {
    const buffer = this.sessions.get(sessionID)
    if (!buffer) return []
    const afterID = after === undefined ? -1 : Number(after)
    if (!Number.isFinite(afterID)) return [...buffer.events]
    return buffer.events.filter((event) => Number(event.id) > afterID)
  }

  subscribe(sessionID: string, subscriber: (event: OpenCodeStreamEvent) => void): () => void {
    const buffer = this.session(sessionID)
    buffer.subscribers.add(subscriber)
    return () => buffer.subscribers.delete(subscriber)
  }

  private session(sessionID: string): SessionBuffer {
    let buffer = this.sessions.get(sessionID)
    if (!buffer) {
      buffer = { nextID: 1, events: [], subscribers: new Set() }
      this.sessions.set(sessionID, buffer)
    }
    return buffer
  }
}
