import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileSessionSnapshotStore, OpenCodeSessionSnapshotter, UnsafeSnapshotPointError } from "../src/worker/session-snapshot"

test("stores an exported session only at a safe point", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-snapshot-"))
  const store = new FileSessionSnapshotStore(root)
  const calls: string[][] = []
  const snapshotter = new OpenCodeSessionSnapshotter({
    binary: "opencode",
    dataDir: root,
    store,
    run: async (args) => { calls.push(args); return JSON.stringify({ messages: [{ role: "user", content: "hello" }] }) },
  })

  await expect(snapshotter.export("ses_1", "running" as never)).rejects.toBeInstanceOf(UnsafeSnapshotPointError)
  const snapshot = await snapshotter.export("ses_1", "idle")

  expect(snapshot.sessionID).toBe("ses_1")
  expect(calls).toEqual([["export", "ses_1"]])
  expect(await readFile(join(root, "ses_1.json"), "utf8")).toContain("hello")
  await rm(root, { recursive: true, force: true })
})

test("returns no restore when a snapshot is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-snapshot-empty-"))
  const snapshotter = new OpenCodeSessionSnapshotter({ binary: "opencode", dataDir: root, store: new FileSessionSnapshotStore(root), run: async () => "" })
  expect(await snapshotter.restore("ses_missing")).toBeUndefined()
  await rm(root, { recursive: true, force: true })
})
