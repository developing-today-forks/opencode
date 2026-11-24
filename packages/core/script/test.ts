import fs from "fs/promises"
import { realpathSync } from "fs"
import os from "os"
import path from "path"
import { tmpdir } from "../test/fixture/tmpdir"

// The test home must not sit inside the real home directory. With an
// ambient TMPDIR under HOME (the OpenCode agent harness sets
// TMPDIR=~/.local/share/opencode/tmp) the home would be created there, and
// config discovery walking up from the child's temp projects would reach
// the real home config (#2681). Drop TMPDIR for the home's own creation so
// it lands in the platform default temp root; the child environment below
// still sets TMPDIR to <home>/tmp.
const realHome = os.homedir()
if (realHome && inside(os.tmpdir(), realHome)) delete process.env.TMPDIR

function inside(candidate: string, home: string) {
  const resolved = realpath(candidate)
  const root = realpath(home)
  return resolved === root || resolved.startsWith(root + path.sep)
}

function realpath(candidate: string) {
  try {
    return realpathSync(candidate)
  } catch {
    return path.resolve(candidate)
  }
}

await using directory = await tmpdir("oc-")
const home = directory.path
const temporary = path.join(home, "tmp")
await fs.mkdir(temporary)

// Suites that drive a real rg binary (ripgrep, search tools) resolve it
// from PATH or the global bin cache, which is always cold under the fresh
// test HOME below. Seed the cache with an ambient rg up front: without
// one on the runner the resolution would fall through to a network
// download the test harness forbids, failing those suites wholesale
// instead of surfacing the missing setup once (#72). CI provisions rg.
{
  const name = process.platform === "win32" ? "rg.exe" : "rg"
  const system = Bun.which(name) ?? Bun.which("rg")
  if (system) {
    const target = path.join(home, ".cache", "opencode", "bin", name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(system, target)
    if (process.platform !== "win32") await fs.chmod(target, 0o755)
  }
}

const environment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      if (process.env.RECORD === "true" && name === "OPENAI_API_KEY") return true
      if (
        /^(?:AWS|AZURE|GOOGLE|GCP|GCLOUD|VERTEX|OPENAI|ANTHROPIC|GEMINI|XAI|CLOUDFLARE|CF_AIG|SNOWFLAKE|AICORE|GITLAB|NPM_CONFIG)_/i.test(
          name,
        )
      ) {
        return false
      }
      return !/(?:^|_)(?:API_KEY|AUTHORIZATION|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(name)
    }),
  ),
  HOME: home,
  OPENCODE_TEST_HOME: home,
  // Tests must never spawn a detached mcpx daemon per test home (#14); the
  // plugin also refuses on OPENCODE_TEST_HOME, this keeps it explicit.
  OPENCODE_MCPX_DAEMON: "0",
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
  OPENCODE_CONFIG: undefined,
  OPENCODE_CONFIG_CONTENT: undefined,
  TMPDIR: temporary,
  ...(process.platform === "win32" ? { USERPROFILE: home, TMP: temporary, TEMP: temporary } : {}),
}

const child = Bun.spawn({
  // The 30s default timeout matches cli and tui; npm.test's Git package installs ran past Bun's 5s default on Windows.
  cmd: [process.execPath, "test", "--only-failures", "--timeout=30000", ...process.argv.slice(2)],
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
const interrupt = () => child.kill("SIGINT")
const terminate = () => child.kill("SIGTERM")
process.once("SIGINT", interrupt)
process.once("SIGTERM", terminate)
const result = await child.exited
process.off("SIGINT", interrupt)
process.off("SIGTERM", terminate)

process.exitCode = result
