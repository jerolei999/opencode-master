/**
 * Export the local opencode credentials as OPENCODE_AUTH_CONTENT JSON.
 *
 * Real-scenario wiring: each slave injects per-user provider credentials via
 * the OPENCODE_AUTH_CONTENT env var (opencode's native injection channel).
 * The source of truth here is the machine's opencode auth store
 * (~/.local/share/opencode/auth.json); in production this would come from a
 * secret manager, filtered per tenant/user.
 *
 * Usage (slave):
 *   --auth-content "$(bun run scripts/export-auth.ts [--provider openai])"
 *
 * Output: JSON of { "<providerID>": { "type": "api", "key": "..." } }
 */

import { existsSync, readFileSync } from "node:fs"

const AUTH_FILE =
  process.env["OPENCODE_AUTH_FILE"] ?? `${process.env["HOME"]}/.local/share/opencode/auth.json`

const args = process.argv.slice(2)
const providerFilter = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : undefined

function main() {
  if (!existsSync(AUTH_FILE)) {
    console.error(`[export-auth] no auth store at ${AUTH_FILE}`)
    process.exit(1)
  }
  const data = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [provider, info] of Object.entries(data)) {
    if (providerFilter && provider !== providerFilter) continue
    if (!info || typeof info !== "object") continue
    const record = info as Record<string, unknown>
    if (record["type"] === "api" && typeof record["key"] === "string") {
      out[provider] = { type: "api", key: record["key"] }
    }
  }
  if (Object.keys(out).length === 0) {
    console.error("[export-auth] no api-type credentials found")
    process.exit(1)
  }
  process.stdout.write(JSON.stringify(out))
}

main()
