import { randomUUID } from "node:crypto"
import { EOL } from "node:os"
import path from "node:path"
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Config } from "../../../config"
import { resolveConfigPath } from "../mcp/add"

export default Runtime.handler(
  Commands.commands.plugin.commands.remove,
  Effect.fn("cli.plugin.remove")(function* (input) {
    const global = yield* Global.Service
    const configPath = yield* Effect.promise(() => resolveConfigPath(global.config))
    const server = yield* Effect.promise(() => removePluginConfig(configPath, input.package))
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

export async function removePluginConfig(configPath: string, spec: string) {
  const text = await readFile(configPath, "utf8").catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
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
  // Match the sibling mcp add writer: resolve through any symlink first
  // (dotfiles setups) so the rename lands on the real file instead of
  // replacing the link, use a unique temp name per invocation so concurrent
  // writers cannot consume each other's rename source, and never widen an
  // existing config's permissions (a read-only 0400 config stays read-only).
  const destination = await realpath(configPath).catch(() => configPath)
  await mkdir(path.dirname(destination), { recursive: true })
  const existing = await stat(destination).catch(() => undefined)
  const mode = existing ? existing.mode & 0o600 : 0o600
  const temporary = destination + ".tmp-" + process.pid + "-" + randomUUID()
  await writeFile(temporary, updated.endsWith("\n") ? updated : updated + "\n", { mode })
  await rename(temporary, destination)
  return true
}

function configured(plugins: readonly unknown[] | undefined, spec: string) {
  return plugins?.some((entry) => matches(entry, spec)) ?? false
}

function matches(entry: unknown, spec: string) {
  return entry === spec || (typeof entry === "object" && entry !== null && "package" in entry && entry.package === spec)
}
