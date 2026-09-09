import { expect, test } from "bun:test"
import { loadConfig } from "../src/config"

test("session quota is unlimited by default", () => {
  expect(loadConfig({ OPENCODE_MASTER_ENV: "test" }).maxSessionsPerUser).toBe(0)
})

test("a positive session quota remains opt-in", () => {
  expect(loadConfig({ OPENCODE_MASTER_ENV: "test", OPENCODE_MASTER_MAX_SESSIONS_PER_USER: "3" }).maxSessionsPerUser).toBe(3)
})
