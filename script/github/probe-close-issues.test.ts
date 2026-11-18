
import { describe, expect, test } from "bun:test"
import { fetchIssuePage, closeIssue } from "./close-issues"

// Probe: does the stale-issue closer's data path distinguish PRs from issues?
// Oracle: GitHub's list-issues endpoint returns PRs as items carrying a
// `pull_request` field; a closer for ISSUES must not return/close those.
const HEADERS = { Authorization: "Bearer x" }
const pageWithPR = [
  { number: 41, updated_at: "2026-01-01T00:00:00Z", author_association: "NONE", user: { login: "developing-today[bot]" }, pull_request: { url: "https://api.github.com/repos/o/r/pulls/41" } },
  { number: 42, updated_at: "2026-01-01T00:00:00Z", author_association: "NONE", user: { login: "someone" } },
]
describe("probe close-issues PR inclusion", () => {
  test("fetchIssuePage returns the PR item unfiltered", async () => {
    const fetchImpl = async () => new Response(JSON.stringify(pageWithPR), { status: 200, headers: { "content-type": "application/json" } })
    const page = await fetchIssuePage({ repo: "o/r", headers: HEADERS, fetchImpl: fetchImpl as any, page: 1 })
    console.log("PAGE_NUMBERS", page.map((i: any) => i.number))
    console.log("PAGE_HAS_PULL_REQUEST_FIELD", page.map((i: any) => Boolean((i as any).pull_request)))
    expect(page.length).toBe(2)
  })
  test("closeIssue closes whatever number it is given via the issues endpoint", async () => {
    const calls: string[] = []
    const fetchImpl = async (url: any, init: any) => { calls.push(`${init?.method ?? "GET"} ${url}`); return new Response("{}", { status: 201 }) }
    await closeIssue(41, { repo: "o/r", headers: HEADERS, fetchImpl: fetchImpl as any })
    console.log("CLOSE_CALLS", JSON.stringify(calls))
    expect(calls.length).toBe(2)
  })
})
