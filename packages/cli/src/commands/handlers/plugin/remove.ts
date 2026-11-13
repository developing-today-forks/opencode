import { EOL } from "node:os"
import { Effect } from "effect"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Config } from "../../../config"
import { resolveConfigPath } from "../mcp/add"

export default Runtime.handler(
  Commands.commands.plugin.commands.remove,
  Effect.fn("cli.plugin.remove")(function* (input) {
    const global = yield* Global.Service
    const configPath = yield* Effect.promise(() => resolveConfigPath(global.config))
    const server = yield* removePluginConfig(configPath, input.package)
    const config = yield* Config.Service
    const info = yield* config.get()
    const tui = configured(info.plugins, input.package)
    if (tui)
      yield* config.update((draft) => {
        draft.plugins = draft.plugins?.filter((entry) => !matches(entry, input.package))
      })

    const removed = [server ? configPath : undefined, tui ? config.path : undefined].filter(
      (file) => file !== undefined,
    )
    process.stdout.write(
      removed.length
        ? `Plugin "${input.package}" removed from ${removed.join(", ")}${EOL}`
        : `Plugin "${input.package}" is not configured${EOL}`,
    )
  }),
)

export const removePluginConfig = Effect.fnUntraced(function* (configPath: string, spec: string) {
  const fs = yield* FSUtil.Service
  const text = yield* fs.readFileString(configPath).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
  )
  if (text === undefined) return false
  const errors: ParseError[] = []
  const config: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof config !== "object" || config === null || Array.isArray(config))
    throw new Error(`Invalid global configuration: ${configPath}`)
  const plugins = "plugins" in config ? config.plugins : undefined
  if (plugins !== undefined && !Array.isArray(plugins)) throw new Error(`Invalid plugins configuration: ${configPath}`)
  if (!configured(plugins, spec)) return false

  const updated = applyEdits(
    text,
    modify(
      text,
      ["plugins"],
      plugins?.filter((entry) => !matches(entry, spec)),
      {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      },
    ),
  )
  yield* fs.writeAtomic(configPath, updated.endsWith("\n") ? updated : updated + "\n", {
    modePolicy: "owner-capped",
  })
  return true
})

function configured(plugins: readonly unknown[] | undefined, spec: string) {
  return plugins?.some((entry) => matches(entry, spec)) ?? false
}

function matches(entry: unknown, spec: string) {
  return entry === spec || (typeof entry === "object" && entry !== null && "package" in entry && entry.package === spec)
}
