import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type SnapshotSafePoint = "idle" | "waiting_input"
export type SessionSnapshot = {
  sessionID: string
  safePoint: SnapshotSafePoint
  exportedAt: number
  payload: string
}

export class UnsafeSnapshotPointError extends Error {}

export interface SessionSnapshotStore {
  save(snapshot: SessionSnapshot): Promise<void>
  load(sessionID: string): Promise<SessionSnapshot | undefined>
}

function safeSessionID(sessionID: string): string {
  if (!sessionID || sessionID === "." || sessionID === ".." || sessionID.includes("/") || sessionID.includes("\\") || sessionID.includes("\0")) throw new Error(`invalid session id: ${sessionID}`)
  return sessionID
}

export class FileSessionSnapshotStore implements SessionSnapshotStore {
  constructor(private readonly root: string) {}

  private path(sessionID: string): string { return join(this.root, `${safeSessionID(sessionID)}.json`) }

  async save(snapshot: SessionSnapshot): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const target = this.path(snapshot.sessionID)
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 })
    await rename(temporary, target)
  }

  async load(sessionID: string): Promise<SessionSnapshot | undefined> {
    try { return JSON.parse(await readFile(this.path(sessionID), "utf8")) as SessionSnapshot } catch { return undefined }
  }
}

type SnapshotRunner = (args: string[]) => Promise<string>

export type OpenCodeSessionSnapshotterOptions = {
  binary: string
  dataDir: string
  store: SessionSnapshotStore
  run?: SnapshotRunner
  now?: () => number
}

function parseImportedSessionID(output: string): string | undefined {
  const start = output.search(/[\[{]/)
  if (start < 0) return undefined
  try {
    const value = JSON.parse(output.slice(start)) as { id?: unknown; sessionID?: unknown; sessionId?: unknown }
    for (const key of ["id", "sessionID", "sessionId"] as const) if (typeof value[key] === "string" && value[key]) return value[key]
  } catch {
    // Some OpenCode versions print human text around the import result. The
    // absence of a stable ID is a capability miss, not a fatal Worker error.
  }
  return undefined
}

export class OpenCodeSessionSnapshotter {
  private readonly runCommand: SnapshotRunner
  private readonly now: () => number

  constructor(private readonly options: OpenCodeSessionSnapshotterOptions) {
    this.runCommand = options.run ?? (async (args) => {
      const result = Bun.spawnSync([options.binary, ...args], {
        env: { ...process.env, XDG_DATA_HOME: options.dataDir },
        stdout: "pipe",
        stderr: "pipe",
      })
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim() || `opencode ${args[0]} failed`)
      return new TextDecoder().decode(result.stdout)
    })
    this.now = options.now ?? Date.now
  }

  async export(sessionID: string, safePoint: SnapshotSafePoint): Promise<SessionSnapshot> {
    if (safePoint !== "idle" && safePoint !== "waiting_input") throw new UnsafeSnapshotPointError(`cannot snapshot session ${sessionID} at ${safePoint}`)
    const payload = await this.runCommand(["export", sessionID])
    const snapshot: SessionSnapshot = { sessionID, safePoint, exportedAt: this.now(), payload }
    await this.options.store.save(snapshot)
    return snapshot
  }

  async restore(sessionID: string): Promise<{ snapshot: SessionSnapshot; importedSessionID: string } | undefined> {
    const snapshot = await this.options.store.load(sessionID)
    if (!snapshot) return undefined
    const path = join(this.options.dataDir, `.snapshot-${safeSessionID(sessionID)}-${process.pid}.json`)
    await mkdir(this.options.dataDir, { recursive: true })
    try {
      await writeFile(path, snapshot.payload, { encoding: "utf8", mode: 0o600 })
      const output = await this.runCommand(["import", path])
      const importedSessionID = parseImportedSessionID(output)
      return importedSessionID ? { snapshot, importedSessionID } : undefined
    } finally {
      await rm(path, { force: true })
    }
  }
}
