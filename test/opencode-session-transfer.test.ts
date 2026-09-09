import { expect, test } from "bun:test"
import { assertTransferReport, parseCliJson, transcriptFingerprint, transcriptHasMessages, type TransferReport } from "../scripts/probe-opencode-session-transfer"

test("requires an imported session ID and matching transcript", () => {
  const report: TransferReport = {
    sourceSessionID: "ses_source",
    importedSessionID: "",
    historyMatches: true,
    questionReplySupported: false,
  }
  expect(() => assertTransferReport(report)).toThrow("not safe for failover")
})

test("accepts an imported session whose transcript is intact", () => {
  const report: TransferReport = {
    sourceSessionID: "ses_source",
    importedSessionID: "ses_imported",
    historyMatches: true,
    questionReplySupported: false,
  }
  expect(assertTransferReport(report)).toBeUndefined()
})

test("parses OpenCode JSON after its export progress line", () => {
  expect(parseCliJson<{ info: { id: string } }>('Exporting session: ses_1\n{"info":{"id":"ses_1"}}')).toEqual({ info: { id: "ses_1" } })
})

test("compares transcript messages without worker-local session metadata", () => {
  const source = '{"info":{"directory":"/worker-a","id":"ses_1"},"messages":[{"id":"m1","text":"keep context"}]}'
  const imported = '{"info":{"directory":"/worker-b","id":"ses_1"},"messages":[{"id":"m9","text":"keep context"}]}'
  expect(transcriptFingerprint(source)).toBe(transcriptFingerprint(imported))
})

test("does not accept an export that omits all conversation messages", () => {
  expect(transcriptHasMessages('{"info":{"id":"ses_1"},"messages":[]}')).toBe(false)
  expect(transcriptHasMessages('{"messages":[{"text":"keep context"}]}')).toBe(true)
})
