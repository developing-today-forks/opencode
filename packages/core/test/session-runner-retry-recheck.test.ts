import { describe, expect, test } from "bun:test"
import { SessionRunnerRetry } from "../src/session/runner/retry.js"

describe("SessionRunnerRetry.withRecheckFloor (#1806)", () => {
  const decision = { retry: true, attempt: 1, delay: 2_000 } as const
  test("raises the delay to the recheck instant", () => {
    const now = 1_000_000
    expect(SessionRunnerRetry.withRecheckFloor(decision, now + 300_000, now).delay).toBe(300_000)
  })
  test("caps the wait at the retry-after bound", () => {
    const now = 1_000_000
    expect(SessionRunnerRetry.withRecheckFloor(decision, now + 10_000_000, now).delay).toBe(900_000)
  })
  test("leaves the decision alone when the instant is nearer, past, or absent", () => {
    const now = 1_000_000
    expect(SessionRunnerRetry.withRecheckFloor(decision, now + 1_000, now)).toBe(decision)
    expect(SessionRunnerRetry.withRecheckFloor(decision, now - 5_000, now)).toBe(decision)
    expect(SessionRunnerRetry.withRecheckFloor(decision, undefined, now)).toBe(decision)
  })
})
