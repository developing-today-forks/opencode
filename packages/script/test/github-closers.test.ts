import { describe, expect, spyOn, test } from "bun:test"
import {
  CLOSE_ISSUES_RESPONSE_MAX_BYTES,
  closeIssue,
  fetchIssuePage,
  processIssuePage,
} from "../../../script/github/close-issues"
import {
  CLOSE_PRS_ERROR_BODY_MAX_BYTES,
  CLOSE_PRS_RESPONSE_MAX_BYTES,
  fetchOpenPullRequests,
} from "../../../script/github/close-prs"

const headers = { Accept: "application/vnd.github+json" }
const issueRequest = { repo: "owner/repo", headers }
const prRequest = { repo: { owner: "owner", name: "repo" }, headers }

function stalledBody() {
  return new ReadableStream<Uint8Array>({
    start() {
      // Keep the stream open until the request deadline cancels it.
    },
  })
}

function stalledFetch(onSignal?: (signal: AbortSignal | null | undefined) => void): typeof fetch {
  return async (_input, init) => {
    const signal = init?.signal
    onSignal?.(signal)
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) return reject(new Error("missing request signal"))
      if (signal.aborted) return reject(signal.reason)
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  }
}

function oversizedBody(maxBytes: number) {
  const chunk = new Uint8Array(64 * 1024).fill(120)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i <= maxBytes / chunk.byteLength; i++) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function pullRequestResponse() {
  return new Response(
    JSON.stringify({
      data: {
        rateLimit: { cost: 1, remaining: 100, resetAt: "2030-01-01T00:00:00Z" },
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    }),
  )
}

describe("GitHub closer request deadlines and bounded reads (#1344)", () => {
  test("the issue-list fetch settles when its request signal times out", async () => {
    let signal: AbortSignal | null | undefined
    await expect(
      fetchIssuePage({ ...issueRequest, page: 1, fetchImpl: stalledFetch((value) => (signal = value)), timeouts: { list: 25 } }),
    ).rejects.toThrow()
    expect(signal?.aborted).toBe(true)
  })

  test("the issue-list response body is cancelled at the request deadline", async () => {
    let signal: AbortSignal | null | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal
      return new Response(stalledBody())
    }
    await expect(fetchIssuePage({ ...issueRequest, page: 1, fetchImpl, timeouts: { list: 25 } })).rejects.toThrow()
    expect(signal?.aborted).toBe(true)
  })

  test("the issue-list streamed body is rejected over its byte cap", async () => {
    const fetchImpl: typeof fetch = async () => new Response(oversizedBody(CLOSE_ISSUES_RESPONSE_MAX_BYTES))
    await expect(fetchIssuePage({ ...issueRequest, page: 1, fetchImpl })).rejects.toThrow(
      `GitHub issue list response exceeded ${CLOSE_ISSUES_RESPONSE_MAX_BYTES} bytes`,
    )
  })

  test("closing an issue keeps the comment-then-close request sequence and deadlines", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init })
      return new Response(null, { status: 200 })
    }
    await closeIssue(42, { ...issueRequest, fetchImpl })
    expect(calls.map((call) => call.init?.method)).toEqual(["POST", "PATCH"])
    expect(calls.every((call) => call.init?.signal instanceof AbortSignal)).toBe(true)
  })

  test("a stale issue page skips pull requests and keeps author exemptions", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: input.toString(), method: init?.method })
      return new Response(null, { status: 200 })
    }
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      const result = await processIssuePage(
        [
          {
            number: 41,
            updated_at: "2026-09-01T00:00:00Z",
            author_association: "NONE",
            user: { login: "contributor" },
            pull_request: {
              url: "https://api.github.com/repos/owner/repo/pulls/41",
              html_url: "https://github.com/owner/repo/pull/41",
              diff_url: "https://github.com/owner/repo/pull/41.diff",
              patch_url: "https://github.com/owner/repo/pull/41.patch",
            },
          },
          {
            number: 42,
            updated_at: "2026-09-01T00:00:00Z",
            author_association: "NONE",
            user: { login: "contributor" },
          },
          {
            number: 43,
            updated_at: "2026-09-01T00:00:00Z",
            author_association: "MEMBER",
            user: { login: "member" },
          },
        ],
        { ...issueRequest, fetchImpl },
        new Date("2026-11-01T00:00:00Z"),
      )

      expect(result).toEqual({ closed: 1, foundFresh: false })
      expect(
        calls.map((call) => ({
          url: call.url.replace("https://api.github.com/repos/owner/repo", ""),
          method: call.method,
        })),
      ).toEqual([
        { url: "/issues/42/comments", method: "POST" },
        { url: "/issues/42", method: "PATCH" },
      ])
      expect(log.mock.calls).toContainEqual(["Skipping pull request #41"])
      expect(log.mock.calls).toContainEqual(["Skipping stale issue #43; author member is exempt"])
    } finally {
      log.mockRestore()
    }
  })

  test("the PR GraphQL fetch settles when its request signal times out", async () => {
    let signal: AbortSignal | null | undefined
    await expect(
      fetchOpenPullRequests({
        ...prRequest,
        fetchImpl: stalledFetch((value) => (signal = value)),
        timeouts: { githubRequest: 25 },
      }),
    ).rejects.toThrow()
    expect(signal?.aborted).toBe(true)
  })

  test("the PR GraphQL response body is cancelled at the request deadline", async () => {
    let signal: AbortSignal | null | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal
      return new Response(stalledBody())
    }
    await expect(fetchOpenPullRequests({ ...prRequest, fetchImpl, timeouts: { githubRequest: 25 } })).rejects.toThrow()
    expect(signal?.aborted).toBe(true)
  })

  test("the PR GraphQL streamed body is rejected over its byte cap", async () => {
    const fetchImpl: typeof fetch = async () => new Response(oversizedBody(CLOSE_PRS_RESPONSE_MAX_BYTES))
    await expect(fetchOpenPullRequests({ ...prRequest, fetchImpl })).rejects.toThrow(
      `GitHub GraphQL response exceeded ${CLOSE_PRS_RESPONSE_MAX_BYTES} bytes`,
    )
  })

  test("answered PR GraphQL responses still return the open PR page", async () => {
    const fetchImpl: typeof fetch = async () => pullRequestResponse()
    await expect(fetchOpenPullRequests({ ...prRequest, fetchImpl })).resolves.toEqual([])
  })

  test("PR error bodies are truncated to the diagnostic excerpt cap", async () => {
    const fetchImpl: typeof fetch = async () => new Response(oversizedBody(CLOSE_PRS_ERROR_BODY_MAX_BYTES), { status: 400 })
    await expect(fetchOpenPullRequests({ ...prRequest, fetchImpl })).rejects.toThrow(
      `[truncated after ${CLOSE_PRS_ERROR_BODY_MAX_BYTES} bytes]`,
    )
  })
})
