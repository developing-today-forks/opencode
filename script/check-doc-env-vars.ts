#!/usr/bin/env bun
/**
 * Fail when an English docs page documents an OPENCODE_* variable that
 * nothing reads and no allowlist entry dispositions (#116, #931).
 *
 * The docs env tables are the canonical switch list users copy from, but
 * v1-era rows kept promising variables the v2 code never reads — setting one
 * silently did nothing (#103, #104, #105, #114, #115, #116). The original
 * guard only read cli.mdx, so a dead row on any other page passed CI, and
 * the second docs tree (services/www) silently posed as a reader for names
 * the first tree documents. This guard now extracts every `OPENCODE_*`
 * name mentioned in the English pages of both docs trees and requires each
 * one to either appear somewhere outside the docs trees (code, config,
 * workflows, scripts — anywhere a reader or setter could live) or carry an
 * allowlist disposition below with a reason. The guard's own files are
 * excluded from the reader search so its fixtures and allowlist reasons can
 * never pose as a reader.
 *
 * Locale handling: translations under
 * packages/web/src/content/docs/<locale>/ follow the usual
 * docs-locale-sync flow and are not scanned; DOCS_LOCALES mirrors
 * `docsLocale` in packages/web/src/i18n/locales.ts, and only directories
 * with those names are skipped — any other subdirectory of either docs
 * tree is English content and is scanned. services/www/src/docs/content
 * has no locale subdirectories.
 *
 * Allowlist entries go stale: an entry whose name is no longer documented
 * as a dead variable (the page stopped mentioning it, or the code grew a
 * real reader) fails the guard, so dispositions cannot outlive the shape
 * they were written for.
 *
 * Usage:
 *   bun run script/check-doc-env-vars.ts   # exit 1 listing dead variables
 */
import { readdirSync } from "node:fs"
import { join } from "node:path"

export const DOCS_TREES = ["packages/web/src/content/docs", "services/www/src/docs/content"] as const

/** Locale directory names under the web docs tree; mirrors `docsLocale`. */
export const DOCS_LOCALES = [
  "ar",
  "bs",
  "da",
  "de",
  "es",
  "fr",
  "it",
  "ja",
  "ko",
  "nb",
  "pl",
  "pt-br",
  "ru",
  "th",
  "tr",
  "uk",
  "zh-cn",
  "zh-tw",
] as const

/**
 * Documented OPENCODE_* names that legitimately have no reader in this
 * repo, each with the reason it is not a dead switch. Any other dead name
 * fails the guard; an entry that stops matching a dead documented name
 * fails it too (stale).
 */
export const ALLOWLIST = [
  {
    name: "OPENCODE_AUTH_JSON",
    reason:
      "gitlab.mdx names the GitLab CI variable handed to the external GitLab CI component as its auth_json input; the component, not this repo's code, consumes it.",
  },
  {
    name: "OPENCODE_MODEL",
    reason:
      "config.mdx uses it only as a {env:OPENCODE_MODEL} substitution example; any variable name works in that slot and this repo reads the substituted value, never this name.",
  },
  {
    name: "OPENCODE_CONSOLE_TOKEN",
    reason:
      "console/api docs use it as the example env name in a provider config ({env:OPENCODE_CONSOLE_TOKEN}); the name is chosen by the console operator, not read by this repo's code.",
  },
  {
    name: "OPENCODE_TOKEN",
    reason:
      "build/client docs read process.env.OPENCODE_TOKEN in sample SDK client code that users copy into their own projects; it is not a variable this repo's own code reads.",
  },
] as const

/** Every distinct OPENCODE_* name mentioned in a markdown document. */
export function documentedVars(markdown: string): string[] {
  return [...new Set(markdown.match(/\bOPENCODE_[A-Z0-9_]+\b/g) ?? [])].sort()
}

/** The documented variables for which `hasReader` finds no occurrence. */
export function deadVars(vars: string[], hasReader: (name: string) => boolean): string[] {
  return vars.filter((name) => !hasReader(name))
}

/**
 * Disposition `vars` against the allowlist: `dead` holds documented names
 * with no reader and no allowlist entry; `stale` holds allowlist names
 * that are no longer dead documented variables.
 */
export function check(vars: string[], hasReader: (name: string) => boolean, allowlist: readonly { name: string }[] = ALLOWLIST) {
  const dead = deadVars(vars, hasReader)
  const allowed = new Set(allowlist.map((entry) => entry.name))
  return {
    dead: dead.filter((name) => !allowed.has(name)),
    stale: allowlist.filter((entry) => !dead.includes(entry.name)).map((entry) => entry.name),
  }
}

/** English .mdx pages under both docs trees, repo-relative and sorted. */
export function englishDocsFiles(root: string): string[] {
  const files: string[] = []
  const walk = (tree: string, dir: string, top: boolean) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (top && tree === DOCS_TREES[0] && (DOCS_LOCALES as readonly string[]).includes(entry.name)) continue
        walk(tree, join(dir, entry.name), false)
        continue
      }
      if (entry.isFile() && entry.name.endsWith(".mdx")) files.push(join(dir, entry.name))
    }
  }
  for (const tree of DOCS_TREES) walk(tree, tree, true)
  return files
}

/**
 * A variable has a reader when git finds it outside both docs trees.
 * `-w` matches whole names only: without it a longer sibling such as
 * OPENCODE_CONFIG_DIR would pose as a reader of OPENCODE_CONFIG (#358).
 */
export function gitHasReader(root: string, name: string): boolean {
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      root,
      "grep",
      "-q",
      "-w",
      "-F",
      name,
      "--",
      ".",
      ":(exclude)packages/web/src/content/docs",
      ":(exclude)services/www/src/docs/content",
      ":(exclude)script/check-doc-env-vars.ts",
      ":(exclude)script/check-doc-env-vars.test.ts",
    ],
    { stdout: "ignore", stderr: "ignore" },
  )
  // git grep exits 1 when there is no match; anything else is a real error.
  if (result.exitCode === 1) return false
  if (result.exitCode !== 0) throw new Error(`git grep failed for ${name} (exit ${result.exitCode})`)
  return true
}

async function main() {
  const root = join(import.meta.dir, "..")
  const files = englishDocsFiles(root)
  const found = new Set<string>()
  for (const file of files) for (const name of documentedVars(await Bun.file(join(root, file)).text())) found.add(name)
  const vars = [...found].sort()
  const { dead, stale } = check(vars, (name) => gitHasReader(root, name))
  if (stale.length) {
    console.error(`check-doc-env-vars allowlist has ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"} (no longer a dead documented variable):`)
    for (const name of stale) console.error(`  ${name}`)
    console.error("Remove the entry, or restore the documented dead variable it dispositioned.")
  }
  if (dead.length) {
    console.error(`English docs pages document ${dead.length} OPENCODE_* variable(s) that nothing outside the docs reads:`)
    for (const name of dead) console.error(`  ${name}`)
    console.error("Remove the row, implement the variable, or add a reasoned allowlist entry before merging.")
  }
  if (dead.length || stale.length) process.exit(1)
  console.log(
    `All ${vars.length} OPENCODE_* variables documented in English docs pages (${files.length} files) have a reader outside the docs or a reasoned allowlist entry.`,
  )
}

if (import.meta.main) await main()
