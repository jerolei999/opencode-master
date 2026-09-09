import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MountedWorkspaceAdapter } from "../src/workspace/mounted-adapter"
import { WorkspaceRuntime } from "../src/worker/workspace-runtime"

test("prepares one stable mounted directory per workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "cubefs-runtime-"))
  const runtime = new WorkspaceRuntime(new MountedWorkspaceAdapter({ root }))

  const first = await runtime.prepare("ws_1")
  const second = await runtime.prepare("ws_1")
  const other = await runtime.prepare("ws_2")

  expect(second).toBe(first)
  expect(other).not.toBe(first)
  expect(runtime.pathFor("ws_1")).toBe(first)
  await rm(root, { recursive: true, force: true })
})
