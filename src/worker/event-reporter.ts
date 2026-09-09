import type { WorkerEventEnvelope } from "../types"

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class MasterEventReporter {
  private readonly fetcher: FetchLike
  private readonly retryCount: number
  private readonly retryDelayMs: number

  constructor(private masterURL: string, private token: string, private workerID: string, fetcher: FetchLike = fetch, options: { retryCount?: number; retryDelayMs?: number } = {}) {
    this.fetcher = fetcher
    this.retryCount = options.retryCount ?? 3
    this.retryDelayMs = options.retryDelayMs ?? 100
  }

  async report(event: WorkerEventEnvelope): Promise<void> {
    let lastError: Error | undefined
    for (let attempt = 0; attempt < this.retryCount; attempt++) {
      try {
        const response = await this.fetcher(`${this.masterURL.replace(/\/+$/, "")}/api/v1/workers/${encodeURIComponent(this.workerID)}/events`, {
          method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(event),
        })
        if (response.ok) return
        lastError = new Error(`master event ingest returned ${response.status}`)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
      if (attempt + 1 < this.retryCount && this.retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
    }
    throw lastError ?? new Error("master event ingest failed")
  }

}
