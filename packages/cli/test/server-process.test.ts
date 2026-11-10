import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
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

// The service-mode incumbent decision (code#8255): a deliberate `serve --service` start must
// never silently defer to a different build, because that made version switches no-ops that
// reported success.
describe("incumbentDecision", () => {
  test("no incumbent proceeds to bind", () => {
    expect(ServerProcess.incumbentDecision(undefined, "2.0.0-new")).toEqual({ _tag: "proceed" })
  })

  // Service.incumbent returns undefined when the registration is missing or unreadable and
  // when the probe cannot classify the registered process. That is "no incumbent", not a
  // takeover and not a defer: the start proceeds to bind and the addressInUse retry loop in
  // server-process remains the backstop if something else actually owns the port.
  test("an unreadable registration or unclassifiable probe proceeds to bind", () => {
    expect(ServerProcess.incumbentDecision(undefined, "2.0.0-new")).toEqual({ _tag: "proceed" })
  })

  test("same-version incumbent is an explicit already-current return", () => {
    expect(ServerProcess.incumbentDecision({ version: "2.0.0-new", pid: 4242 }, "2.0.0-new")).toEqual({
      _tag: "already-current",
      version: "2.0.0-new",
      pid: 4242,
    })
  })

  test("different-version incumbent is a takeover", () => {
    expect(ServerProcess.incumbentDecision({ version: "2.0.0-old", pid: 4242 }, "2.0.0-new")).toEqual({
      _tag: "takeover",
      version: "2.0.0-old",
      pid: 4242,
    })
  })

  test("an incumbent whose version cannot be read is not assumed current", () => {
    expect(ServerProcess.incumbentDecision({ pid: 4242 }, "2.0.0-new")).toEqual({
      _tag: "takeover",
      version: undefined,
      pid: 4242,
    })
  })
})

describe("takeoverIncumbent", () => {
  test("invokes the handoff stop and then proceeds", async () => {
    const stopped: string[] = []
    const logs: string[] = []
    const original = console.log
    console.log = (line: string) => logs.push(line)
    try {
      await Effect.runPromise(
        ServerProcess.takeoverIncumbent(
          { version: "2.0.0-old", pid: 4242 },
          Effect.sync(() => stopped.push("handoff")),
          "2.0.0-new",
        ),
      )
    } finally {
      console.log = original
    }
    expect(stopped).toEqual(["handoff"])
    expect(logs.join("\n")).toContain("2.0.0-old")
    expect(logs.join("\n")).toContain("4242")
    expect(logs.join("\n")).toContain("taking over with version 2.0.0-new")
  })

  test("a failed stop is a loud failure, never a silent exit", async () => {
    const original = console.log
    console.log = () => {}
    try {
      await expect(
        Effect.runPromise(
          ServerProcess.takeoverIncumbent(
            { version: "2.0.0-old", pid: 4242 },
            Effect.fail(new Error("still running")),
            "2.0.0-new",
          ),
        ),
      ).rejects.toThrow(
        "Failed to stop managed service version 2.0.0-old (pid 4242) so version 2.0.0-new could take over",
      )
    } finally {
      console.log = original
    }
  })
})
