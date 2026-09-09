import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalWorkspaceStore, WorkspaceManifestStore } from "../src/workspace/local-store"
import { WorkspaceSync } from "../src/workspace/sync"

test("hydrates a manifest into a fresh compute directory and commits the next version", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-sync-"))
  const compute = await mkdtemp(join(tmpdir(), "opencode-compute-"))
  const store = new LocalWorkspaceStore(root)
  const manifests = new WorkspaceManifestStore(root, store)
  const sync = new WorkspaceSync(store, manifests)
  const ref = await store.put("ws_1", "src/app.ts", new TextEncoder().encode("export const v = 1"))
  const first = await manifests.commit("ws_1", undefined, [ref])

  await sync.hydrate("ws_1", first.version, compute)
  expect(await readFile(join(compute, "src/app.ts"), "utf8")).toBe("export const v = 1")
  await writeFile(join(compute, "src/app.ts"), "export const v = 2")
  const second = await sync.commit("ws_1", first.version, compute)

  expect(second.parentVersion).toBe(first.version)
  expect((await store.get("ws_1", "src/app.ts"))).toEqual(new TextEncoder().encode("export const v = 2"))
})
