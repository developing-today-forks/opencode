import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { discoverScript } from "./remote-cli"
import { createWslRuntime, parseDiscoveredCli, parseProbeAnswer, probeScript, wslArgs } from "./runtime"

test("parseProbeAnswer reads the probe script's answer line, not login-shell banner output", () => {
  expect(parseProbeAnswer("yes")).toBe("yes")
  expect(parseProbeAnswer("no")).toBe("no")
  expect(parseProbeAnswer("Welcome to Ubuntu 24.04 LTS\nyes")).toBe("yes")
  expect(
    parseProbeAnswer("Last login: Thu Oct 22 00:01:02 2026\n * Documentation: https://help.ubuntu.com\nyes\n"),
  ).toBe("yes")
  expect(parseProbeAnswer("yes, your tools are ready\nno")).toBe("no")
  expect(parseProbeAnswer("")).toBe(null)
  expect(parseProbeAnswer("\n \n")).toBe(null)
})

test("probeScript prints both answers with a leading newline", () => {
  expect(probeScript("bash")).toContain(`printf '\\nyes\\n'`)
  expect(probeScript("bash")).toContain(`printf '\\nno\\n'`)
  expect(probeScript("curl")).toContain(`printf '\\nyes\\n'`)
  expect(probeScript("curl")).toContain(`printf '\\nno\\n'`)
})

// Runs the real probeScript through `sh`, optionally after preceding login-shell
// output (`precedingPrint` is a shell printf format string, so a test controls the
// trailing newline), and reads the output with the real parseProbeAnswer.
function runProbeScript(tool: string, precedingPrint?: string) {
  const script = precedingPrint === undefined ? probeScript(tool) : `printf '${precedingPrint}'\n${probeScript(tool)}`

  const result = spawnSync("sh", ["-s"], { input: script, encoding: "utf8" })

  if (result.status !== 0) throw new Error(`probeScript exited ${result.status}: ${result.stderr}`)

  return parseProbeAnswer(result.stdout)
}

test.skipIf(process.platform === "win32")(
  "probeDistro answers survive preceding login-shell output with no trailing newline, through the real probeScript",
  () => {
    for (const tool of ["bash", "curl"]) {
      expect(runProbeScript(tool)).toBe("yes")
      expect(runProbeScript(tool, "welcome to dev box\\n")).toBe("yes")
      expect(runProbeScript(tool, "welcome to dev box")).toBe("yes")
    }

    const missing = "opencode-definitely-missing-tool"

    expect(runProbeScript(missing)).toBe("no")
    expect(runProbeScript(missing, "welcome to dev box\\n")).toBe("no")
    expect(runProbeScript(missing, "welcome to dev box")).toBe("no")
    // A banner ending in `yes` must not become a false positive for a missing tool.
    expect(runProbeScript(missing, "your tools say yes")).toBe("no")
    expect(runProbeScript(missing, "yes")).toBe("no")
  },
)

// The output discoverScript produces for a discovered CLI at `cli`: the frame markers
// discoverScript prints around the path. Both markers are printed in one printf whose
// leading newline puts BEGIN on its own line even when preceding login-shell output
// does not end with one, and the path's trailing newline puts END on its own line.
const framedDiscovery = (cli: string) => `\nOPENCODE_CLI_DISCOVERY_BEGIN\n${cli}\nOPENCODE_CLI_DISCOVERY_END\n`

test("parseDiscoveredCli returns the discovered path, not a login-shell banner line", () => {
  expect(parseDiscoveredCli(framedDiscovery("/home/user/.opencode/bin/opencode"))).toBe(
    "/home/user/.opencode/bin/opencode",
  )
  expect(
    parseDiscoveredCli(`Welcome to Ubuntu 24.04 LTS\n${framedDiscovery("/home/user/.opencode/bin/opencode")}`),
  ).toBe("/home/user/.opencode/bin/opencode")
  expect(parseDiscoveredCli("")).toBeNull()
  expect(parseDiscoveredCli("Welcome to Ubuntu 24.04 LTS\n")).toBeNull()
  expect(parseDiscoveredCli("opencode\n")).toBeNull()
  // A banner line can itself be an absolute path to an `opencode` binary; only the framed
  // line is the discovered one.
  expect(
    parseDiscoveredCli(`/opt/old-opencode/bin/opencode\n${framedDiscovery("/home/user/.opencode/bin/opencode")}`),
  ).toBe("/home/user/.opencode/bin/opencode")
  // discoverScript can only ever print `$HOME/.opencode/bin/opencode`, so a path-shaped
  // banner line on its own — the script printed nothing because the CLI is not installed —
  // is not a discovery, whatever directory it points into.
  expect(parseDiscoveredCli("/opt/old-opencode/bin/opencode\n")).toBeNull()
  expect(parseDiscoveredCli("/usr/local/bin/opencode\n")).toBeNull()
  expect(parseDiscoveredCli("/opt/opencode\n")).toBeNull()
  // A banner line ending in the managed suffix itself is still not a discovery when it is
  // unframed: it is exactly the one path discoverScript can print, so no suffix rule can
  // tell it from the script's own line — only the frame can.
  expect(parseDiscoveredCli("/home/other/.opencode/bin/opencode\n")).toBeNull()
  expect(parseDiscoveredCli("/home/user/.opencode/bin/opencode\n")).toBeNull()
  // An empty frame is not a discovery either.
  expect(parseDiscoveredCli("\nOPENCODE_CLI_DISCOVERY_BEGIN\n\nOPENCODE_CLI_DISCOVERY_END\n")).toBeNull()
})

// Runs the real discoverScript through `sh` against a fake installed CLI,
// optionally after preceding login-shell output (`precedingPrint` is a shell
// printf format string, so a test controls the trailing newline), and reads
// the output with the real parseDiscoveredCli.
function runDiscoverScript(precedingPrint?: string) {
  const home = mkdtempSync(path.join(tmpdir(), "wsl-discover-cli-"))

  try {
    const cli = path.join(home, ".opencode/bin/opencode")

    mkdirSync(path.dirname(cli), { recursive: true })
    writeFileSync(cli, "#!/bin/sh\n")
    chmodSync(cli, 0o755)

    const script = precedingPrint === undefined ? discoverScript() : `printf '${precedingPrint}'\n${discoverScript()}`

    const result = spawnSync("sh", ["-s"], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    })

    if (result.status !== 0) throw new Error(`discoverScript exited ${result.status}: ${result.stderr}`)

    return { parsed: parseDiscoveredCli(result.stdout), cli }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test.skipIf(process.platform === "win32")(
  "parseDiscoveredCli reads the path when preceding login-shell output has no trailing newline, through the real discoverScript",
  () => {
    const unterminated = runDiscoverScript("welcome to dev box")

    expect(unterminated.parsed).toBe(unterminated.cli)

    const terminated = runDiscoverScript("welcome to dev box\\n")

    expect(terminated.parsed).toBe(terminated.cli)

    const clean = runDiscoverScript()

    expect(clean.parsed).toBe(clean.cli)
  },
)

// Runs the real discoverScript through `sh` with an empty HOME (no CLI installed),
// optionally after preceding login-shell output, and reads the output with the real
// parseDiscoveredCli.
function runDiscoverScriptWithoutCli(precedingPrint?: string) {
  const home = mkdtempSync(path.join(tmpdir(), "wsl-discover-no-cli-"))

  try {
    const script = precedingPrint === undefined ? discoverScript() : `printf '${precedingPrint}'\n${discoverScript()}`

    const result = spawnSync("sh", ["-s"], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    })

    if (result.status !== 0) throw new Error(`discoverScript exited ${result.status}: ${result.stderr}`)

    return parseDiscoveredCli(result.stdout)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test.skipIf(process.platform === "win32")(
  "parseDiscoveredCli returns null when discoverScript prints nothing and preceding output is a path-shaped banner line",
  () => {
    expect(runDiscoverScriptWithoutCli()).toBeNull()
    expect(runDiscoverScriptWithoutCli("/opt/old-opencode/bin/opencode\\n")).toBeNull()
    expect(runDiscoverScriptWithoutCli("/opt/old-opencode/bin/opencode")).toBeNull()
    // A banner line ending in the managed suffix — the exact spelling discoverScript can
    // print for another HOME — is still not a discovery, terminated or unterminated.
    expect(runDiscoverScriptWithoutCli("/home/other/.opencode/bin/opencode\\n")).toBeNull()
    expect(runDiscoverScriptWithoutCli("/home/other/.opencode/bin/opencode")).toBeNull()
  },
)

test.skipIf(process.platform === "win32")(
  "parseDiscoveredCli reads the real path after a banner line ending in the managed suffix, through the real discoverScript",
  () => {
    const terminated = runDiscoverScript("/home/other/.opencode/bin/opencode\\n")

    expect(terminated.parsed).toBe(terminated.cli)

    const unterminated = runDiscoverScript("/home/other/.opencode/bin/opencode")

    expect(unterminated.parsed).toBe(unterminated.cli)
  },
)

test("wslArgs bypasses the distro default shell", () => {
  expect(wslArgs(["sh", "-lc", 'printf "%s\\n" "$HOME"'], "Debian")).toEqual([
    "-d",
    "Debian",
    "--exec",
    "sh",
    "-lc",
    'printf "%s\\n" "$HOME"',
  ])
  expect(wslArgs(["bash", "-se"], "Debian", "root")).toEqual([
    "-d",
    "Debian",
    "--user",
    "root",
    "--exec",
    "bash",
    "-se",
  ])
})

// Exercise the real wsl.exe argv path: with `--`, WSL routes the command line through the distro's
// default shell, which expands `$cli` to "" before `sh` runs the script (#48640).
const runtime = createWslRuntime((key) => key)

const distro =
  process.platform === "win32" && (await runtime.probeRuntime()).available
    ? (await runtime.listInstalled().catch(() => [])).find((item) => item.isDefault)?.name
    : undefined

// A cold WSL VM takes several seconds to answer.
test.skipIf(!distro)(
  "inline scripts keep their own variable expansion inside WSL",
  async () => {
    const result = await runtime.runWslSh(['cli="from-script"', 'printf "%s\\n" "$cli"'].join("\n"), distro)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("from-script")
  },
  30_000,
)
