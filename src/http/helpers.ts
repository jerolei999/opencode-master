/** HTTP helpers: JSON responses, errors, SSE framing. */

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

export function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status)
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await req.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

/** Encode one SSE frame. */
export function sseFrame(data: unknown, event?: string): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data)
  const lines = payload.split("\n")
  const body = lines.map((line) => `data: ${line}`).join("\n")
  return `${event ? `event: ${event}\n` : ""}${body}\n\n`
}
