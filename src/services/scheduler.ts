/** Periodically marks Workers without heartbeats unavailable. */
import type { Config } from "../config"
import type { WorkerRegistry } from "./worker-registry"
import type { SessionService } from "./session-service"

export type SchedulerReport = { unhealthyWorkers: string[]; rehomedSessions: string[] }

export class Scheduler {
  constructor(private registry: WorkerRegistry, private cfg: Config, private sessions?: SessionService) {}
  async runOnce(): Promise<SchedulerReport> {
    const unhealthyWorkers = await this.registry.sweep(this.cfg.heartbeatTimeoutMs)
    const rehomedSessions: string[] = []
    for (const workerId of unhealthyWorkers) rehomedSessions.push(...(await this.sessions?.rehomeWorkerSessions(workerId) ?? []))
    return { unhealthyWorkers, rehomedSessions }
  }
  start(): () => void {
    const timer = setInterval(
      () => void this.runOnce().catch((error) => console.error("[opencode-master] worker sweep failed", error)),
      this.cfg.schedulerIntervalMs,
    )
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
