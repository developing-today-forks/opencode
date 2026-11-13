import { describe, expect, test } from "bun:test"
import { isExcluded, type } from "./raw-changelog"

// Oracle: opencode#2206 acceptance — scoped conventional prefixes are
// excluded at both call sites (both use isExcluded), and type() classifies
// by the leading conventional type, never by a /fix/i substring.
describe("raw-changelog classification (#2206)", () => {
  test("excludes unscoped and scoped test/chore/ci/ignore/release subjects", () => {
    for (const subject of [
      "test: add a case",
      "test(ai): reclassify moonshot prefixItems corpus row to approximated/widening, guard known-lossy links (#1933)",
      "test(console): one shared console-resource preload fixture (#1522)",
      "chore: bump deps",
      "chore(ci): pin actions",
      "ci: fix workflow",
      "ci(workflows): cache bun",
      "ignore: wip",
      "release: 1.0.0",
      "release(opencode): 1.0.0",
    ]) {
      expect(isExcluded(subject)).toBe(true)
    }
  })

  test("does not exclude feat/fix/docs subjects, scoped or not", () => {
    for (const subject of ["feat: add thing", "feat(tui): add thing", "fix: repair thing", "fix(core): repair thing", "docs: explain testing"]) {
      expect(isExcluded(subject)).toBe(false)
    }
  })

  test("type() files leading fix types under Bugfixes", () => {
    expect(type("fix: repair the crash")).toBe("Bugfixes")
    expect(type("fix(core): repair the crash")).toBe("Bugfixes")
    expect(type("Fix: repair the crash")).toBe("Bugfixes")
  })

  test("type() does not file prefix/suffix/fixture prose under Bugfixes", () => {
    expect(type("feat(core): add prefixItems support")).toBe("Improvements")
    expect(type("refactor: rename suffix helper")).toBe("Improvements")
    expect(type("test(console): one shared console-resource preload fixture (#1522)")).toBe("Improvements")
    expect(type("chore: update fixture snapshots")).toBe("Improvements")
  })
})
