import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  collect,
  evaluateGate,
  parseAllowlist,
  scanSource,
  staleEntries,
  treesOnDisk,
  unlistedHits,
  type GateDefinition,
  type Hit,
} from "./gate-harness"
import { GATE as PROTO_GATE, PATTERNS as PROTO_PATTERNS } from "./check-proto-reads"
import { GATE as NUMERIC_GATE } from "./check-numeric-boundaries"
import { GATE as BOUNDED_GATE } from "./check-bounded-http"

const PATTERNS = [/TABLE\[key\]/]

describe("scanSource (shared)", () => {
  test("comment-only lines are skipped for every gate (#1526: proto-reads gains the skip)", () => {
    const hits = scanSource(
      "f.ts",
      ["// TABLE[key] in a comment", "* TABLE[key] in a block comment", "/* TABLE[key] */", "const a = TABLE[key]"].join(
        "\n",
      ),
      PATTERNS,
    )
    expect(hits.map((hit) => hit.line)).toEqual([4])
  })
})

describe("collect on disk (#1289, generalised by #1526)", () => {
  test("hit keys are repo-relative with forward slashes, from a temp tree", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-harness-collect-"))
    try {
      const dir = join(root, "packages/core/src/util")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "example.ts"), "const a = TABLE[key]\n")
      writeFileSync(join(dir, "notes.md"), "const ignored = TABLE[key]\n")
      const hits: Hit[] = []
      collect(root, join(root, "packages/core/src"), hits, PROTO_PATTERNS, [".ts"])
      expect(hits).toHaveLength(1)
      expect(hits[0].file).toBe("packages/core/src/util/example.ts")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("allowlist accounting (shared)", () => {
  const hits = scanSource("f.ts", "const a = TABLE[key]", PATTERNS)
  const allowlist = parseAllowlist("# comment\n\nf.ts :: const a = TABLE[key] :: guarded at the site\n")

  test("a listed hit passes and nothing is stale; an unlisted hit fails", () => {
    expect(unlistedHits(hits, allowlist)).toEqual([])
    expect(staleEntries(hits, allowlist)).toEqual([])
    expect(unlistedHits(hits, new Map())).toHaveLength(1)
    expect(staleEntries([], allowlist)).toEqual(["f.ts :: const a = TABLE[key]"])
  })

  test("one entry does not cover a duplicate identical line", () => {
    const duplicates = scanSource("f.ts", "const a = TABLE[key]\nconst a = TABLE[key]", PATTERNS)
    expect(unlistedHits(duplicates, allowlist)).toHaveLength(1)
  })

  test("a hit line containing the separator round-trips (#1394 parse, shared by all gates)", () => {
    const separatorHits = scanSource("f.ts", "const a = TABLE[key] :: trailing note", PATTERNS)
    const separatorAllowlist = parseAllowlist(
      "f.ts :: const a = TABLE[key] :: trailing note :: bounded at the site\n",
    )
    expect(unlistedHits(separatorHits, separatorAllowlist)).toEqual([])
    expect(staleEntries(separatorHits, separatorAllowlist)).toEqual([])
  })

  test("a malformed allowlist line throws", () => {
    expect(() => parseAllowlist("f.ts :: no disposition")).toThrow("Malformed allowlist line")
  })
})

describe("treesOnDisk (shared inventory, #1425/#1494 shape)", () => {
  test("finds package trees by name at any depth and ignores non-package folders", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-harness-trees-"))
    try {
      const tree = (rel: string, pkg: boolean) => {
        mkdirSync(join(root, rel), { recursive: true })
        if (pkg) writeFileSync(join(root, rel, "..", "package.json"), "{}\n")
      }
      tree("packages/ai/src", true)
      tree("packages/ai/script", true)
      tree("packages/console/app/src", true)
      tree("packages/plugins/figma/skills/example/src", false)
      expect(treesOnDisk(root, ["src"])).toEqual(["packages/ai/src", "packages/console/app/src"])
      expect(treesOnDisk(root, ["script", "scripts"])).toEqual(["packages/ai/script"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("gate declarations", () => {
  const gates: GateDefinition[] = [PROTO_GATE, NUMERIC_GATE, BOUNDED_GATE]
  test("all three gates load as declarations over the harness, with roots and allowlists on disk", () => {
    const root = join(import.meta.dir, "..")
    for (const gate of gates) {
      expect(gate.patterns.length).toBeGreaterThan(0)
      expect(gate.scanRoots.length).toBeGreaterThan(0)
      for (const scanRoot of gate.scanRoots) expect(existsSync(join(root, scanRoot))).toBe(true)
      expect(existsSync(join(root, gate.allowlistPath))).toBe(true)
    }
  })

  test("evaluateGate dispositions a listed hit and flags an unlisted one", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-harness-eval-"))
    try {
      const dir = join(root, "packages/x/src")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "a.ts"), "const a = TABLE[key]\n")
      const gate: GateDefinition = {
        name: "smoke",
        scanRoots: ["packages/x/src"],
        scannedExtensions: [".ts"],
        allowlistPath: "script/smoke.allowlist.txt",
        patterns: PATTERNS,
        candidate: "smoke candidate",
        remediation: "Guard it, or add its disposition to",
        summary: (count) => `${count} dispositioned`,
      }
      const listed = evaluateGate(gate, root, "packages/x/src/a.ts :: const a = TABLE[key] :: guarded\n")
      expect(listed.unlisted).toEqual([])
      expect(listed.stale).toEqual([])
      const unlisted = evaluateGate(gate, root, "# empty\n")
      expect(unlisted.unlisted).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
