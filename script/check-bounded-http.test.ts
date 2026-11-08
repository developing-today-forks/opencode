import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SCAN_ROOTS,
  collect,
  isScannedFile,
  parseAllowlist,
  scanSource,
  scriptTreesOnDisk,
  srcTreesOnDisk,
  staleEntries,
  unlistedHits,
  unscannedScriptTrees,
  unscannedSrcTrees,
  type Hit,
} from "./check-bounded-http"

describe("scanSource", () => {
  test("flags the P-A fetch shape, with or without a signal", () => {
    const hits = scanSource(
      "packages/core/src/example.ts",
      [
        "const a = await fetch(url)",
        "const b = await fetch(url, { signal: AbortSignal.timeout(5_000) })",
        "const c = ownValue(TABLE, key)",
      ].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([1, 2])
    expect(hits[0].text).toBe("const a = await fetch(url)")
  })

  test("flags the P-B direct response-read shapes", () => {
    const hits = scanSource(
      "f.ts",
      [
        "const a = await response.text()",
        "const b = await response.clone().json()",
        "const c = await readBoundedResponseText(response, cap, tooLarge)",
        "const d = Response.json({ ok: true })",
      ].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([1, 2])
  })

  test("calls with arguments are not body reads", () => {
    const hits = scanSource(
      "f.ts",
      [
        "return c.json({ ok: true })",
        "return c.text(\"Not Found\")",
        "yield* api.json(\"POST\", path, { body: {} })",
        "const out = yield* generate.text({ prompt })",
        "const a = await response.json()",
      ].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([5])
  })

  test("flags chained reads off a call (the Bun.file / clone shape)", () => {
    const hits = scanSource("f.ts", "const pkg = await Bun.file(path).json()")
    expect(hits).toHaveLength(1)
  })

  test("comment-only lines mentioning a call are not hits", () => {
    const hits = scanSource(
      "f.ts",
      ["// never call fetch(url) without a signal", "* response.text() buffers the body", "const x = 1"].join("\n"),
    )
    expect(hits).toEqual([])
  })
})

describe("services scan roots (#1256)", () => {
  test("SCAN_ROOTS covers every services/*/src tree", () => {
    expect(SCAN_ROOTS).toContain("services/changelog/src")
    expect(SCAN_ROOTS).toContain("services/files/src")
    expect(SCAN_ROOTS).toContain("services/update/src")
    expect(SCAN_ROOTS).toContain("services/www/src")
  })

  test("collect walks a services tree on disk and reports hits under their repo-relative path", () => {
    const root = mkdtempSync(join(tmpdir(), "bounded-http-collect-"))
    try {
      const pages = join(root, "services/www/src/pages")
      mkdirSync(pages, { recursive: true })
      writeFileSync(join(pages, "install.astro"), 'const response = await fetch("https://example.com/install")\n')
      writeFileSync(join(pages, "notes.md"), 'const ignored = await fetch("https://example.com/ignored")\n')
      const hits: Hit[] = []
      collect(root, join(root, "services/www/src"), hits)
      expect(hits).toHaveLength(1)
      expect(hits[0].file).toBe("services/www/src/pages/install.astro")
      expect(unlistedHits(hits, new Map())).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a services/ fixture hit fails the gate until dispositioned", () => {
    const hits = scanSource(
      "services/www/src/pages/install.astro",
      'const response = await fetch("https://example.com/install")',
    )
    expect(hits).toHaveLength(1)
    expect(unlistedHits(hits, new Map())).toHaveLength(1)
    const allowlist = parseAllowlist(
      'services/www/src/pages/install.astro :: const response = await fetch("https://example.com/install") :: tracked by #1246\n',
    )
    expect(unlistedHits(hits, allowlist)).toEqual([])
    expect(staleEntries(hits, allowlist)).toEqual([])
  })
})

describe("script scan roots (#1394)", () => {
  test("SCAN_ROOTS covers the root, package, and service script trees", () => {
    expect(SCAN_ROOTS).toContain("script")
    expect(SCAN_ROOTS).toContain("packages/ai/script")
    expect(SCAN_ROOTS).toContain("packages/cli/script")
    expect(SCAN_ROOTS).toContain("packages/core/script")
    expect(SCAN_ROOTS).toContain("packages/desktop/scripts")
    expect(SCAN_ROOTS).toContain("packages/sdk/script")
    expect(SCAN_ROOTS).toContain("packages/util/script")
    expect(SCAN_ROOTS).toContain("services/www/script")
  })

  test("collect walks a script tree on disk and reports hits under their repo-relative path", () => {
    const root = mkdtempSync(join(tmpdir(), "bounded-http-script-collect-"))
    try {
      const dir = join(root, "packages/cli/script")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "tool.ts"), 'const response = await fetch("https://example.com/tool")\n')
      writeFileSync(join(dir, "notes.md"), 'const ignored = await fetch("https://example.com/ignored")\n')
      const hits: Hit[] = []
      collect(root, join(root, "packages/cli/script"), hits)
      expect(hits).toHaveLength(1)
      expect(hits[0].file).toBe("packages/cli/script/tool.ts")
      expect(unlistedHits(hits, new Map())).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a script-tree fixture hit fails the gate until dispositioned", () => {
    const hits = scanSource("script/tool.ts", 'const response = await fetch("https://example.com/tool")')
    expect(hits).toHaveLength(1)
    expect(unlistedHits(hits, new Map())).toHaveLength(1)
    const allowlist = parseAllowlist(
      'script/tool.ts :: const response = await fetch("https://example.com/tool") :: tracked by #1394\n',
    )
    expect(unlistedHits(hits, allowlist)).toEqual([])
    expect(staleEntries(hits, allowlist)).toEqual([])
  })
})

describe("nested script trees (#1425)", () => {
  test("SCAN_ROOTS covers the nested console/app and plugins/figma script trees", () => {
    expect(SCAN_ROOTS).toContain("packages/console/app/script")
    expect(SCAN_ROOTS).toContain("packages/plugins/figma/script")
  })

  test("scriptTreesOnDisk finds package script trees at any depth and ignores non-package folders", () => {
    const root = mkdtempSync(join(tmpdir(), "bounded-http-trees-"))
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
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("no script tree on disk in this repo is unscanned", () => {
    expect(unscannedScriptTrees(join(import.meta.dir, ".."))).toEqual([])
  })
})

describe("src trees (#1494)", () => {
  test("srcTreesOnDisk finds package src trees at any depth and ignores non-package folders", () => {
    const root = mkdtempSync(join(tmpdir(), "bounded-http-src-trees-"))
    try {
      const tree = (rel: string, pkgAt: "parent" | "self" | "none") => {
        mkdirSync(join(root, rel), { recursive: true })
        if (pkgAt === "parent") writeFileSync(join(root, rel, "..", "package.json"), "{}\n")
        if (pkgAt === "self") writeFileSync(join(root, rel, "package.json"), "{}\n")
      }
      tree("packages/ai/src", "parent")
      tree("packages/console/app/src", "parent")
      tree("packages/stats/core/src", "parent")
      tree("services/www/src", "parent")
      // Not package src trees: a src folder with no package.json at either
      // level (asset content), and a depth-2 src above the package level.
      tree("packages/plugins/figma/skills/example/src", "none")
      mkdirSync(join(root, "packages/src"), { recursive: true })
      writeFileSync(join(root, "packages/package.json"), "{}\n")
      expect(srcTreesOnDisk(root)).toEqual([
        "packages/ai/src",
        "packages/console/app/src",
        "packages/stats/core/src",
        "services/www/src",
      ])
      expect(unscannedSrcTrees(root, ["packages/ai/src"])).toEqual([
        "packages/console/app/src",
        "packages/stats/core/src",
        "services/www/src",
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("no src tree on disk in this repo is unscanned", () => {
    expect(unscannedSrcTrees(join(import.meta.dir, ".."))).toEqual([])
  })
})

describe("GitHub Action scan root (#1436)", () => {
  test("SCAN_ROOTS includes the published GitHub Action", () => {
    expect(SCAN_ROOTS).toContain("github")
  })

  test("collect walks the GitHub Action tree on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "bounded-http-github-collect-"))
    try {
      const github = join(root, "github")
      mkdirSync(github, { recursive: true })
      writeFileSync(join(github, "index.ts"), 'const response = await fetch("https://example.com/action")\n')
      const hits: Hit[] = []
      collect(root, join(root, "github"), hits)
      expect(hits).toHaveLength(1)
      expect(hits[0].file).toBe("github/index.ts")
      expect(unlistedHits(hits, new Map())).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("isScannedFile", () => {
  test("includes Astro sources (executable frontmatter) and TS/TSX, excludes docs/data", () => {
    expect(isScannedFile("page.astro")).toBe(true)
    expect(isScannedFile("page.ts")).toBe(true)
    expect(isScannedFile("page.tsx")).toBe(true)
    expect(isScannedFile("page.mdx")).toBe(false)
    expect(isScannedFile("page.json")).toBe(false)
  })
})

describe("allowlist accounting", () => {
  const hits = scanSource("f.ts", "const a = await fetch(url)")
  const allowlist = parseAllowlist("# comment\n\nf.ts :: const a = await fetch(url) :: bounded at the site\n")

  test("a listed hit passes and nothing is stale", () => {
    expect(unlistedHits(hits, allowlist)).toEqual([])
    expect(staleEntries(hits, allowlist)).toEqual([])
  })

  test("an unlisted hit fails; a vanished line makes its entry stale", () => {
    expect(unlistedHits(hits, new Map())).toHaveLength(1)
    expect(staleEntries([], allowlist)).toEqual(["f.ts :: const a = await fetch(url)"])
  })

  test("one entry does not cover a duplicate identical line", () => {
    const duplicates = scanSource("f.ts", "const a = await fetch(url)\nconst a = await fetch(url)")
    expect(duplicates).toHaveLength(2)
    const unlisted = unlistedHits(duplicates, allowlist)
    expect(unlisted).toHaveLength(1)
    expect(unlisted[0].line).toBe(2)
    const twoEntries = parseAllowlist(
      "f.ts :: const a = await fetch(url) :: bounded at the site\nf.ts :: const a = await fetch(url) :: copy-paste, same bound\n",
    )
    expect(unlistedHits(duplicates, twoEntries)).toEqual([])
    expect(staleEntries(duplicates, twoEntries)).toEqual([])
  })

  test("a duplicate entry for a single line is stale", () => {
    const twoEntries = parseAllowlist(
      "f.ts :: const a = await fetch(url) :: bounded at the site\nf.ts :: const a = await fetch(url) :: entered twice\n",
    )
    expect(staleEntries(hits, twoEntries)).toEqual(["f.ts :: const a = await fetch(url)"])
  })

  test("a hit line containing the separator round-trips (#1394)", () => {
    const separatorHits = scanSource("f.ts", "const a = await fetch(url) :: trailing note")
    const separatorAllowlist = parseAllowlist(
      "f.ts :: const a = await fetch(url) :: trailing note :: bounded at the site\n",
    )
    expect(unlistedHits(separatorHits, separatorAllowlist)).toEqual([])
    expect(staleEntries(separatorHits, separatorAllowlist)).toEqual([])
  })

  test("a malformed allowlist line throws", () => {
    expect(() => parseAllowlist("f.ts :: no disposition")).toThrow("Malformed allowlist line")
  })
})
