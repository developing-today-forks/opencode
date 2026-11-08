import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SCAN_ROOTS,
  isScannedFile,
  parseAllowlist,
  scanSource,
  scriptTreesOnDisk,
  srcTreesOnDisk,
  staleEntries,
  unlistedHits,
  unscannedScriptTrees,
  unscannedSrcTrees,
} from "./check-numeric-boundaries"

describe("scanSource", () => {
  test("flags the bare conversion shapes", () => {
    const hits = scanSource(
      "packages/core/src/example.ts",
      [
        "const a = Number(input)",
        "const b = parseInt(input, 10)",
        "const c = parseFloat(input)",
        "const d = pageLimit(input, 50)",
      ].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3])
    expect(hits[0].text).toBe("const a = Number(input)")
  })

  test("internal arithmetic predicates and longer identifiers are not conversions", () => {
    const hits = scanSource(
      "f.ts",
      [
        "const a = Number.isFinite(value)",
        "const b = Number.isNaN(value)",
        "const c = Number.isInteger(value)",
        "const d = toNumber(value)",
        "const e = Math.trunc(value)",
        "const f = Number(value)",
      ].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([6])
  })

  test("comment-only lines mentioning a conversion are not hits", () => {
    const hits = scanSource(
      "f.ts",
      ["// never call Number(input) on raw strings", "* parseInt(x) truncates", "const x = 1"].join("\n"),
    )
    expect(hits).toEqual([])
  })
})

describe("SCAN_ROOTS", () => {
  test("includes every production packages/*/src and services/*/src tree", () => {
    expect(SCAN_ROOTS).toEqual([
      "packages/ai/src",
      "packages/app/src",
      "packages/client/src",
      "packages/cli/src",
      "packages/codemode/src",
      "packages/console/app/src",
      "packages/console/function/src",
      "packages/core/src",
      "packages/desktop/src",
      "packages/function/src",
      "packages/gui-extensions/src",
      "packages/http-recorder/src",
      "packages/httpapi-codegen/src",
      "packages/latex/src",
      "packages/merman/src",
      "packages/plugin/src",
      "packages/plugin-browser/src",
      "packages/plugin-github/src",
      "packages/posts/src",
      "packages/protocol/src",
      "packages/schema/src",
      "packages/script/src",
      "packages/sdk/src",
      "packages/server/src",
      "packages/session-ui/src",
      "packages/simulation/src",
      "packages/stats/app/src",
      "packages/stats/core/src",
      "packages/stats/server/src",
      "packages/theme/src",
      "packages/tui/src",
      "packages/ui/src",
      "packages/util/src",
      "packages/web/src",
      "services/changelog/src",
      "services/files/src",
      "services/update/src",
      "services/www/src",
      "script",
      "packages/ai/script",
      "packages/client/script",
      "packages/cli/script",
      "packages/codemode/script",
      "packages/console/app/script",
      "packages/containers/script",
      "packages/core/script",
      "packages/desktop/scripts",
      "packages/http-recorder/script",
      "packages/merman/script",
      "packages/plugin/script",
      "packages/plugin-browser/script",
      "packages/plugin-github/script",
      "packages/plugins/figma/script",
      "packages/posts/script",
      "packages/protocol/script",
      "packages/schema/script",
      "packages/sdk/script",
      "packages/server/script",
      "packages/session-ui/script",
      "packages/simulation/script",
      "packages/theme/script",
      "packages/ui/script",
      "packages/util/script",
      "services/www/script",
    ])
  })
})

describe("isScannedFile", () => {
  test("includes TS/TSX, excludes docs/data", () => {
    expect(isScannedFile("page.ts")).toBe(true)
    expect(isScannedFile("page.tsx")).toBe(true)
    expect(isScannedFile("page.mdx")).toBe(false)
    expect(isScannedFile("page.json")).toBe(false)
  })
})

describe("allowlist accounting", () => {
  const hits = scanSource("f.ts", "const a = Number(input)")
  const allowlist = parseAllowlist("# comment\n\nf.ts :: const a = Number(input) :: baseline conversion\n")

  test("a listed hit passes and nothing is stale", () => {
    expect(unlistedHits(hits, allowlist)).toEqual([])
    expect(staleEntries(hits, allowlist)).toEqual([])
  })

  test("an unlisted hit fails; a vanished line makes its entry stale", () => {
    expect(unlistedHits(hits, new Map())).toHaveLength(1)
    expect(staleEntries([], allowlist)).toEqual(["f.ts :: const a = Number(input)"])
  })

  test("removing the entry for an existing conversion fails", () => {
    const emptied = parseAllowlist("# comment\n")
    expect(unlistedHits(hits, emptied)).toHaveLength(1)
  })

  test("one entry does not cover a duplicate identical line", () => {
    const duplicates = scanSource("f.ts", "const a = Number(input)\nconst a = Number(input)")
    expect(duplicates).toHaveLength(2)
    const unlisted = unlistedHits(duplicates, allowlist)
    expect(unlisted).toHaveLength(1)
    expect(unlisted[0].line).toBe(2)
    const twoEntries = parseAllowlist(
      "f.ts :: const a = Number(input) :: baseline conversion\nf.ts :: const a = Number(input) :: copy-paste, same disposition\n",
    )
    expect(unlistedHits(duplicates, twoEntries)).toEqual([])
    expect(staleEntries(duplicates, twoEntries)).toEqual([])
  })

  test("a duplicate entry for a single line is stale", () => {
    const twoEntries = parseAllowlist(
      "f.ts :: const a = Number(input) :: baseline conversion\nf.ts :: const a = Number(input) :: entered twice\n",
    )
    expect(staleEntries(hits, twoEntries)).toEqual(["f.ts :: const a = Number(input)"])
  })

  test("a malformed allowlist line throws", () => {
    expect(() => parseAllowlist("f.ts :: no disposition")).toThrow("Malformed allowlist line")
  })
})

describe("src trees (#1494)", () => {
  test("srcTreesOnDisk finds package src trees and unscannedSrcTrees diffs against SCAN_ROOTS", () => {
    const root = mkdtempSync(join(tmpdir(), "numeric-boundaries-src-trees-"))
    try {
      const tree = (rel: string, pkg: boolean) => {
        mkdirSync(join(root, rel), { recursive: true })
        if (pkg) writeFileSync(join(root, rel, "..", "package.json"), "{}\n")
      }
      tree("packages/ai/src", true)
      tree("packages/console/app/src", true)
      tree("services/update/src", true)
      tree("packages/plugins/figma/skills/example/src", false)
      expect(srcTreesOnDisk(root)).toEqual(["packages/ai/src", "packages/console/app/src", "services/update/src"])
      expect(unscannedSrcTrees(root, ["packages/ai/src", "services/update/src"])).toEqual([
        "packages/console/app/src",
      ])
      expect(unscannedSrcTrees(root, SCAN_ROOTS)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("no src tree on disk in this repo is unscanned", () => {
    expect(unscannedSrcTrees(join(import.meta.dir, ".."))).toEqual([])
  })
})

describe("script trees (#1517)", () => {
  test("SCAN_ROOTS covers the nested console/app and plugins/figma script trees", () => {
    expect(SCAN_ROOTS).toContain("script")
    expect(SCAN_ROOTS).toContain("packages/console/app/script")
    expect(SCAN_ROOTS).toContain("packages/plugins/figma/script")
    expect(SCAN_ROOTS).toContain("services/www/script")
  })

  test("scriptTreesOnDisk finds package script trees at any depth and ignores non-package folders", () => {
    const root = mkdtempSync(join(tmpdir(), "numeric-boundaries-script-trees-"))
    try {
      const tree = (rel: string, pkgAt: "parent" | "self" | "none") => {
        mkdirSync(join(root, rel), { recursive: true })
        if (pkgAt === "parent") writeFileSync(join(root, rel, "..", "package.json"), "{}\n")
        if (pkgAt === "self") writeFileSync(join(root, rel, "package.json"), "{}\n")
      }
      tree("packages/ai/script", "parent")
      tree("packages/console/app/script", "parent")
      tree("packages/plugins/figma/script", "parent")
      tree("packages/containers/script", "self")
      tree("packages/desktop/scripts", "parent")
      tree("services/www/script", "parent")
      // Not package script trees: the packages/script package itself and
      // a skill asset folder with no package.json at either level.
      mkdirSync(join(root, "packages/script/src"), { recursive: true })
      writeFileSync(join(root, "packages/script/package.json"), "{}\n")
      tree("packages/plugins/figma/skills/figma-generate-library/scripts", "none")
      expect(scriptTreesOnDisk(root)).toEqual([
        "packages/ai/script",
        "packages/console/app/script",
        "packages/containers/script",
        "packages/desktop/scripts",
        "packages/plugins/figma/script",
        "services/www/script",
      ])
      expect(unscannedScriptTrees(root, ["packages/ai/script"])).toEqual([
        "packages/console/app/script",
        "packages/containers/script",
        "packages/desktop/scripts",
        "packages/plugins/figma/script",
        "services/www/script",
      ])
      expect(unscannedScriptTrees(root, SCAN_ROOTS)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("no script tree on disk in this repo is unscanned", () => {
    expect(unscannedScriptTrees(join(import.meta.dir, ".."))).toEqual([])
  })
})
