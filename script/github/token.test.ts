import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GITHUB_TOKEN_ENV_NAMES, resolveGitHubToken } from "./token"

// Oracle: the #1972 contract - one token convention between
// .github/workflows/repo-sweeper.yml and every script/github/ script
// it invokes. The workflow supplies GH_TOKEN; the shared helper is
// the only token read allowed in an invoked script.

describe("resolveGitHubToken (#1972)", () => {
  test("accepts the workflow convention, GH_TOKEN alone", () => {
    expect(resolveGitHubToken({ GH_TOKEN: "gh-token" })).toBe("gh-token")
  })

  test("accepts GITHUB_TOKEN alone, and prefers it when both are set", () => {
    expect(resolveGitHubToken({ GITHUB_TOKEN: "github-token" })).toBe("github-token")
    expect(resolveGitHubToken({ GITHUB_TOKEN: "github-token", GH_TOKEN: "gh-token" })).toBe("github-token")
  })

  test("empty or blank values do not count as a token", () => {
    expect(resolveGitHubToken({})).toBeUndefined()
    expect(resolveGitHubToken({ GITHUB_TOKEN: "", GH_TOKEN: "  " })).toBeUndefined()
    expect(resolveGitHubToken({ GITHUB_TOKEN: "", GH_TOKEN: "gh-token" })).toBe("gh-token")
  })
})

describe("repo-sweeper token contract guard (#1972)", () => {
  const root = join(import.meta.dir, "..", "..")
  const workflow = readFileSync(join(root, ".github", "workflows", "repo-sweeper.yml"), "utf8")

  test("the workflow provides at least one env name the shared helper accepts", () => {
    const provided = GITHUB_TOKEN_ENV_NAMES.filter((name) => new RegExp(`^\\s*${name}:`, "m").test(workflow))
    expect(provided.length).toBeGreaterThan(0)
  })

  test("every script/github script the sweeper invokes resolves its token through the shared helper", () => {
    const invoked = [...workflow.matchAll(/bun\s+(script\/github\/[\w.-]+\.ts)/g)].map((match) => match[1]!)
    expect(invoked.length).toBeGreaterThan(0)
    for (const scriptPath of invoked) {
      const source = readFileSync(join(root, scriptPath), "utf8")
      expect(source).toContain("resolveGitHubToken")
      // No direct token env reads outside the helper: a direct read is
      // how the GITHUB_TOKEN/GH_TOKEN mismatch returns silently.
      expect(source).not.toMatch(/process\.env\.(GITHUB_TOKEN|GH_TOKEN)\b/)
    }
  })
})
