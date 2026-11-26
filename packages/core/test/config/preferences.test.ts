import { describe, expect } from "bun:test"
import { Effect, Layer, Logger, Stream } from "effect"
import { AppProcess } from "@opencode/util/process"
import { ConfigDiscovery } from "@opencode/core/config/discovery"
import { AbsolutePath } from "@opencode/core/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const plist = AbsolutePath.make("/Library/Managed Preferences/ai.opencode.managed.plist")

function processes(stdout: string, exitCode = 0, failure = false) {
  return AppProcess.Service.of({
    spawn: () => Effect.die("unexpected spawn"),
    exitCode: () => Effect.die("unexpected exitCode"),
    streamString: () => Stream.die("unexpected streamString"),
    streamLines: () => Stream.die("unexpected streamLines"),
    lines: () => Effect.die("unexpected lines"),
    string: () => Effect.die("unexpected string"),
    runStream: () => Stream.die("unexpected runStream"),
    run: (command, options) => {
      expect(command._tag).toBe("StandardCommand")
      if (command._tag !== "StandardCommand") return Effect.die("unexpected pipeline")
      expect(command.command).toBe("plutil")
      expect(command.args).toEqual(["-convert", "json", "-o", "-", plist])
      expect(options?.timeout).toBe("10 seconds")
      if (failure) return Effect.fail(new AppProcess.AppProcessError({ command: "plutil" }))
      return Effect.succeed({
        command: "plutil",
        exitCode,
        stdout: Buffer.from(stdout),
        stderr: Buffer.alloc(0),
        stdoutTruncated: false,
        stderrTruncated: false,
      })
    },
  })
}

describe("managed preferences conversion", () => {
  for (const [name, stdout, exitCode, failure] of [
    ["non-JSON stdout", "not json", 0, false],
    ["empty stdout", "", 0, false],
    ["truncated JSON stdout", "{\npartial", 0, false],
    ["nonzero exit", '{"share":"disabled"}', 1, false],
    ["process failure or timeout", "", 0, true],
  ] as const) {
    it.effect(`warns and skips ${name}`, () => {
      const output: unknown[] = []
      const logger = Logger.map(Logger.formatStructured, (entry) => output.push(entry.message))
      return Effect.gen(function* () {
        // Oracle: every unsuccessful conversion supplies no preferences and one source-aware warning.
        expect(yield* ConfigDiscovery.readPreferences(plist)).toBeUndefined()
        expect(output).toEqual([["failed to convert managed preferences", { source: plist }]])
      }).pipe(
        Effect.provideService(AppProcess.Service, processes(stdout, exitCode, failure)),
        Effect.provide(Logger.layer([logger])),
      )
    })
  }

  it.effect("loads valid preferences without MDM metadata or warnings", () => {
    const output: unknown[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => output.push(entry.message))
    return Effect.gen(function* () {
      expect(yield* ConfigDiscovery.readPreferences(plist)).toBe('{"share":"disabled"}')
      expect(output).toEqual([])
    }).pipe(
      Effect.provideService(
        AppProcess.Service,
        processes('{"PayloadIdentifier":"ai.opencode.managed","share":"disabled"}'),
      ),
      Effect.provide(Logger.layer([logger])),
    )
  })
})
