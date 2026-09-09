import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, posix } from "node:path"
import type { WorkspaceManifestRepository, WorkspaceObject, WorkspaceStore, WorkspaceVersion } from "./store"

export class WorkspacePathError extends Error {}
export class WorkspaceVersionConflictError extends Error {}

function normalizePath(relativePath: string): string {
  const candidate = relativePath.replaceAll("\\", "/")
  if (!candidate || candidate.startsWith("/") || candidate.includes("\0")) throw new WorkspacePathError(`workspace path must be relative: ${relativePath}`)
  const normalized = posix.normalize(candidate)
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new WorkspacePathError(`workspace path escapes root: ${relativePath}`)
  return normalized
}

function safeWorkspaceID(workspaceID: string): string {
  if (!workspaceID || workspaceID === "." || workspaceID === ".." || workspaceID.includes("/") || workspaceID.includes("\\") || workspaceID.includes("\0")) throw new WorkspacePathError(`invalid workspace id: ${workspaceID}`)
  return workspaceID
}

async function exists(path: string): Promise<boolean> {
  try { await readFile(path); return true } catch { return false }
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...await walk(root, path))
    else files.push(path)
  }
  return files
}

export class LocalWorkspaceStore implements WorkspaceStore {
  constructor(readonly root: string) {}

  private refsRoot(workspaceID: string): string { return join(this.root, "refs", safeWorkspaceID(workspaceID)) }
  private objectPath(digest: string): string { if (!/^[a-f0-9]{64}$/.test(digest)) throw new WorkspacePathError(`invalid object digest: ${digest}`); return join(this.root, "objects", digest) }
  private refPath(workspaceID: string, relativePath: string): string { return join(this.refsRoot(workspaceID), ...normalizePath(relativePath).split("/")) + ".json" }

  async put(workspaceID: string, relativePath: string, data: Uint8Array, contentType?: string): Promise<WorkspaceObject> {
    const path = normalizePath(relativePath)
    const digest = Bun.CryptoHasher.hash("sha256", data, "hex")
    const object: WorkspaceObject = { path, digest, size: data.byteLength, ...(contentType ? { contentType } : {}) }
    await mkdir(join(this.root, "objects"), { recursive: true })
    const objectPath = this.objectPath(digest)
    if (!await exists(objectPath)) await writeFile(objectPath, data)
    const refPath = this.refPath(workspaceID, path)
    await mkdir(join(refPath, ".."), { recursive: true })
    await writeFile(refPath, JSON.stringify(object), "utf8")
    return object
  }

  async get(workspaceID: string, relativePath: string): Promise<Uint8Array> {
    const ref = JSON.parse(await readFile(this.refPath(workspaceID, relativePath), "utf8")) as WorkspaceObject
    return new Uint8Array(await readFile(this.objectPath(ref.digest)))
  }

  async list(workspaceID: string): Promise<WorkspaceObject[]> {
    const root = this.refsRoot(workspaceID)
    const files = (await walk(root)).filter((file) => file.endsWith(".json"))
    const objects = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8")) as WorkspaceObject))
    return objects.sort((a, b) => a.path.localeCompare(b.path))
  }

  async delete(workspaceID: string, relativePath: string): Promise<void> {
    await rm(this.refPath(workspaceID, relativePath), { force: true })
  }
}

export class LocalWorkspaceManifestStore implements WorkspaceManifestRepository {
  constructor(private root: string, private objects: WorkspaceStore, private now: () => number = Date.now) {}

  private manifestRoot(workspaceID: string): string { return join(this.root, "manifests", safeWorkspaceID(workspaceID)) }
  private manifestPath(workspaceID: string, version: string): string { return join(this.manifestRoot(workspaceID), `${version}.json`) }
  private headPath(workspaceID: string): string { return join(this.manifestRoot(workspaceID), "HEAD") }

  async read(workspaceID: string, version: string): Promise<WorkspaceVersion | undefined> {
    try { return JSON.parse(await readFile(this.manifestPath(workspaceID, version), "utf8")) as WorkspaceVersion } catch { return undefined }
  }

  async head(workspaceID: string): Promise<WorkspaceVersion | undefined> {
    try {
      const version = (await readFile(this.headPath(workspaceID), "utf8")).trim()
      return version ? this.read(workspaceID, version) : undefined
    } catch { return undefined }
  }

  async commit(workspaceID: string, parentVersion: string | undefined, objects: WorkspaceObject[]): Promise<WorkspaceVersion> {
    const current = await this.head(workspaceID)
    if ((current?.version ?? undefined) !== parentVersion) throw new WorkspaceVersionConflictError(`workspace ${workspaceID} head changed`)
    const createdAt = this.now()
    const ordered = [...objects].sort((a, b) => a.path.localeCompare(b.path))
    const descriptor = JSON.stringify({ workspaceID, parentVersion, objects: ordered })
    const version = Bun.CryptoHasher.hash("sha256", descriptor, "hex")
    const value: WorkspaceVersion = { workspaceID, version, ...(parentVersion ? { parentVersion } : {}), objects: ordered, createdAt }
    await mkdir(this.manifestRoot(workspaceID), { recursive: true })
    await writeFile(this.manifestPath(workspaceID, version), JSON.stringify(value), "utf8")
    await writeFile(this.headPath(workspaceID), version, "utf8")
    return value
  }
}

export { LocalWorkspaceManifestStore as WorkspaceManifestStore }

export { normalizePath }
