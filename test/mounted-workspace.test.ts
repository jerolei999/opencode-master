import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MountedWorkspaceAdapter, WorkspaceMountError } from "../src/workspace/mounted-adapter"

test("maps a workspace to a stable CubeFS directory without copying files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cubefs-mount-"))
  const adapter = new MountedWorkspaceAdapter({ root })

  const first = await adapter.prepare("ws_1")
  const second = await adapter.prepare("ws_1")

  expect(first).toBe(join(root, "ws_1"))
  expect(second).toBe(first)
  await rm(root, { recursive: true, force: true })
})

test("rejects a workspace when the configured CubeFS mount is unavailable", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "cubefs-mount-missing-")), "missing")
  const adapter = new MountedWorkspaceAdapter({ root, requireExistingMount: true })

  await expect(adapter.prepare("ws_1")).rejects.toBeInstanceOf(WorkspaceMountError)
})

test("supports an explicit mount readiness probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "cubefs-mount-probe-"))
  const adapter = new MountedWorkspaceAdapter({ root, isMounted: async () => false })

  await expect(adapter.prepare("ws_1")).rejects.toBeInstanceOf(WorkspaceMountError)
  await mkdir(root, { recursive: true })
  await rm(root, { recursive: true, force: true })
})
