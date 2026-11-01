import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MAX_ARCHIVE_BYTES } from "./bootstrap"
import { RemoteCli } from "./remote-cli"

// The output versionScript produces for a CLI that printed `versionOutput`: the frame
// markers versionScript prints around the --version output. Both markers are printed
// with a leading newline, so each lands on its own line even when the output before
// it (login-shell output for BEGIN, the --version output for END) does not end with one.
const framed = (versionOutput: string) => `\nOPENCODE_CLI_VERSION_BEGIN\n${versionOutput}\nOPENCODE_CLI_VERSION_END\n`

// Runs the real versionScript through `sh` against a fake CLI whose --version prints
// `versionPrint` (a shell printf format string, so a test controls the trailing newline).
function runVersionScript(versionPrint: string, precedingPrint?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "ssh-remote-cli-"))

  try {
    const cli = path.join(dir, "opencode")
    writeFileSync(cli, `#!/bin/sh\nprintf '${versionPrint}'\n`)
    chmodSync(cli, 0o755)

    const script =
      precedingPrint === undefined
        ? RemoteCli.versionScript(RemoteCli.quote(cli))
        : `printf '${precedingPrint}'\n${RemoteCli.versionScript(RemoteCli.quote(cli))}`

    const result = spawnSync("sh", ["-s"], { input: script, encoding: "utf8" })

    if (result.status !== 0) throw new Error(`versionScript exited ${result.status}: ${result.stderr}`)

    return result.stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("SSH parseVersion", () => {
  test("returns a clean version line unchanged", () => {
    expect(RemoteCli.parseVersion(framed("2.1.0\n"))).toBe("2.1.0")
    expect(RemoteCli.parseVersion(framed("opencode v2.1.0\n"))).toBe("2.1.0")
    expect(RemoteCli.parseVersion(framed("local\n"))).toBe("local")
  })

  test("skips a login-shell banner before the version line", () => {
    expect(RemoteCli.parseVersion(`Welcome to Ubuntu 24.04 LTS\n${framed("2.1.0\n")}`)).toBe("2.1.0")
    expect(
      RemoteCli.parseVersion(
        "Last login: Thu Oct 22 00:01:02 2026 from 10.0.0.2\r\nOPENCODE_CLI_VERSION_BEGIN\r\n2.1.0\r\nOPENCODE_CLI_VERSION_END\r\n",
      ),
    ).toBe("2.1.0")
  })

  test("does not read a version out of a banner line containing ' v'", () => {
    expect(RemoteCli.parseVersion(`dev tools v3 loaded\n${framed("opencode v2.1.0\n")}`)).toBe("2.1.0")
  })

  test("prefers the CLI's version over a banner line ending in a version-shaped token", () => {
    expect(RemoteCli.parseVersion(`dev tools v3\n${framed("opencode v2.1.0\n")}`)).toBe("2.1.0")
    expect(RemoteCli.parseVersion(`node v20.11.0\n${framed("opencode v2.1.0\n")}`)).toBe("2.1.0")
  })

  test("prefers the CLI's version over a standalone version-shaped banner line", () => {
    expect(RemoteCli.parseVersion(`24.04\n${framed("opencode v2.1.0\n")}`)).toBe("2.1.0")
  })

  test("does not accept a stale CLI when the banner version coincides with the expected one", () => {
    expect(RemoteCli.parseVersion(`tools v2.1.0\n${framed("opencode v1.0.0\n")}`)).toBe("1.0.0")
  })

  test("returns null for banner-only output when the version script printed nothing", () => {
    // Nothing staged yet (or --version failed): the output is banner/profile output only,
    // however version-shaped a banner line is.
    expect(RemoteCli.parseVersion("24.04\n")).toBeNull()
    expect(RemoteCli.parseVersion("node v20.11.0\n")).toBeNull()
    expect(RemoteCli.parseVersion("dev tools v3\n")).toBeNull()
    expect(RemoteCli.parseVersion("env vlocal\n")).toBeNull()
  })

  test("returns null when the framed version output is empty", () => {
    expect(RemoteCli.parseVersion(framed(""))).toBeNull()
    expect(RemoteCli.parseVersion(`node v20.11.0\n${framed("")}`)).toBeNull()
  })

  test("returns null when no line is a version", () => {
    expect(RemoteCli.parseVersion("")).toBeNull()
    expect(RemoteCli.parseVersion("  \n\n")).toBeNull()
    expect(RemoteCli.parseVersion("Welcome to Ubuntu 24.04 LTS\n")).toBeNull()
  })

  test("versionScript frames the --version output", () => {
    expect(RemoteCli.versionScript(`"$HOME/.opencode/bin/opencode"`)).toBe(
      `if [ -x "$HOME/.opencode/bin/opencode" ]; then printf '\\nOPENCODE_CLI_VERSION_BEGIN\\n'; "$HOME/.opencode/bin/opencode" --version 2>/dev/null || true; printf '\\nOPENCODE_CLI_VERSION_END\\n'; fi\n`,
    )
  })

  test.skipIf(process.platform === "win32")(
    "reads a version whose --version output has no trailing newline, through the real versionScript",
    () => {
      expect(RemoteCli.parseVersion(runVersionScript("2.1.0"))).toBe("2.1.0")
      expect(RemoteCli.parseVersion(runVersionScript("opencode v2.1.0"))).toBe("2.1.0")
      expect(RemoteCli.parseVersion(runVersionScript("2.1.0\\n"))).toBe("2.1.0")
    },
  )

  test.skipIf(process.platform === "win32")(
    "reads a version when preceding login-shell output has no trailing newline, through the real versionScript",
    () => {
      expect(RemoteCli.parseVersion(runVersionScript("2.1.0\\n", "welcome to dev box"))).toBe("2.1.0")
      expect(RemoteCli.parseVersion(runVersionScript("opencode v2.1.0\\n", "welcome to dev box"))).toBe("2.1.0")
      expect(RemoteCli.parseVersion(runVersionScript("2.1.0\\n", "welcome to dev box\\n"))).toBe("2.1.0")
      expect(RemoteCli.parseVersion(runVersionScript("2.1.0", "welcome to dev box"))).toBe("2.1.0")
    },
  )
})

describe("SSH installScript archive size bounds", () => {
  const script = RemoteCli.installScript({
    version: "2.0.0",
    source: { type: "download", url: "https://example.test/archive.tgz" },
  })

  test("limits the curl download to MAX_ARCHIVE_BYTES", () => {
    expect(script).toContain(
      `curl -fsSL --connect-timeout 15 --max-time 180 --max-filesize ${MAX_ARCHIVE_BYTES} "$url" -o "$stage/archive.tgz"`,
    )
  })

  test("rejects an oversized wget download before extraction", () => {
    expect(script).toContain(`wget -T 180 -O "$stage/archive.tgz" "$url"`)
    expect(script).toContain(`archive_size=$(wc -c < "$stage/archive.tgz" | tr -d '[:space:]')`)
    expect(script).toContain(
      `if [ "$archive_size" -gt ${MAX_ARCHIVE_BYTES} ]; then\n    printf 'archive exceeds ${MAX_ARCHIVE_BYTES} bytes\\n' >&2\n    exit 1\n  fi`,
    )
    expect(script.indexOf('if [ "$archive_size"')).toBeLessThan(script.indexOf('tar -xzf "$stage/archive.tgz"'))
    expect(script).toContain(`trap 'rm -rf "$stage"' EXIT`)
  })
})

// Runs the real probeScript through `sh`, optionally after preceding login-shell
// output (`precedingPrint` is a shell printf format string, so a test controls the
// trailing newline), and reads the target the way bootstrap does: the last line
// starting with the marker.
function runProbeScript(precedingPrint?: string) {
  const script =
    precedingPrint === undefined ? RemoteCli.probeScript : `printf '${precedingPrint}'\n${RemoteCli.probeScript}`

  const result = spawnSync("sh", ["-s"], { input: script, encoding: "utf8" })

  if (result.status !== 0) throw new Error(`probeScript exited ${result.status}: ${result.stderr}`)

  return result.stdout
    .split(/\r?\n/)
    .findLast((line) => line.startsWith("OPENCODE_REMOTE_TARGET="))
    ?.split("=")[1]
}

// Runs the real discoverScript through `sh` against a fake staged CLI, optionally
// after preceding login-shell output, and returns the script's raw output.
function runDiscoverScript(precedingPrint?: string) {
  const home = mkdtempSync(path.join(tmpdir(), "ssh-discover-cli-"))

  try {
    const cli = path.join(home, ".opencode/bin/opencode")
    mkdirSync(path.dirname(cli), { recursive: true })
    writeFileSync(cli, "#!/bin/sh\n")
    chmodSync(cli, 0o755)

    const script =
      precedingPrint === undefined
        ? RemoteCli.discoverScript()
        : `printf '${precedingPrint}'\n${RemoteCli.discoverScript()}`

    const result = spawnSync("sh", ["-s"], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    })

    if (result.status !== 0) throw new Error(`discoverScript exited ${result.status}: ${result.stderr}`)

    return { output: result.stdout, cli }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe("SSH probeScript and discoverScript", () => {
  test("probeScript prints the target marker with a leading newline", () => {
    expect(RemoteCli.probeScript).toContain(`printf '\\nOPENCODE_REMOTE_TARGET=%s\\n' "$target"`)
  })

  test.skipIf(process.platform === "win32")(
    "reads the target when preceding login-shell output has no trailing newline, through the real probeScript",
    () => {
      const target = runProbeScript()

      expect(target).toMatch(/^(linux|darwin)-(x64-baseline|arm64)(-musl)?$/)
      expect(runProbeScript("welcome to dev box")).toBe(target)
      expect(runProbeScript("welcome to dev box\\n")).toBe(target)
    },
  )

  test("discoverScript prints the discovered path with a leading newline", () => {
    expect(RemoteCli.discoverScript()).toContain(`printf '\\n%s\\n' "$cli"`)
  })

  test.skipIf(process.platform === "win32")(
    "prints the discovered path on its own line when preceding login-shell output has no trailing newline, through the real discoverScript",
    () => {
      const unterminated = runDiscoverScript("welcome to dev box")

      expect(unterminated.output.split(/\r?\n/)).toContain(unterminated.cli)

      const terminated = runDiscoverScript("welcome to dev box\\n")

      expect(terminated.output.split(/\r?\n/)).toContain(terminated.cli)

      const clean = runDiscoverScript()

      expect(clean.output.split(/\r?\n/)).toContain(clean.cli)
    },
  )
})
