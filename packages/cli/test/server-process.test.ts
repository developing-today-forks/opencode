import { describe, expect, test } from "bun:test"
import { ServerProcess } from "../src/server-process"

// Mirrored in packages/client/test/service-timing.test.ts for serverShutdownGrace(), the client
// copy of this parser (#874): both copies read OPENCODE_SHUTDOWN_GRACE_MS and must agree on the
// grammar, so a case added here belongs there too.
describe("shutdownGrace", () => {
  test.each([
    // [OPENCODE_SHUTDOWN_GRACE_MS, expected grace in ms]
    [undefined, 30_000],
    ["", 30_000],
    [" ", 30_000],
    ["0", 0],
    ["5000", 5000],
    [" 5000 ", 5000],
    ["0x7530", 30_000],
    ["1e4", 30_000],
    ["+5000", 30_000],
    ["-5", 30_000],
    ["5000.0", 30_000],
    ["abc", 30_000],
  ])("OPENCODE_SHUTDOWN_GRACE_MS=%p -> %i", (value, expected) => {
    const previous = process.env.OPENCODE_SHUTDOWN_GRACE_MS
    if (value === undefined) delete process.env.OPENCODE_SHUTDOWN_GRACE_MS
    else process.env.OPENCODE_SHUTDOWN_GRACE_MS = value
    try {
      expect(ServerProcess.shutdownGrace()).toBe(expected)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_SHUTDOWN_GRACE_MS
      else process.env.OPENCODE_SHUTDOWN_GRACE_MS = previous
    }
  })
})
