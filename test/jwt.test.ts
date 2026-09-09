import { describe, expect, test } from "bun:test"
import { signJWT, verifyJWT } from "../src/auth/jwt"

const secret = "test-secret"
const payload = { sub: "user-1", tenant: "t1", role: "user" }

describe("HS256 JWT", () => {
  test("sign and verify roundtrip", async () => {
    const token = await signJWT(payload, secret, 3600)
    const decoded = await verifyJWT(token, secret)
    expect(decoded).not.toBeNull()
    expect(decoded?.["sub"]).toBe("user-1")
    expect(decoded?.["role"]).toBe("user")
  })

  test("rejects wrong secret", async () => {
    const token = await signJWT(payload, secret, 3600)
    expect(await verifyJWT(token, "other-secret")).toBeNull()
  })

  test("rejects tampered payload", async () => {
    const token = await signJWT(payload, secret, 3600)
    const [head, , sig] = token.split(".")
    const forged = `${head}.${Buffer.from(JSON.stringify({ ...payload, role: "admin" })).toString("base64url")}.${sig}`
    expect(await verifyJWT(forged, secret)).toBeNull()
  })

  test("rejects expired token", async () => {
    const token = await signJWT(payload, secret, -10)
    expect(await verifyJWT(token, secret)).toBeNull()
  })

  test("rejects malformed token", async () => {
    expect(await verifyJWT("not-a-jwt", secret)).toBeNull()
    expect(await verifyJWT("a.b", secret)).toBeNull()
  })
})
