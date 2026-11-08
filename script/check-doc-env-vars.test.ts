import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { check, deadVars, documentedVars, englishDocsFiles, gitHasReader } from "./check-doc-env-vars"

describe("documentedVars", () => {
  test("extracts distinct OPENCODE_* names, sorted", () => {
    const md = [
      "| `OPENCODE_ZULU` | boolean | last |",
      "Set `OPENCODE_ALPHA` and again `OPENCODE_ZULU`.",
      "Not a variable: OPENCODE has no suffix, and `NOT_OPENCODE_X` is a different name.",
    ].join("\n")
    expect(documentedVars(md)).toEqual(["OPENCODE_ALPHA", "OPENCODE_ZULU"])
  })

  test("returns an empty list when nothing is documented", () => {
    expect(documentedVars("no variables here")).toEqual([])
  })
})

const scratchRepos: string[] = []

afterAll(() => {
  for (const root of scratchRepos) rmSync(root, { recursive: true, force: true })
})

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
}

/** A committed one-file git repo whose only content is `contents`. */
function repoWith(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "check-doc-env-vars-"))
  scratchRepos.push(root)
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  writeFileSync(join(root, "reader.txt"), contents)
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "init"])
  return root
}

describe("gitHasReader", () => {
  test("a longer sibling name alone is not a reader (#358)", () => {
    const root = repoWith("OPENCODE_CONFIG_DIR\nOPENCODE_DISABLE_CLAUDE_CODE_SKILLS\n")
    expect(gitHasReader(root, "OPENCODE_CONFIG")).toBe(false)
    expect(gitHasReader(root, "OPENCODE_DISABLE_CLAUDE_CODE")).toBe(false)
  })

  test("the longer sibling itself still counts as read", () => {
    const root = repoWith("OPENCODE_CONFIG_DIR\n")
    expect(gitHasReader(root, "OPENCODE_CONFIG_DIR")).toBe(true)
  })

  test("exact occurrence shapes count as readers", () => {
    for (const shape of ["OPENCODE_CONFIG=/tmp/config", '"OPENCODE_CONFIG"', "${OPENCODE_CONFIG}", "OPENCODE_CONFIG"]) {
      expect(gitHasReader(repoWith(`${shape}\n`), "OPENCODE_CONFIG")).toBe(true)
    }
  })
})

describe("deadVars", () => {
  test("keeps only variables with no reader", () => {
    const readers = new Set(["OPENCODE_READ_SOMEWHERE"])
    expect(deadVars(["OPENCODE_READ_SOMEWHERE", "OPENCODE_READ_NOWHERE"], (name) => readers.has(name))).toEqual([
      "OPENCODE_READ_NOWHERE",
    ])
  })

  test("is empty when every variable has a reader", () => {
    expect(deadVars(["OPENCODE_READ_SOMEWHERE"], () => true)).toEqual([])
  })
})

describe("englishDocsFiles", () => {
  test("scans non-cli pages in both trees and skips locale directories (#931)", () => {
    const root = mkdtempSync(join(tmpdir(), "check-doc-env-vars-docs-"))
    scratchRepos.push(root)
    const write = (path: string, contents: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true })
      writeFileSync(join(root, path), contents)
    }
    write("packages/web/src/content/docs/cli.mdx", "`OPENCODE_ON_CLI`\n")
    write("packages/web/src/content/docs/config.mdx", "`OPENCODE_DEAD_PLANTED`\n")
    write("packages/web/src/content/docs/fr/config.mdx", "`OPENCODE_LOCALE_ONLY`\n")
    write("services/www/src/docs/content/console/api/index.mdx", "`OPENCODE_ON_WWW`\n")
    const files = englishDocsFiles(root)
    const vars = [...new Set(files.flatMap((file) => documentedVars(readFileSync(join(root, file), "utf8"))))].sort()
    expect(vars).toEqual(["OPENCODE_DEAD_PLANTED", "OPENCODE_ON_CLI", "OPENCODE_ON_WWW"])
    expect(deadVars(vars, () => false)).toContain("OPENCODE_DEAD_PLANTED")
  })
})

describe("check allowlist", () => {
  test("an allowlisted dead name passes with no stale entry (#931)", () => {
    const result = check(["OPENCODE_EXAMPLE"], () => false, [{ name: "OPENCODE_EXAMPLE", reason: "example shape" }])
    expect(result).toEqual({ dead: [], stale: [] })
  })

  test("an unknown dead name still fails (#931)", () => {
    const result = check(["OPENCODE_DEAD_NEW"], () => false, [{ name: "OPENCODE_EXAMPLE", reason: "example shape" }])
    expect(result.dead).toEqual(["OPENCODE_DEAD_NEW"])
  })

  test("a stale allowlist entry fails: name no longer documented (#931)", () => {
    const result = check(["OPENCODE_READ"], () => true, [{ name: "OPENCODE_GONE", reason: "was documented" }])
    expect(result.stale).toEqual(["OPENCODE_GONE"])
  })

  test("a stale allowlist entry fails: name gained a real reader (#931)", () => {
    const result = check(["OPENCODE_NOW_READ"], () => true, [{ name: "OPENCODE_NOW_READ", reason: "was dead" }])
    expect(result.stale).toEqual(["OPENCODE_NOW_READ"])
  })
})
