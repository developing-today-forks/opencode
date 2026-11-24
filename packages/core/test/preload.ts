import fs from "fs"
import os from "os"
import path from "path"

process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"

// Test temp directories must not sit inside the user's home directory.
// The OpenCode agent harness sets TMPDIR=~/.local/share/opencode/tmp, and
// config discovery walks up from a temp project through every ancestor, so
// a real config in the home subtree (~/opencode.json, ~/.opencode, or the
// data directory's own opencode.json) leaks into tests that assert a
// location has only its own config (#2681). Rebase TMPDIR onto a fresh
// directory under the platform default temp root before any fixture runs;
// the directory itself is left for the OS temp sweeper. Managed runs
// (script/test.ts) set OPENCODE_TEST_HOME and isolate the home itself, so
// their TMPDIR already points inside that isolated home: leave them alone.
if (!process.env.OPENCODE_TEST_HOME) rebaseTmpdir()

function rebaseTmpdir() {
  const home = os.homedir()
  if (!home) return
  if (!inside(os.tmpdir(), home)) return
  const ambient = process.env.TMPDIR
  delete process.env.TMPDIR
  const fallback = os.tmpdir()
  if (inside(fallback, home)) {
    if (ambient !== undefined) process.env.TMPDIR = ambient
    return
  }
  process.env.TMPDIR = fs.mkdtempSync(path.join(fallback, "opencode-core-test-"))
}

function inside(candidate: string, home: string) {
  const resolved = realpath(candidate)
  const root = realpath(home)
  return resolved === root || resolved.startsWith(root + path.sep)
}

function realpath(candidate: string) {
  try {
    return fs.realpathSync(candidate)
  } catch {
    return path.resolve(candidate)
  }
}
