import { randomUUID } from "node:crypto"
import { EOL } from "node:os"
import path from "node:path"
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises"
import { Effect, Option } from "effect"
import { applyEdits, modify } from "jsonc-parser"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"

export default Runtime.handler(
  Commands.commands.mcp.commands.add,
  Effect.fn("cli.mcp.add")(function* (input) {
    const url = Option.getOrUndefined(input.url)
    const headers = Option.getOrUndefined(input.header)
    const environment = Option.getOrUndefined(input.env)
    // The CLI framework strands `--` operands on the root command, so read the local server command
    // straight from argv after `--`. This also lets the command carry its own flags (e.g. `npx -y`).
    const dash = process.argv.indexOf("--")
    const command = dash === -1 ? [...input.command] : process.argv.slice(dash + 1)

    const hasCommand = command.length > 0
    if (url && hasCommand)
      return yield* Effect.fail(new Error("Provide either --url <url> or a command after --, not both"))
    if (!url && !hasCommand) return yield* Effect.fail(new Error("Provide either --url <url> or a command after --"))
    if (url && !URL.canParse(url)) return yield* Effect.fail(new Error(`Invalid URL: ${url}`))
    if (url && environment) return yield* Effect.fail(new Error("--env is only valid for local MCP servers"))
    if (hasCommand && headers) return yield* Effect.fail(new Error("--header is only valid for remote MCP servers"))

    const server = url
      ? { type: "remote" as const, url, ...(headers ? { headers } : {}) }
      : { type: "local" as const, command, ...(environment ? { environment } : {}) }

    const global = yield* Global.Service
    const configPath = yield* Effect.promise(() => resolveConfigPath(input.global ? global.config : process.cwd()))
    yield* Effect.promise(() => writeMcpConfig(configPath, input.name, server))
    process.stdout.write(`MCP server "${input.name}" added to ${configPath}` + EOL)
  }),
)

export async function resolveConfigPath(directory: string) {
  const candidates = [
    path.join(directory, "opencode.json"),
    path.join(directory, "opencode.jsonc"),
    path.join(directory, ".opencode", "opencode.json"),
    path.join(directory, ".opencode", "opencode.jsonc"),
  ]
  for (const candidate of candidates) {
    if (
      await stat(candidate).then(
        (info) => info.isFile(),
        () => false,
      )
    )
      return candidate
  }
  return candidates[0]
}

// The temp file must be created exclusively: a pre-existing file at the temp
// path is never truncated or consumed as the rename source, it fails the
// write instead (EEXIST) and is left byte-for-byte intact.
export async function writeTempFileExclusive(temporary: string, content: string, mode: number) {
  await writeFile(temporary, content, { mode, flag: "wx" })
}

export async function writeMcpConfig(configPath: string, name: string, server: unknown) {
  const text = await readFile(configPath, "utf8").catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "{}"
    throw error
  })
  const edits = modify(text, ["mcp", "servers", name], server, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  // Match the sibling config writers (plugin add/remove): write a temp file in
  // the same directory with owner-only permissions, then rename it over the
  // config. The config is never a partial write, and a fresh config — which can
  // hold remote-MCP Authorization headers — is never created world-readable.
  // An existing config is resolved through any symlink first (dotfiles setups),
  // so the rename lands on the real file instead of replacing the link, and the
  // temp name is unique per invocation so concurrent writers cannot consume
  // each other's rename source.
  const destination = await realpath(configPath).catch(() => configPath)
  await mkdir(path.dirname(destination), { recursive: true })
  // Never widen an existing config's permissions: keep its owner bits (a
  // read-only 0400 config stays read-only); a fresh config gets 0600.
  const existing = await stat(destination).catch(() => undefined)
  const mode = existing ? existing.mode & 0o600 : 0o600
  const temporary = destination + ".tmp-" + process.pid + "-" + randomUUID()
  await writeTempFileExclusive(temporary, applyEdits(text, edits), mode)
  await rename(temporary, destination)
}
