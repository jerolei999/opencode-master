import { describe, expect, test } from "bun:test"
import { buildRing, candidates, hashString } from "../src/placement/consistent-hash"

const ids = ["slave-1", "slave-2", "slave-3", "slave-4", "slave-5"]

describe("consistent hash ring", () => {
  test("same key always maps to the same candidates", () => {
    const ring = buildRing(ids.map((id) => ({ id })))
    for (let i = 0; i < 100; i++) {
      const key = `user-${i}`
      const a = candidates(ring, key, 3)
      const b = candidates(ring, key, 3)
      expect(a).toEqual(b)
      expect(a.length).toBe(3)
    }
  })

  test("candidates are distinct and wrap around the ring", () => {
    const ring = buildRing(ids.map((id) => ({ id })))
    for (let i = 0; i < 200; i++) {
      const got = candidates(ring, `key-${i}`, ids.length + 5)
      expect(new Set(got).size).toBe(ids.length)
    }
  })

  test("removing one slave reshuffles only a fraction of keys (minimal disruption)", () => {
    const full = buildRing(ids.map((id) => ({ id })))
    const reduced = buildRing(ids.slice(0, 4).map((id) => ({ id })))
    let changed = 0
    const total = 2000
    for (let i = 0; i < total; i++) {
      const key = `user-${i}`
      const before = candidates(full, key, 3)[0]
      const after = candidates(reduced, key, 3)[0]
      if (before !== after) changed++
    }
    // With 96 vnodes per slave, removing 1 of 5 should affect roughly 20% of keys.
    expect(changed / total).toBeLessThan(0.45)
  })

  test("dead filter excludes unhealthy slaves", () => {
    const ring = buildRing(ids.map((id) => ({ id })))
    const alive = new Set(["slave-2", "slave-3", "slave-4", "slave-5"])
    for (let i = 0; i < 100; i++) {
      const got = candidates(ring, `u-${i}`, 3, (id) => alive.has(id))
      expect(got.every((id) => alive.has(id))).toBe(true)
    }
  })

  test("hashString is deterministic and spread", () => {
    const a = hashString("hello")
    const b = hashString("hello")
    expect(a).toBe(b)
    const seen = new Set<number>()
    for (let i = 0; i < 500; i++) seen.add(hashString(`k-${i}`))
    expect(seen.size).toBe(500)
  })
})
