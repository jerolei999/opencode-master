import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import type { WorkspaceManifestRepository, WorkspaceObject, WorkspaceStore, WorkspaceVersion } from "./store"
import { normalizePath } from "./local-store"

async function files(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const full = join(current, entry.name)
    if (entry.isDirectory()) result.push(...await files(root, full))
    else if (entry.isFile()) result.push(full)
  }
  return result
}

export class WorkspaceSync {
  constructor(private store: WorkspaceStore, private manifests: WorkspaceManifestRepository) {}

  async hydrate(workspaceID: string, version: string, targetDir: string): Promise<WorkspaceVersion> {
    const manifest = await this.manifests.read(workspaceID, version)
    if (!manifest) throw new Error(`workspace manifest not found: ${workspaceID}/${version}`)
    for (const object of manifest.objects) {
      const target = join(targetDir, ...normalizePath(object.path).split("/"))
      await mkdir(join(target, ".."), { recursive: true })
      await writeFile(target, await this.store.get(workspaceID, object.path))
    }
    return manifest
  }

  async commit(workspaceID: string, parentVersion: string | undefined, sourceDir: string): Promise<WorkspaceVersion> {
    const refs: WorkspaceObject[] = []
    for (const fullPath of await files(sourceDir)) {
      const rel = normalizePath(relative(sourceDir, fullPath).split(sep).join("/"))
      refs.push(await this.store.put(workspaceID, rel, new Uint8Array(await readFile(fullPath))))
    }
    return this.manifests.commit(workspaceID, parentVersion, refs)
  }
}
