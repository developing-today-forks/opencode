import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Directory } from "@opencode/schema/config"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Config } from "@opencode/core/config"
import { ConfigToolPlugin } from "@opencode/core/config/plugin/tool"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Tool } from "@opencode/core/tool"
import { AbsolutePath } from "@opencode/core/schema"
import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import { Effect, Fiber } from "effect"
import { tmpdir } from "../fixture/tmpdir"
import { it } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

// Tool files import `tool()` from "@opencode-ai/plugin"; the CLI entrypoint
// installs the host runtime that provides that specifier, so tests do too.
ensurePluginRuntime()

const echotest = `
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Echo test tool: returns its arguments verbatim as JSON.",
  args: {
    text: tool.schema.string().describe("Text to echo back verbatim"),
    count: tool.schema.number().describe("A number to echo back"),
    flag: tool.schema.boolean().describe("A boolean to echo back"),
  },
  async execute(args) {
    return JSON.stringify({ echoed: args })
  },
})
`

const math = `
import { tool } from "@opencode-ai/plugin"

export const add = tool({
  description: "Add two numbers",
  args: {
    a: tool.schema.number(),
    b: tool.schema.number(),
  },
  async execute(args) {
    return (args.a + args.b).toString()
  },
})

export function helper() {
  return "not a tool"
}
`

const contextProbe = `
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Report the calling context",
  args: {},
  async execute(args, context) {
    return JSON.stringify({
      sessionID: context.sessionID,
      agent: context.agent,
      directory: context.directory,
      abortIsSignal: context.abort instanceof AbortSignal,
      abortAborted: context.abort.aborted,
    })
  },
})
`

const writeTools = (root: string, files: Record<string, string>) =>
  Effect.promise(async () => {
    const directory = path.join(root, "tool")
    await fs.mkdir(directory, { recursive: true })
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(directory, name), content)
  })

const sessionID = Session.ID.make("ses_custom_tool_test")

describe("ConfigToolPlugin.Plugin", () => {
  it.live("discovers, registers, catalogs, and executes .opencode/tool files (#1703)", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* writeTools(tmp.path, {
            "echotest.ts": echotest,
            "math.ts": math,
            "contextprobe.ts": contextProbe,
            "broken.ts": `export default { description: 42, execute: async () => "nope" }`,
          })
          const config = yield* Config.Test
          const plugins = yield* Plugin.Service
          const tools = yield* Tool.Service
          yield* config.setEntries([new Directory({ type: "directory", path: AbsolutePath.make(tmp.path) })])
          yield* ConfigToolPlugin.Plugin.effect(yield* PluginHost.make(plugins))

          const names = (yield* tools.list()).map((tool) => tool.name).toSorted()
          expect(names).toContain("echotest")
          expect(names).toContain("math_add")
          expect(names).toContain("contextprobe")
          expect(names).not.toContain("broken")
          expect(names).not.toContain("math_helper")

          const snapshot = yield* tools.snapshot()
          const cataloged = (snapshot.codeModeCatalog?.tools ?? []).flatMap((item) =>
            item.type === "tool" ? [item] : item.tools,
          )
          const echo = cataloged.find((tool) => tool.name === "echotest") as { signature?: string } | undefined
          expect(echo?.signature).toContain("text: string")
          expect(echo?.signature).toContain("count: number")

          const run = (code: string) =>
            snapshot.execute({
              sessionID,
              agent: Agent.ID.make("build"),
              messageID: SessionMessage.ID.make("msg_custom_tool_test"),
              call: { type: "tool-call", id: "call_custom_tool", name: "execute", input: { code } },
            })

          const echoed = yield* run(
            'return await tools.echotest({ text: "MARKER-1703", count: 3, flag: true })',
          )
          expect(JSON.stringify(echoed)).toContain("MARKER-1703")
          expect(JSON.stringify(echoed)).toContain("count")

          const added = yield* run("return await tools.math_add({ a: 19, b: 23 })")
          expect(JSON.stringify(added)).toContain("42")

          const context = yield* run("return await tools.contextprobe({})")
          expect(JSON.stringify(context)).toContain("ses_custom_tool_test")
          // directory is the session Location's directory, not the config root.
          expect(JSON.stringify(context)).toContain('\\"directory\\":\\"/')
          // context.abort is a real AbortSignal (#1784), not yet aborted
          // for a normally-completing execution.
          expect(JSON.stringify(context)).toContain('\\"abortIsSignal\\":true')
          expect(JSON.stringify(context)).toContain('\\"abortAborted\\":false')
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(Effect.provide(PluginTestLayer)),
  )

  it.live("reloads when a tool file appears under a config root", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* writeTools(tmp.path, { "echotest.ts": echotest })
          const config = yield* Config.Test
          const plugins = yield* Plugin.Service
          const tools = yield* Tool.Service
          yield* config.setEntries([new Directory({ type: "directory", path: AbsolutePath.make(tmp.path) })])
          yield* ConfigToolPlugin.Plugin.effect(yield* PluginHost.make(plugins))
          expect((yield* tools.list()).map((tool) => tool.name)).not.toContain("late")

          yield* writeTools(tmp.path, {
            "late.ts": `
              import { tool } from "@opencode-ai/plugin"
              export default tool({
                description: "Added after startup",
                args: {},
                async execute() {
                  return "late"
                },
              })
            `,
          })
          yield* config.emitChange({ path: path.join(tmp.path, "tool", "late.ts"), type: "create" })
          for (let attempt = 0; attempt < 200; attempt++) {
            if ((yield* tools.list()).some((tool) => tool.name === "late")) return
            yield* Effect.sleep("10 millis")
          }
          yield* Effect.die(new Error("Timed out waiting for custom tool reload"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(Effect.provide(PluginTestLayer)),
  )

  it.live("a v1 tool observes its abort signal when execution is interrupted (#1784)", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const marker = path.join(tmp.path, "abort-observed.txt")
          yield* writeTools(tmp.path, {
            "abortprobe.ts": `
              import { tool } from "@opencode-ai/plugin"
              import fs from "node:fs"

              export default tool({
                description: "Resolve only when the abort signal fires",
                args: {},
                async execute(args, context) {
                  await new Promise((resolve) => {
                    if (context.abort.aborted) return resolve()
                    context.abort.addEventListener("abort", () => resolve(), { once: true })
                  })
                  fs.writeFileSync(${JSON.stringify(marker)}, "abort-observed")
                  return "abort-observed"
                },
              })
            `,
          })
          const config = yield* Config.Test
          const plugins = yield* Plugin.Service
          const tools = yield* Tool.Service
          yield* config.setEntries([new Directory({ type: "directory", path: AbsolutePath.make(tmp.path) })])
          yield* ConfigToolPlugin.Plugin.effect(yield* PluginHost.make(plugins))
          expect((yield* tools.list()).map((tool) => tool.name)).toContain("abortprobe")

          const snapshot = yield* tools.snapshot()
          const fiber = yield* snapshot
            .execute({
              sessionID,
              agent: Agent.ID.make("build"),
              messageID: SessionMessage.ID.make("msg_custom_tool_test"),
              call: { type: "tool-call", id: "call_custom_tool", name: "execute", input: { code: "return await tools.abortprobe({})" } },
            })
            .pipe(Effect.forkChild({ startImmediately: true }))
          // Let the tool start and register its abort listener, then interrupt.
          yield* Effect.sleep("500 millis")
          yield* Fiber.interrupt(fiber)
          // The tool observes the fired signal and writes its marker.
          for (let attempt = 0; attempt < 200; attempt++) {
            if (yield* Effect.promise(() => fs.stat(marker).then(() => true, () => false))) return
            yield* Effect.sleep("25 millis")
          }
          yield* Effect.die(new Error("Tool never observed its abort signal firing"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(Effect.provide(PluginTestLayer)),
  )
})
