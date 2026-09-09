import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type TransferReport = {
  sourceSessionID: string
  importedSessionID: string
  historyMatches: boolean
  questionReplySupported: boolean
  failure?: string
}

export function assertTransferReport(report: TransferReport): void {
  if (!report.importedSessionID || !report.historyMatches) throw new Error("OpenCode export/import is not safe for failover")
}

export function parseCliJson<T>(output: string): T {
  const start = output.search(/[\[{]/)
  if (start < 0) return [] as T
  return JSON.parse(output.slice(start)) as T
}

type CliOptions = { binary: string; dataDir: string }

function runCli(options: CliOptions, args: string[]): string {
  const result = Bun.spawnSync([options.binary, ...args], {
    env: { ...process.env, XDG_DATA_HOME: options.dataDir },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim() || `opencode ${args[0]} failed`)
  return new TextDecoder().decode(result.stdout)
}

function listSessionIDs(options: CliOptions): string[] {
  const raw = runCli(options, ["session", "list", "--format", "json"])
  const parsed = parseCliJson<Array<{ id?: string }>>(raw)
  return parsed.map((session) => session.id).filter((id): id is string => Boolean(id))
}

export function transcriptFingerprint(exported: string): string {
  const parsed = parseCliJson<{ messages?: unknown[] }>(exported)
  return JSON.stringify(parsed.messages ?? [], (key, value) => /^(id|time|created|updated|share)$/i.test(key) ? undefined : value)
}

export function transcriptHasMessages(exported: string): boolean {
  const parsed = parseCliJson<{ messages?: unknown[] }>(exported)
  return Array.isArray(parsed.messages) && parsed.messages.length > 0
}

export async function probeTransfer(input: { sourceSessionID: string; sourceDataDir: string; targetDataDir: string; binary?: string }): Promise<TransferReport> {
  const binary = input.binary ?? process.env["OPENCODE_BIN"] ?? "opencode"
  const source = { binary, dataDir: input.sourceDataDir }
  const target = { binary, dataDir: input.targetDataDir }
  const snapshotDir = mkdtempSync(join(tmpdir(), "opencode-transfer-probe-"))
  const snapshotPath = join(snapshotDir, "session.json")
  try {
    const sourceExport = runCli(source, ["export", input.sourceSessionID])
    await Bun.write(snapshotPath, sourceExport)
    const before = new Set(listSessionIDs(target))
    runCli(target, ["import", snapshotPath])
    const importedSessionID = listSessionIDs(target).find((id) => !before.has(id)) ?? ""
    const importedExport = importedSessionID ? runCli(target, ["export", importedSessionID]) : ""
    return {
      sourceSessionID: input.sourceSessionID,
      importedSessionID,
      historyMatches: transcriptHasMessages(sourceExport) && transcriptHasMessages(importedExport) && transcriptFingerprint(sourceExport) === transcriptFingerprint(importedExport),
      questionReplySupported: false,
      failure: "question reply requires a live two-server probe",
    }
  } catch (error) {
    return { sourceSessionID: input.sourceSessionID, importedSessionID: "", historyMatches: false, questionReplySupported: false, failure: (error as Error).message }
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const [sourceSessionID, sourceDataDir, targetDataDir] = process.argv.slice(2)
  if (!sourceSessionID || !sourceDataDir || !targetDataDir) throw new Error("usage: bun scripts/probe-opencode-session-transfer.ts <session-id> <source-xdg-data-dir> <target-xdg-data-dir>")
  const report = await probeTransfer({ sourceSessionID, sourceDataDir, targetDataDir })
  console.log(JSON.stringify(report))
  assertTransferReport(report)
}
