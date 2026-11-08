import { describe, expect, test } from "bun:test"
import { closeStaleIssues } from "./close-issues"

// Regression test for #2132: close-issues.ts offset-paginates the open
// list (per_page=100, page=N) while closing items from it. Closing
// between page fetches shifts the next page of stale issues onto an
// already-fetched page, so they are never examined (250 stale issues
// closed only 150). The fix collects the full stale set first.

type FakeIssue = {
  number: number
  updated_at: string
  author_association: string
  user: { login: string } | null
}

function fakeFetch(open: FakeIssue[], closed: number[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    const parsed = new URL(href)
    if (init?.method === undefined || init.method === "GET") {
      const page = Number(parsed.searchParams.get("page") ?? "1")
      const perPage = Number(parsed.searchParams.get("per_page") ?? "100")
      const slice = open.slice((page - 1) * perPage, page * perPage)
      return new Response(JSON.stringify(slice), { status: 200 })
    }
    const match = parsed.pathname.match(/\/issues\/(\d+)(\/comments)?$/)
    if (!match) throw new Error(`unexpected URL ${href}`)
    const num = Number(match[1])
    if (init.method === "PATCH") {
      const idx = open.findIndex((i) => i.number === num)
      if (idx >= 0) open.splice(idx, 1)
      closed.push(num)
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch
}

const staleDate = "2020-01-01T00:00:00Z"
function staleIssue(number: number, login = "someuser"): FakeIssue {
  return { number, updated_at: staleDate, author_association: "NONE", user: { login } }
}

describe("closeStaleIssues (#2132)", () => {
  test("closes all 250 stale issues across 3 pages, none skipped", async () => {
    const open: FakeIssue[] = Array.from({ length: 250 }, (_, k) => staleIssue(k + 1))
    const closed: number[] = []
    const count = await closeStaleIssues({
      repo: "developing-today-forks/opencode",
      headers: {},
      fetchImpl: fakeFetch(open, closed),
      cutoffDate: new Date("2021-01-01T00:00:00Z"),
    })
    expect(count).toBe(250)
    expect(closed.length).toBe(250)
    expect(new Set(closed).size).toBe(250)
    expect(open.length).toBe(0)
  })

  test("stops at the first fresh issue and closes only stale issues before it", async () => {
    const open: FakeIssue[] = [
      staleIssue(1),
      staleIssue(2),
      { number: 3, updated_at: "2999-01-01T00:00:00Z", author_association: "NONE", user: { login: "someuser" } },
      staleIssue(4),
    ]
    const closed: number[] = []
    const count = await closeStaleIssues({
      repo: "developing-today-forks/opencode",
      headers: {},
      fetchImpl: fakeFetch(open, closed),
      cutoffDate: new Date("2021-01-01T00:00:00Z"),
    })
    expect(count).toBe(2)
    expect(closed).toEqual([1, 2])
  })

  test("skips exempt authors", async () => {
    const open: FakeIssue[] = [staleIssue(1, "opencode-agent[bot]"), staleIssue(2)]
    const closed: number[] = []
    const count = await closeStaleIssues({
      repo: "developing-today-forks/opencode",
      headers: {},
      fetchImpl: fakeFetch(open, closed),
      cutoffDate: new Date("2021-01-01T00:00:00Z"),
    })
    expect(count).toBe(1)
    expect(closed).toEqual([2])
  })
})
