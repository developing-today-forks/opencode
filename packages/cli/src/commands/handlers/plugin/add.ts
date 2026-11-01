import { randomUUID } from "node:crypto"
import { EOL } from "node:os"
import path from "node:path"
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { Host } from "@opencode/plugin/host"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { resolveConfigPath } from "../mcp/add"
import { Config } from "../../../config"

export default Runtime.handler(
  Commands.commands.plugin.commands.add,
  Effect.fn("cli.plugin.add")(function* (input) {
    if (!(yield* Effect.promise(() => Npm.isInstallablePackage(input.package))))
      return yield* Effect.fail(new Error("Plugin target must be an npm registry package or Git package specifier"))
    const npm = yield* Npm.Service
    const installed = yield* npm.add(input.package)
    const entrypoints = Host.resolve(installed)
    const target = configurationTarget(entrypoints.server, entrypoints.tui)
    if (!target)
      return yield* Effect.fail(new Error(`Plugin package has no server or TUI entrypoint: ${input.package}`))

    if (target === "server") {
      const global = yield* Global.Service
      const configPath = yield* Effect.promise(() => resolveConfigPath(global.config))
      const changed = yield* Effect.promise(() => writePluginConfig(configPath, input.package))
      process.stdout.write(
        changed
          ? `Plugin "${input.package}" installed and added to ${configPath}${EOL}`
          : `Plugin "${input.package}" is already configured in ${configPath}${EOL}`,
      )
      return
    }

    const config = yield* Config.Service
    yield* config.update((draft) => {
      if (configured(draft.plugins, input.package)) return
      draft.plugins = [...(draft.plugins ?? []), input.package]
    })
    process.stdout.write(`TUI plugin "${input.package}" installed and added to ${config.path}${EOL}`)
  }),
)

export function configurationTarget(server?: string, tui?: string) {
  if (server) return "server" as const
  if (tui) return "tui" as const
}

export async function writePluginConfig(configPath: string, spec: string) {
  const text = await readFile(configPath, "utf8").catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "{}"
    throw error
  })
  const errors: ParseError[] = []
  const config: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof config !== "object" || config === null || Array.isArray(config))
    throw new Error(`Invalid global configuration: ${configPath}`)
  const plugins = "plugins" in config ? config.plugins : undefined
  if (plugins !== undefined && !Array.isArray(plugins)) throw new Error(`Invalid plugins configuration: ${configPath}`)
  if (configured(plugins, spec)) return false

  const updated = applyEdits(
    text,
    modify(text, ["plugins"], [...(plugins ?? []), spec], { formattingOptions: { tabSize: 2, insertSpaces: true } }),
  )
  await mkdir(path.dirname(configPath), { recursive: true })
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
  return plugins?.some(
    (entry) =>
      entry === spec || (typeof entry === "object" && entry !== null && "package" in entry && entry.package === spec),
  )
}
