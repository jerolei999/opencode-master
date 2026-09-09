/** Minimal path-param router (no framework deps). */

export type Handler = (req: Request, params: Record<string, string>) => Promise<Response> | Response

type Route = {
  method: string
  segments: string[]
  names: string[]
  handler: Handler
}

export class Router {
  private routes: Route[] = []

  add(method: string, path: string, handler: Handler): void {
    const parts = path.split("/").filter(Boolean)
    const names = parts.filter((p) => p.startsWith(":")).map((p) => p.slice(1))
    const segments = parts.map((p) => (p.startsWith(":") ? "*" : p))
    this.routes.push({ method, segments, names, handler })
  }

  async route(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url)
    const parts = url.pathname.split("/").filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== req.method) continue
      if (route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let matched = true
      let paramIndex = 0
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i] as string
        const part = parts[i] as string
        if (segment === "*") {
          params[route.names[paramIndex] as string] = decodeURIComponent(part)
          paramIndex++
        } else if (segment !== part) {
          matched = false
          break
        }
      }
      if (!matched) continue
      return route.handler(req, params)
    }
    return undefined
  }
}
