import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { discoverScript, parseVersion, quote, versionScript } from "./remote-cli"

// The output versionScript produces for a CLI that printed `versionOutput`: the frame
// markers versionScript prints around the --version output. Both markers are printed
// with a leading newline, so each lands on its own line even when the output before
// it (login-shell output for BEGIN, the --version output for END) does not end with one.
const framed = (versionOutput: string) => `\nOPENCODE_CLI_VERSION_BEGIN\n${versionOutput}\nOPENCODE_CLI_VERSION_END\n`

// Runs the real versionScript through `sh` against a fake CLI whose --version prints
// `versionPrint` (a shell printf format string, so a test controls the trailing newline).
function runVersionScript(versionPrint: string, precedingPrint?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "wsl-remote-cli-"))

  try {
    const cli = path.join(dir, "opencode")
    writeFileSync(cli, `#!/bin/sh\nprintf '${versionPrint}'\n`)
    chmodSync(cli, 0o755)

    const script =
      precedingPrint === undefined
        ? versionScript(quote(cli))
        : `printf '${precedingPrint}'\n${versionScript(quote(cli))}`

    const result = spawnSync("sh", ["-s"], { input: script, encoding: "utf8" })

    if (result.status !== 0) throw new Error(`versionScript exited ${result.status}: ${result.stderr}`)

    return result.stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("WSL parseVersion", () => {
  test("returns a clean version line unchanged", () => {
    expect(parseVersion(framed("2.1.0\n"))).toBe("2.1.0")
    expect(parseVersion(framed("opencode v2.1.0\n"))).toBe("2.1.0")
    expect(parseVersion(framed("local\n"))).toBe("local")
  })

  test("skips a login-shell banner before the version line", () => {
    expect(parseVersion(`Welcome to Ubuntu 24.04 LTS\n${framed("2.1.0\n")}`)).toBe("2.1.0")
    expect(
      parseVersion(
        "Last login: Thu Oct 22 00:01:02 2026 from 10.0.0.2\r\nOPENCODE_CLI_VERSION_BEGIN\r\n2.1.0\r\nOPENCODE_CLI_VERSION_END\r\n",
      ),
    ).toBe("2.1.0")
  })

  test("does not read a version out of a banner line containing ' v'", () => {
    expect(parseVersion(`dev tools v3 loaded\n${framed("opencode v2.1.0\n")}`)).toBe("2.1.0")
  })

  test("prefers the CLI's version over a banner line ending in a version-shaped token", () => {
    expect(parseVersion(`dev tools v3\n${framed("opencode v2.1.0\n")}`)).toBe("2.1.0")
    expect(parseVersion(`node v20.11.0\n${framed("opencode v2.1.0\n")}`)).toBe("2.1.0")
  })

  test("prefers the CLI's version over a standalone version-shaped banner line", () => {
    expect(parseVersion(`24.04\n${framed("opencode v2.1.0\n")}`)).toBe("2.1.0")
  })

  test("does not accept a stale CLI when the banner version coincides with the expected one", () => {
    expect(parseVersion(`tools v2.1.0\n${framed("opencode v1.0.0\n")}`)).toBe("1.0.0")
  })

  test("returns null for banner-only output when the version script printed nothing", () => {
    // Nothing staged yet (or --version failed): the output is banner/profile output only,
    // however version-shaped a banner line is.
    expect(parseVersion("24.04\n")).toBeNull()
    expect(parseVersion("node v20.11.0\n")).toBeNull()
    expect(parseVersion("dev tools v3\n")).toBeNull()
    expect(parseVersion("env vlocal\n")).toBeNull()
  })

  test("returns null when the framed version output is empty", () => {
    expect(parseVersion(framed(""))).toBeNull()
    expect(parseVersion(`node v20.11.0\n${framed("")}`)).toBeNull()
  })

  test("returns null when no line is a version", () => {
    expect(parseVersion("")).toBeNull()
    expect(parseVersion("  \n\n")).toBeNull()
    expect(parseVersion("Welcome to Ubuntu 24.04 LTS\n")).toBeNull()
  })

  test("versionScript frames the --version output", () => {
    expect(versionScript(`"$HOME/.opencode/bin/opencode"`)).toBe(
      `if [ -x "$HOME/.opencode/bin/opencode" ]; then printf '\\nOPENCODE_CLI_VERSION_BEGIN\\n'; "$HOME/.opencode/bin/opencode" --version 2>/dev/null || true; printf '\\nOPENCODE_CLI_VERSION_END\\n'; fi\n`,
    )
  })

  test.skipIf(process.platform === "win32")(
    "reads a version whose --version output has no trailing newline, through the real versionScript",
    () => {
      expect(parseVersion(runVersionScript("2.1.0"))).toBe("2.1.0")
      expect(parseVersion(runVersionScript("opencode v2.1.0"))).toBe("2.1.0")
      expect(parseVersion(runVersionScript("2.1.0\\n"))).toBe("2.1.0")
    },
  )

  test.skipIf(process.platform === "win32")(
    "reads a version when preceding login-shell output has no trailing newline, through the real versionScript",
    () => {
      expect(parseVersion(runVersionScript("2.1.0\\n", "welcome to dev box"))).toBe("2.1.0")
      expect(parseVersion(runVersionScript("opencode v2.1.0\\n", "welcome to dev box"))).toBe("2.1.0")
      expect(parseVersion(runVersionScript("2.1.0\\n", "welcome to dev box\\n"))).toBe("2.1.0")
      expect(parseVersion(runVersionScript("2.1.0", "welcome to dev box"))).toBe("2.1.0")
    },
  )

  test("discoverScript frames the discovered path", () => {
    expect(discoverScript()).toContain(
      `printf '\\nOPENCODE_CLI_DISCOVERY_BEGIN\\n%s\\nOPENCODE_CLI_DISCOVERY_END\\n' "$cli"`,
    )
  })
})
