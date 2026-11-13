#!/usr/bin/env bun

import { GITHUB_TOKEN_REQUIRED_MESSAGE, resolveGitHubToken } from "./token"

const repo = process.env.GITHUB_REPOSITORY ?? "developing-today-forks/opencode"
const days = 60
const msg = `To stay organized issues are automatically closed after ${days} days of no activity. If the issue is still relevant please open a new one.`
const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
const agentLogin = "opencode-agent[bot]"
const teamMembers = new Set(
  (await Bun.file(new URL("../../.github/TEAM_MEMBERS", import.meta.url)).text())
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean),
)
const teamAssociations = new Set(["OWNER", "MEMBER"])

type Issue = {
  number: number
  updated_at: string
  author_association: string
  user: { login: string } | null
  pull_request?: { url: string }
}

const headers = {
  "Content-Type": "application/json",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
}

const CLOSE_ISSUES_REQUEST_TIMEOUTS = {
  comment: 30_000,
  close: 30_000,
  list: 30_000,
}

/** The issue-list response is schema-known JSON; 16 MiB is generous headroom for one 100-issue page. */
export const CLOSE_ISSUES_RESPONSE_MAX_BYTES = 16 * 1024 * 1024

type RequestOptions = {
  repo: string
  headers: Record<string, string>
  fetchImpl?: typeof fetch
  timeouts?: Partial<typeof CLOSE_ISSUES_REQUEST_TIMEOUTS>
}

function shouldSkip(i: Issue) {
  const login = i.user?.login.toLowerCase()
  return login === agentLogin || (login ? teamMembers.has(login) : false) || teamAssociations.has(i.author_association)
}

export async function fetchIssuePage(input: RequestOptions & { page: number }) {
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.timeouts?.list ?? CLOSE_ISSUES_REQUEST_TIMEOUTS.list
  const signal = AbortSignal.timeout(timeoutMs)
  const response = await fetchImpl(
    `https://api.github.com/repos/${input.repo}/issues?state=open&sort=updated&direction=asc&per_page=100&page=${input.page}`,
    { headers: input.headers, signal },
  )
  if (!response.ok) throw new Error(response.statusText)
  return (await readBoundedJson(response, signal, "GitHub issue list")) as Issue[]
}

export async function closeIssue(num: number, input: RequestOptions) {
  const fetchImpl = input.fetchImpl ?? fetch
  const timeouts = { ...CLOSE_ISSUES_REQUEST_TIMEOUTS, ...input.timeouts }
  const base = `https://api.github.com/repos/${input.repo}/issues/${num}`

  const comment = await fetchImpl(`${base}/comments`, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify({ body: msg }),
    signal: AbortSignal.timeout(timeouts.comment),
  })
  if (!comment.ok) throw new Error(`Failed to comment #${num}: ${comment.status} ${comment.statusText}`)

  const patch = await fetchImpl(base, {
    method: "PATCH",
    headers: input.headers,
    body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
    signal: AbortSignal.timeout(timeouts.close),
  })
  if (!patch.ok) throw new Error(`Failed to close #${num}: ${patch.status} ${patch.statusText}`)

  console.log(`Closed https://github.com/${input.repo}/issues/${num}`)
}

export async function collectStaleIssueNumbers(input: RequestOptions & { cutoffDate?: Date }): Promise<number[]> {
  const cutoffDate = input.cutoffDate ?? cutoff
  const stale: number[] = []
  let page = 1
  while (true) {
    const all = await fetchIssuePage({ ...input, page })
    if (all.length === 0) break
    console.log(`Fetched page ${page} ${all.length} issues`)
    let fresh = false
    for (const i of all) {
      if (new Date(i.updated_at) < cutoffDate) {
        if (i.pull_request) {
          console.log(`Skipping stale pull request #${i.number}; handled by close-prs.ts`)
          continue
        }
        if (shouldSkip(i)) {
          console.log(`Skipping stale issue #${i.number}; author ${i.user?.login ?? "unknown"} is exempt`)
          continue
        }
        stale.push(i.number)
      } else {
        console.log(`\nFound fresh issue #${i.number}, stopping`)
        fresh = true
        break
      }
    }
    if (fresh) break
    page++
  }
  return stale
}

export async function closeStaleIssues(input: RequestOptions & { cutoffDate?: Date }): Promise<number> {
  // Collect the full stale set BEFORE closing any issue (#2132):
  // closing mutates the open list that fetchIssuePage offset-paginates,
  // so closing between page fetches shifts the next page of stale
  // issues onto an already-fetched page and they are never examined.
  const stale = await collectStaleIssueNumbers(input)
  let closed = 0
  for (const num of stale) {
    await closeIssue(num, input)
    closed++
  }
  console.log(`Closed ${closed} issues total`)
  return closed
}

async function main() {
  // One shared convention (#1972): the sweeper supplies GH_TOKEN.
  // A missing token is a hard failure by design - the step (and job)
  // fails loudly rather than degrading to a green sweep in which the
  // daily close silently never happens (recorded on #1972).
  const token = resolveGitHubToken()
  if (!token) throw new Error(GITHUB_TOKEN_REQUIRED_MESSAGE)
  const requestOptions = { repo, headers: { ...headers, Authorization: `Bearer ${token}` } }
  await closeStaleIssues(requestOptions)
}

async function readBoundedJson(response: Response, signal: AbortSignal, operation: string): Promise<unknown> {
  if (!response.body) throw new Error(`${operation} response had no body`)
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > CLOSE_ISSUES_RESPONSE_MAX_BYTES) {
    await response.body.cancel().catch(() => undefined)
    throw new Error(`${operation} response exceeded ${CLOSE_ISSUES_RESPONSE_MAX_BYTES} bytes`)
  }

  const reader = response.body.getReader()
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined)
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > CLOSE_ISSUES_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${operation} response exceeded ${CLOSE_ISSUES_RESPONSE_MAX_BYTES} bytes`)
      }
      chunks.push(result.value)
    }
    signal.throwIfAborted()
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(bytes))
  } finally {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err)
    process.exit(1)
  })
}
