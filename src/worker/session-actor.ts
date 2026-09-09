/**
 * Exclusive worker-side coordinator for one master session. All OpenCode work
 * for a session is queued here; no heartbeat callback may publish around it.
 */
export class SessionActor {
  private tails = new Map<string, Promise<void>>()
  private active = new Map<string, number>()
  private generations = new Map<string, number>()

  generation(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0
  }

  /** Invalidate observations that began before this user-answer resume. */
  beginResume(sessionId: string): number {
    const next = this.generation(sessionId) + 1
    this.generations.set(sessionId, next)
    return next
  }

  isBusy(sessionId: string): boolean {
    return (this.active.get(sessionId) ?? 0) > 0
  }

  enqueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    this.active.set(sessionId, (this.active.get(sessionId) ?? 0) + 1)
    const result = previous.then(work)
    this.tails.set(sessionId, result.then(() => undefined, () => undefined))
    return result.finally(() => {
      const remaining = (this.active.get(sessionId) ?? 1) - 1
      if (remaining <= 0) this.active.delete(sessionId)
      else this.active.set(sessionId, remaining)
    })
  }

  /** Do not publish an observation if a later resume superseded it. */
  enqueueObservation<T>(sessionId: string, generation: number, observe: () => Promise<T>): Promise<T | undefined> {
    return this.enqueue(sessionId, async () => {
      const value = await observe()
      return this.generation(sessionId) === generation ? value : undefined
    })
  }
}
