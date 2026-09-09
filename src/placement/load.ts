/**
 * Load scoring & least-loaded selection (design §M2 / §M4).
 * Weighted score: CPU dominates, then active drains, then queue/tools/mem.
 * Pure function, unit-testable.
 */

import type { SlaveLoad } from "../types"

export type LoadInput = Partial<SlaveLoad>

export function scoreLoad(load: LoadInput): number {
  const cpu = Math.min(Math.max((load.cpuPct ?? 0) / 100, 0), 1)
  const mem = Math.min(Math.max((load.memPct ?? 0) / 100, 0), 1)
  const drains = Math.min((load.activeDrains ?? 0) / 8, 1)
  const queue = Math.min(((load.pendingSteer ?? 0) + (load.pendingQueue ?? 0)) / 8, 1)
  const tools = Math.min((load.toolProcesses ?? 0) / 16, 1)
  return 0.4 * cpu + 0.15 * mem + 0.3 * drains + 0.1 * queue + 0.05 * tools
}

export function pickLeastLoaded<T extends { id: string; load: LoadInput }>(items: T[]): T | undefined {
  if (items.length === 0) return undefined
  let best = items[0] as T
  let bestScore = scoreLoad(items[0]!.load)
  for (const item of items.slice(1)) {
    const score = scoreLoad(item.load)
    if (score < bestScore) {
      best = item
      bestScore = score
    }
  }
  return best
}
