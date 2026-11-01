import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "main-broken.yml"), "utf8")

// The reconcile step's run-link collection lives between the RUN-LINKS
// markers so this fixture executes the exact shell the workflow runs,
// not a copy of it (#1314).
function snippet() {
  const begin = workflow.indexOf("# RUN-LINKS-BEGIN")
  const end = workflow.indexOf("# RUN-LINKS-END")
  expect(begin).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(begin)
  return workflow
    .slice(workflow.lastIndexOf("\n", begin) + 1, workflow.indexOf("\n", end))
    .split("\n")
    .map((line) => line.replace(/^ {12}/, ""))
    .join("\n")
}

// Stub `gh` that answers `issue view --json body` / `--json comments`
// with what the real command prints after its --jq filter: the body
// text, and the comment bodies joined by newlines.
function collect(body: string, comments: string) {
  const dir = mkdtempSync(join(tmpdir(), "main-broken-reconcile-"))
  writeFileSync(join(dir, "body.txt"), body)
  writeFileSync(join(dir, "comments.txt"), comments)
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"--json body"*) cat "$FIXTURE_DIR/body.txt" ;;',
      '  *"--json comments"*) cat "$FIXTURE_DIR/comments.txt" ;;',
      '  *) echo "unexpected gh call: $*" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  )
  chmodSync(join(dir, "gh"), 0o755)
  const proc = Bun.spawnSync(["bash", "-c", `set -euo pipefail\n${snippet()}\nprintf '%s' "$LOSER_RUNS"`], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FIXTURE_DIR: dir,
      LOSER: "11",
      REPO: "developing-today/opencode",
    },
  })
  expect(proc.exitCode).toBe(0)
  return new TextDecoder().decode(proc.stdout)
}

const run = (id: number) => `https://github.com/developing-today/opencode/actions/runs/${id}`

describe("main-broken race-loser reconcile run links (#1314)", () => {
  test("staged three-watcher reconcile forwards inherited run links", () => {
    // Stage 1 already happened: #12 was closed into #11, so #12's run
    // link exists only in a reconcile comment on #11. #11's own body
    // carries only its own run link. Stage 2 now closes #11 into #10.
    const body = `Main-tier workflow \`test\` failed on \`main\`.\n\n- Run: ${run(111)}\n`
    const comments = [
      "<!-- agent-note:v1 -->",
      "agent-note:v1 -- main-broken race-loser reconcile",
      `- closed duplicate #12 for the same Breakage-ID`,
      `- loser runs (from #12 body and prior reconcile comments):`,
      run(112),
      `- reconciling run: ${run(111)}`,
    ].join("\n")
    // Every distinct link, in first-seen order, exactly once: the
    // inherited 112 survives, and 111 is not duplicated even though
    // it appears in both the body and the comment.
    expect(collect(body, comments)).toBe(`${run(111)}\n${run(112)}`)
  })

  test("a plain loser with no comments forwards its body run link", () => {
    expect(collect(`- Run: ${run(222)}\n`, "")).toBe(run(222))
  })

  test("the survivor comment forwards the collected runs", () => {
    const reconcile = workflow.slice(workflow.indexOf("Reconcile duplicate main-broken issues"))
    expect(reconcile).toContain("loser runs (from #$LOSER body and prior reconcile comments):\n          $LOSER_RUNS")
    expect(reconcile).not.toContain("LOSER_RUN=$(")
  })
})
