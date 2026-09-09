/**
 * Consistent hashing ring (user → candidate slaves).
 * Design §M2: userID affinity via consistent hash + load-aware selection
 * among the ring candidates. Pure functions, unit-testable.
 */

export type RingNode = { point: number; slaveID: string }

/**
 * 32-bit hash — FNV-1a with a MurmurHash3 fmix32 avalanche finalizer.
 * Plain FNV-1a clusters badly on short similar strings (measured 8-32% ring
 * skew); the finalizer fixes the avalanche so vnode distribution is uniform.
 */
export function hashString(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

export const DEFAULT_VNODES = 96

export function buildRing(entries: Array<{ id: string; weight?: number }>, vnodes = DEFAULT_VNODES): RingNode[] {
  const nodes: RingNode[] = []
  for (const entry of entries) {
    const count = Math.max(1, Math.round(vnodes * (entry.weight ?? 1)))
    for (let i = 0; i < count; i++) {
      nodes.push({ point: hashString(`${entry.id}:${i}`), slaveID: entry.id })
    }
  }
  nodes.sort((a, b) => a.point - b.point)
  return nodes
}

/**
 * Return up to `count` distinct slave IDs for `key`, walking the ring
 * clockwise from hash(key). `alive` filters candidates (e.g. healthy only).
 */
export function candidates(
  ring: RingNode[],
  key: string,
  count: number,
  alive?: (slaveID: string) => boolean,
): string[] {
  if (ring.length === 0) return []
  const target = hashString(key)
  let lo = 0
  let hi = ring.length - 1
  let idx = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((ring[mid] as RingNode).point >= target) {
      idx = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < ring.length && out.length < count; i++) {
    const node = ring[(idx + i) % ring.length] as RingNode
    if (seen.has(node.slaveID)) continue
    seen.add(node.slaveID)
    if (alive && !alive(node.slaveID)) continue
    out.push(node.slaveID)
  }
  return out
}
