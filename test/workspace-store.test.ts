import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalWorkspaceStore, WorkspaceManifestStore, WorkspacePathError, WorkspaceVersionConflictError } from "../src/workspace/local-store"

test("stores workspace objects by digest and rejects path escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-workspace-"))
  const store = new LocalWorkspaceStore(root)
  const ref = await store.put("ws_1", "src/main.ts", new TextEncoder().encode("export const ok = true"), "text/typescript")

  expect(ref.path).toBe("src/main.ts")
  expect(ref.digest).toMatch(/^[a-f0-9]{64}$/)
  expect(new TextDecoder().decode(await store.get("ws_1", "src/main.ts"))).toBe("export const ok = true")
  expect((await store.list("ws_1")).map((item) => item.path)).toEqual(["src/main.ts"])
  await expect(store.put("ws_1", "../escape", new Uint8Array([1]))).rejects.toBeInstanceOf(WorkspacePathError)
})

test("commits immutable manifests and fences concurrent writers by parent version", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-manifest-"))
  const store = new LocalWorkspaceStore(root)
  const manifests = new WorkspaceManifestStore(root, store)
  const ref = await store.put("ws_1", "README.md", new TextEncoder().encode("hello"))
  const first = await manifests.commit("ws_1", undefined, [ref])
  const second = await manifests.commit("ws_1", first.version, [ref])

  expect(second.parentVersion).toBe(first.version)
  expect((await manifests.head("ws_1"))?.version).toBe(second.version)
  await expect(manifests.commit("ws_1", first.version, [ref])).rejects.toBeInstanceOf(WorkspaceVersionConflictError)
  expect(JSON.parse(await readFile(join(root, "manifests", "ws_1", `${second.version}.json`), "utf8")).objects[0].digest).toBe(ref.digest)
})
