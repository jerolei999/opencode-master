/**
 * Config sync — the "single source of config" for every slave (design §11).
 *
 * Problem: each slave runs an isolated opencode instance; AGENTS.md, skills,
 * MCP servers, provider/model definitions must be IDENTICAL across slaves.
 * opencode's native injection channels (zero source changes):
 *   - OPENCODE_CONFIG        → synced opencode.jsonc file (provider/model config)
 *   - OPENCODE_CONFIG_DIR    → directory holding agents/commands/plugins/skills
 *   - OPENCODE_AUTH_CONTENT  → per-tenant credentials JSON
 *   - SkillDiscovery.pull(url) → remote skill index (built-in)
 *
 * This module syncs a config repository into the slave's config directory,
 * computes a configVersion (content hash), and exposes the injected values
 * (model identity, skills, mcp count) to the executor so replies reflect the
 * injected configuration.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, rmSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

export type InjectedConfig = {
  /** Directory holding the config file and supplemental resources. */
  configDir: string
  /** Content hash of the synced config (reported in heartbeats). */
  configVersion: string
  /** Parsed model identity from config (for the executor). */
  model?: { provider: string; id: string }
  /** Skill names found in the config (for the executor). */
  skills: string[]
  /** Number of MCP server entries found in the config. */
  mcpCount: number
  /** Per-tenant credentials to inject via OPENCODE_AUTH_CONTENT. */
  authContent?: string
}

export type ConfigSyncOptions = {
  /** Local config repo directory, or a git URL (cloned on demand). */
  source: string
  /** Target config directory (defaults to <data>/config/<slaveId>). */
  targetDir: string
  /** Optional credentials JSON injected via OPENCODE_AUTH_CONTENT. */
  authContent?: string
}

const SKILL_DIR = "skills"

function hashDir(dir: string): string {
  const hash = createHash("sha256")
  const walk = (current: string, rel: string) => {
    const entries = readdirSync(current).sort()
    for (const entry of entries) {
      const full = path.join(current, entry)
      const childRel = rel ? `${rel}/${entry}` : entry
      const stat = statSync(full)
      if (stat.isDirectory()) {
        hash.update(`D:${childRel}\n`)
        walk(full, childRel)
      } else if (stat.isFile()) {
        hash.update(`F:${childRel}:${stat.size}:`)
        hash.update(readFileSync(full))
        hash.update("\n")
      }
    }
  }
  if (existsSync(dir)) walk(dir, "")
  return hash.digest("hex").slice(0, 16)
}

function isGitUrl(source: string): boolean {
  return /^(https?|git|ssh):\/\//.test(source) || source.endsWith(".git")
}

function resolveSource(source: string, targetDir: string): string {
  if (!isGitUrl(source)) return source
  // Clone the config repo into <targetDir>/.repo
  const repo = path.join(targetDir, ".config-repo")
  if (existsSync(path.join(repo, ".git"))) {
    spawnSync("git", ["-C", repo, "pull", "--ff-only"], { stdio: "ignore" })
  } else {
    rmSync(repo, { recursive: true, force: true })
    mkdirSync(path.dirname(repo), { recursive: true })
    const result = spawnSync("git", ["clone", "--depth", "1", source, repo], { stdio: "ignore" })
    if (result.status !== 0) throw new Error(`failed to clone config repo: ${source}`)
  }
  return repo
}

/**
 * Sync config from the repo into the slave's config directory and return the
 * injected view. Idempotent; copying only files changed (by hash) is enough —
 * opencode reloads AGENTS.md/skills lazily at the next safe boundary.
 */
export function syncConfig(options: ConfigSyncOptions): InjectedConfig {
  const resolved = resolveSource(options.source, options.targetDir)
  if (!existsSync(resolved)) {
    throw new Error(`config source does not exist: ${options.source}`)
  }
  mkdirSync(options.targetDir, { recursive: true })

  // Mirror the repo (excluding git metadata) into the target config dir.
  const entries = readdirSync(resolved).filter((name) => name !== ".git")
  for (const name of entries) {
    const from = path.join(resolved, name)
    const to = path.join(options.targetDir, name)
    const stat = statSync(from)
    if (stat.isDirectory()) {
      rmSync(to, { recursive: true, force: true })
      copyDir(from, to)
    } else if (stat.isFile()) {
      mkdirSync(path.dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
  }

  const configVersion = hashDir(options.targetDir)

  // Parse opencode.jsonc for the injected view (model / mcp / skills).
  // MCP v2 format: { mcp: { servers: { <name>: { type: "local"|"remote", ... } } } }
  const jsoncFile = ["opencode.jsonc", "opencode.json"].map((f) => path.join(options.targetDir, f)).find(existsSync)
  let model: InjectedConfig["model"]
  let mcpCount = 0
  let agents: Record<string, unknown> = {}
  if (jsoncFile) {
    try {
      const raw = readFileSync(jsoncFile, "utf8")
        .replace(/^\s*\/\/.*$/gm, "") // line comments only at line start (keep URLs)
        .replace(/\/\*[\s\S]*?\*\//g, "")
      const parsed = JSON.parse(raw) as { agent?: unknown; mcp?: { servers?: Record<string, unknown> }; model?: unknown }
      const servers = parsed.mcp?.servers
      if (servers && typeof servers === "object") mcpCount = Object.keys(servers).length
      const configuredModel = typeof parsed.model === "string" ? parseModelIdentity(parsed.model) : undefined
      if (configuredModel) model = configuredModel
      const agent = parsed.agent as Record<string, unknown> | undefined
      agents = agent ?? {}
    } catch {
      // non-fatal: keep defaults
    }
  }
  // model identity: prefer models.json, else the primary agent's model
  // (opencode's default agent is named "build", not "default")
  const primaryAgent =
    (agents["build"] ?? agents["default"]) as Record<string, unknown> | undefined
  model = model ?? readModelIdentity(path.join(options.targetDir, "models.json")) ?? {
    provider: "config-sync",
    id: primaryAgent && typeof primaryAgent === "object"
      ? String(primaryAgent["model"] ?? "injected-model")
      : "injected-model",
  }

  const skills = existsSync(path.join(options.targetDir, SKILL_DIR))
    ? readdirSync(path.join(options.targetDir, SKILL_DIR)).filter((name) => statSync(path.join(options.targetDir, SKILL_DIR, name)).isDirectory())
    : []

  return {
    configDir: options.targetDir,
    configVersion,
    model,
    skills,
    mcpCount,
    authContent: options.authContent,
  }
}

function parseModelIdentity(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) }
}

function readModelIdentity(modelsFile: string): { provider: string; id: string } | undefined {
  if (!existsSync(modelsFile)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(modelsFile, "utf8")) as { provider?: string; id?: string }
    if (parsed.provider && parsed.id) return { provider: parsed.provider, id: parsed.id }
  } catch {
    // ignore
  }
  return undefined
}

function copyDir(from: string, to: string) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const src = path.join(from, entry)
    const dst = path.join(to, entry)
    const stat = statSync(src)
    if (stat.isDirectory()) copyDir(src, dst)
    else copyFileSync(src, dst)
  }
}
