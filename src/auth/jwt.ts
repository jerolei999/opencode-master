/** Minimal HS256 JWT (RFC 7519) built on WebCrypto — no external dependency. */

const encoder = new TextEncoder()

function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function base64urlDecode(input: string): Uint8Array {
  const b64 = input.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(input.length / 4) * 4, "=")
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function hmacSha256(data: Uint8Array, secret: string): Promise<Uint8Array> {
  const keyData = new Uint8Array(encoder.encode(secret))
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, new Uint8Array(data))
  return new Uint8Array(sig)
}

export async function signJWT(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" }
  const now = Math.floor(Date.now() / 1000)
  const body = { ...payload, iat: now, exp: now + ttlSeconds }
  const head = base64url(JSON.stringify(header))
  const pay = base64url(JSON.stringify(body))
  const signingInput = `${head}.${pay}`
  const sig = await hmacSha256(encoder.encode(signingInput), secret)
  return `${signingInput}.${base64url(sig)}`
}

export async function verifyJWT(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [head, pay, sig] = parts as [string, string, string]
  const expected = await hmacSha256(encoder.encode(`${head}.${pay}`), secret)
  const provided = base64urlDecode(sig)
  if (expected.length !== provided.length) return null
  for (let i = 0; i < expected.length; i++) if (expected[i] !== provided[i]) return null

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(pay))) as Record<string, unknown>
    if (typeof payload.exp !== "number") return null
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export function sha256Hex(input: string): string {
  return Bun.CryptoHasher.hash("sha256", input, "hex")
}
