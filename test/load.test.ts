import { describe, expect, test } from "bun:test"
import { pickLeastLoaded, scoreLoad } from "../src/placement/load"

describe("load scoring", () => {
  test("empty load scores 0", () => {
    expect(scoreLoad({})).toBe(0)
  })

  test("higher CPU dominates", () => {
    expect(scoreLoad({ cpuPct: 90 })).toBeGreaterThan(scoreLoad({ cpuPct: 10 }))
  })

  test("active drains add weight", () => {
    expect(scoreLoad({ activeDrains: 8 })).toBeGreaterThan(scoreLoad({ activeDrains: 0 }))
  })

  test("values clamp to [0,1]", () => {
    expect(scoreLoad({ cpuPct: 500 })).toBeLessThanOrEqual(1)
    expect(scoreLoad({ cpuPct: -10 })).toBeGreaterThanOrEqual(0)
  })
})

describe("least-loaded picker", () => {
  const make = (id: string, cpuPct: number) => ({ id, load: { cpuPct } })
  test("picks the least loaded", () => {
    const picked = pickLeastLoaded([make("a", 90), make("b", 10), make("c", 50)])
    expect(picked?.id).toBe("b")
  })
  test("returns undefined for empty input", () => {
    expect(pickLeastLoaded([])).toBeUndefined()
  })
  test("single item wins", () => {
    expect(pickLeastLoaded([make("a", 99)])?.id).toBe("a")
  })
})
