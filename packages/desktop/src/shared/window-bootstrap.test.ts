import { describe, expect, test } from "bun:test"
import { windowBootstrapArgument, windowBootstrapFromArguments } from "./window-bootstrap"

describe("window bootstrap", () => {
  test("round-trips through argv and keeps unknown values absent", () => {
    const bootstrap = { id: "win a/b ü", firstLaunchPending: false, packaged: true }
    expect(windowBootstrapFromArguments(["electron", windowBootstrapArgument(bootstrap)])).toEqual(bootstrap)
    // Absent means "ask over IPC", so a value must not appear on the way through.
    expect(windowBootstrapFromArguments([windowBootstrapArgument({ id: "x" })])).toEqual({ id: "x" })
  })

  test("returns undefined instead of throwing when the argument is missing or malformed", () => {
    // Missing entirely, and present but empty.
    expect(windowBootstrapFromArguments(["electron"])).toBeUndefined()
    expect(windowBootstrapFromArguments(["--opencode-window="])).toBeUndefined()
    // Truncated UTF-8 and bad percent escapes make decodeURIComponent throw.
    expect(windowBootstrapFromArguments(["--opencode-window=%E0%A4%A"])).toBeUndefined()
    expect(windowBootstrapFromArguments(["--opencode-window=%ZZ"])).toBeUndefined()
    // Decodes cleanly but does not parse as JSON.
    expect(windowBootstrapFromArguments(["--opencode-window=%7B"])).toBeUndefined()
  })

  test("returns undefined for valid JSON that is not a window bootstrap", () => {
    const arg = (value: string) => `--opencode-window=${encodeURIComponent(value)}`

    expect(windowBootstrapFromArguments([arg("42")])).toBeUndefined()
    expect(windowBootstrapFromArguments([arg("null")])).toBeUndefined()
    expect(windowBootstrapFromArguments([arg('"win"')])).toBeUndefined()
    expect(windowBootstrapFromArguments([arg("{}")])).toBeUndefined()
    expect(windowBootstrapFromArguments([arg('{"id":42}')])).toBeUndefined()
  })
})
