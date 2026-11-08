import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { GitHubCopilot } from "../src/copilot.js"
import { GitHubPreferences } from "../src/preferences.js"
import { GitHubRepo } from "../src/repo.js"
import { GitHubReview } from "../src/review.js"
import { it, withEnv } from "./lib"
import { fakeGitHub, find, makeDeps, run, type Route } from "./fixture"

const HEAD = "a".repeat(40)
const OLD = "b".repeat(40)

const copilotReview = (input: { id: number; commit: string; at: string; body: string }) => ({
  id: input.id,
  node_id: `PRR_${input.id}`,
  user: { login: "Copilot", type: "Bot" },
  body: input.body,
  state: "COMMENTED",
  commit_id: input.commit,
  submitted_at: input.at,
  html_url: `https://github.com/acme/widgets/pull/7#pullrequestreview-${input.id}`,
})

const changesBody = [
  "<!-- ccr-overview-v2 -->",
  "",
  "### 🟡 Changes recommended",
  "",
  "Pagination stops early and a cache key collides.",
  "",
  "<details open>",
  "<summary><strong>2 open findings</strong></summary>",
  "",
  '- <picture><img src="x.png" alt="High severity" width="62"></picture> [Pagination stops after one page](https://github.com/acme/widgets/pull/7#discussion_r1001) · New',
  '- <picture><img src="x.png" alt="Low severity" width="62"></picture> [Cache key collides](https://github.com/acme/widgets/pull/7#discussion_r1002)',
  "</details>",
  "",
  "<details>",
  "<summary><strong>Previously missed (1)</strong></summary>",
  "",
  "In code that hasn't changed since last review",
  "",
  "<details>",
  '<summary><picture><img alt="Medium severity"></picture> Guard the retry loop</summary>',
  "",
  "`src/\u200bretry.\u200bts:40–44`",
  "",
  "The loop never stops when the server keeps failing. Cap the attempts.",
  "</details>",
  "</details>",
  "",
  "<details>",
  "<summary><strong>What changed in this PR</strong></summary>",
  "",
  "Adds pagination.",
  "</details>",
].join("\n")

const approvalBody = [
  "<!-- ccr-overview-v2 -->",
  "",
  "### 🟢 Approval recommended",
  "",
  "No blocking defects remain.",
  "",
  "**0 open findings**",
].join("\n")

const legacyBody = [
  "## Pull Request Overview",
  "",
  "Copilot reviewed 3 out of 3 changed files in this pull request and generated 1 comment.",
  "",
  "<details>",
  "<summary>Comments suppressed due to low confidence (2)</summary>",
  "",
  "**src/a.ts:12**",
  "* [nitpick] Consider a constant here.",
  "**src/b.ts:3-5**",
  "* This branch is unreachable.",
  "</details>",
].join("\n")

describe("GitHubCopilot.parseReview", () => {
  test("reads the verdict, listed findings with severity and comment IDs, and body-only findings", () => {
    const review = GitHubCopilot.parseReview(changesBody)
    expect(review.verdict).toBe("changes")
    expect(review.headline).toBe("Changes recommended")
    expect(review.summary).toBe("Pagination stops early and a cache key collides.")
    expect(review.open).toBe(2)
    expect(review.findings).toEqual([
      { title: "Pagination stops after one page", severity: "high", commentID: 1001, new: true },
      { title: "Cache key collides", severity: "low", commentID: 1002, new: false },
    ])
    expect(review.body).toEqual([
      {
        kind: "previously_missed",
        title: "Guard the retry loop",
        path: "src/retry.ts",
        line: 40,
        endLine: 44,
        severity: "medium",
        body: "The loop never stops when the server keeps failing. Cap the attempts.",
      },
    ])
  })

  test("treats an approval recommendation with no findings as approve", () => {
    const review = GitHubCopilot.parseReview(approvalBody)
    expect(review.verdict).toBe("approve")
    expect(review.open).toBe(0)
    expect(review.body).toEqual([])
  })

  test("reads low-confidence findings from the legacy overview format", () => {
    const review = GitHubCopilot.parseReview(legacyBody)
    expect(review.verdict).toBe("comments")
    expect(review.generated).toBe(1)
    expect(review.body).toEqual([
      { kind: "low_confidence", path: "src/a.ts", line: 12, body: "[nitpick] Consider a constant here." },
      { kind: "low_confidence", path: "src/b.ts", line: 3, endLine: 5, body: "This branch is unreachable." },
    ])
  })

  test("a picture without a severity badge does not swallow the headline before a later badge", () => {
    const review = GitHubCopilot.parseReview(
      [
        '<picture><img src="logo.png" alt="Copilot"></picture>',
        "",
        "### 🟡 Changes recommended",
        "",
        "One defect remains.",
        "",
        "<details open>",
        "<summary><strong>1 open finding</strong></summary>",
        "",
        '- <picture><img alt="Low severity"></picture> [Tidy](https://github.com/acme/widgets/pull/7#discussion_r5)',
        "</details>",
      ].join("\n"),
    )
    expect(review).toMatchObject({
      verdict: "changes",
      headline: "Changes recommended",
      summary: "One defect remains.",
    })
    expect(review.findings).toEqual([{ title: "Tidy", severity: "low", commentID: 5, new: false }])
  })

  test("a legacy review that generated no comments is clean", () => {
    expect(
      GitHubCopilot.parseReview(
        "## Pull request overview\n\nCopilot reviewed 1 out of 1 changed files in this pull request and generated no new comments.",
      ).verdict,
    ).toBe("clean")
  })
})

describe("GitHubCopilot.state", () => {
  const now = Date.parse("2026-01-01T12:00:00Z")
  const reviewed = { id: 1, commit: OLD, at: "2026-01-01T10:00:00Z", body: approvalBody }

  test("work started after the latest review is in progress", () => {
    const state = GitHubCopilot.state({
      head: HEAD,
      reviews: [reviewed],
      events: [
        { event: "review_requested", at: "2026-01-01T11:50:00Z", reviewer: "Copilot" },
        { event: "copilot_work_started", at: "2026-01-01T11:51:00Z" },
      ],
      pending: true,
      now,
    })
    expect(state).toMatchObject({ state: "in_progress", since: "2026-01-01T11:51:00.000Z", stuck: false, rounds: 1 })
  })

  test("a request that never started for over ten minutes is stuck", () => {
    const state = GitHubCopilot.state({
      head: HEAD,
      reviews: [reviewed],
      events: [{ event: "review_requested", at: "2026-01-01T11:30:00Z", reviewer: "Copilot" }],
      pending: true,
      now,
    })
    expect(state).toMatchObject({ state: "requested", stuck: true })
  })

  test("a request for someone else does not count", () => {
    const state = GitHubCopilot.state({
      head: HEAD,
      reviews: [reviewed],
      events: [{ event: "review_requested", at: "2026-01-01T11:30:00Z", reviewer: "octocat" }],
      pending: false,
      now,
    })
    expect(state.state).toBe("stale")
  })

  test("a review on the head commit with nothing pending is reviewed", () => {
    const state = GitHubCopilot.state({ head: OLD, reviews: [reviewed], events: [], pending: false, now })
    expect(state.state).toBe("reviewed")
  })

  test("work that ended in failure ends the request, so the next wait or copilot call requests again", () => {
    const state = GitHubCopilot.state({
      head: HEAD,
      reviews: [reviewed],
      events: [
        { event: "review_requested", at: "2026-01-01T11:50:00Z", reviewer: "Copilot" },
        { event: "copilot_work_started", at: "2026-01-01T11:51:00Z" },
        { event: "copilot_work_finished_failure", at: "2026-01-01T11:52:00Z" },
      ],
      pending: false,
      now,
    })
    expect(state.state).toBe("stale")
  })

  test("no reviews and no request is none", () => {
    expect(GitHubCopilot.state({ head: HEAD, reviews: [], events: [], pending: false, now }).state).toBe("none")
  })
})

describe("GitHubCopilot.authorKind", () => {
  test("distinguishes Copilot's reviewer, other bots and people", () => {
    expect(GitHubCopilot.authorKind("Copilot", "Bot")).toBe("copilot")
    expect(GitHubCopilot.authorKind("copilot-pull-request-reviewer", "Bot")).toBe("copilot")
    expect(GitHubCopilot.authorKind("copilot-pull-request-reviewer[bot]")).toBe("copilot")
    expect(GitHubCopilot.authorKind("copilot-swe-agent[bot]", "Bot")).toBe("bot")
    expect(GitHubCopilot.authorKind("github-advanced-security", "Bot")).toBe("bot")
    expect(GitHubCopilot.authorKind("octocat", "User")).toBe("human")
  })
})

describe("GitHubRepo", () => {
  test.each([
    ["acme/widgets", { host: "github.com", owner: "acme", name: "widgets" }],
    ["git@github.com:acme/widgets.git", { host: "github.com", owner: "acme", name: "widgets" }],
    ["ssh://git@github.example.com/acme/widgets.git", { host: "github.example.com", owner: "acme", name: "widgets" }],
    ["https://github.com/acme/widgets/pull/7", { host: "github.com", owner: "acme", name: "widgets" }],
    ["ghe.example.com/acme/widgets", { host: "ghe.example.com", owner: "acme", name: "widgets" }],
  ])("parses %s", (input, expected) => {
    expect(GitHubRepo.parse(input)).toEqual(expected)
  })

  test("parses numbered references", () => {
    expect(GitHubRepo.parseNumber("#12")).toEqual({ number: 12 })
    expect(GitHubRepo.parseNumber(12)).toEqual({ number: 12 })
    expect(GitHubRepo.parseNumber("acme/widgets#3")).toEqual({
      repo: { host: "github.com", owner: "acme", name: "widgets" },
      number: 3,
    })
    expect(GitHubRepo.parseNumber("https://github.com/acme/widgets/discussions/9")).toEqual({
      repo: { host: "github.com", owner: "acme", name: "widgets" },
      number: 9,
    })
    expect(GitHubRepo.parseNumber("nope")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------------------------

const pullData = (head = HEAD) => ({
  repository: {
    pullRequest: {
      id: "PR_7",
      number: 7,
      title: "Add pagination",
      url: "https://github.com/acme/widgets/pull/7",
      state: "OPEN",
      isDraft: false,
      author: { login: "dev", __typename: "User" },
      baseRefName: "main",
      baseRefOid: OLD,
      headRefName: "pagination",
      headRefOid: head,
      headRepository: { nameWithOwner: "acme/widgets" },
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      additions: 10,
      deletions: 2,
      changedFiles: 2,
      autoMergeRequest: null,
      commits: {
        totalCount: 3,
        nodes: [
          {
            commit: {
              oid: head,
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  totalCount: 2,
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "unit",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                      detailsUrl: "https://ci/unit",
                      isRequired: true,
                    },
                    {
                      __typename: "StatusContext",
                      context: "lint",
                      state: "SUCCESS",
                      targetUrl: null,
                      isRequired: false,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
      reviewRequests: { nodes: [] },
      latestOpinionatedReviews: { nodes: [] },
      comments: {
        nodes: [
          {
            id: "IC_human",
            author: { login: "maintainer", __typename: "User" },
            body: "Please also update the docs.",
            createdAt: "2026-01-01T10:05:00Z",
            url: "https://github.com/acme/widgets/pull/7#issuecomment-1",
            isMinimized: false,
          },
          {
            id: "IC_bot",
            author: { login: "netlify", __typename: "Bot" },
            body: "Deploy preview ready",
            createdAt: "2026-01-01T10:06:00Z",
            url: "https://github.com/acme/widgets/pull/7#issuecomment-2",
            isMinimized: false,
          },
        ],
      },
    },
  },
})

const threadsData = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            id: "PRRT_copilot",
            isResolved: false,
            isOutdated: false,
            path: "src/page.ts",
            line: 20,
            startLine: null,
            originalLine: 20,
            comments: {
              totalCount: 1,
              nodes: [
                {
                  databaseId: 1001,
                  author: { login: "copilot-pull-request-reviewer", __typename: "Bot" },
                  body: "The loop exits after the first page.",
                  createdAt: "2026-01-01T10:00:00Z",
                  url: "https://github.com/acme/widgets/pull/7#discussion_r1001",
                },
              ],
            },
          },
          {
            id: "PRRT_human",
            isResolved: false,
            isOutdated: true,
            path: "src/cache.ts",
            line: null,
            startLine: null,
            originalLine: 8,
            comments: {
              totalCount: 1,
              nodes: [
                {
                  databaseId: 2001,
                  author: { login: "maintainer", __typename: "User" },
                  body: "Why a Map here?",
                  createdAt: "2026-01-01T10:01:00Z",
                  url: "https://github.com/acme/widgets/pull/7#discussion_r2001",
                },
              ],
            },
          },
          {
            id: "PRRT_done",
            isResolved: true,
            isOutdated: false,
            path: "src/old.ts",
            line: 1,
            startLine: null,
            originalLine: 1,
            comments: {
              totalCount: 1,
              nodes: [
                {
                  databaseId: 3001,
                  author: { login: "copilot-pull-request-reviewer", __typename: "Bot" },
                  body: "Resolved already.",
                  createdAt: "2026-01-01T09:00:00Z",
                  url: "https://github.com/acme/widgets/pull/7#discussion_r3001",
                },
              ],
            },
          },
        ],
      },
    },
  },
}

const alert = {
  number: 5,
  state: "open",
  html_url: "https://github.com/acme/widgets/security/code-scanning/5",
  created_at: "2026-01-01T09:30:00Z",
  rule: { id: "js/sql-injection", description: "SQL injection", severity: "error", security_severity_level: "high" },
  tool: { name: "CodeQL" },
  most_recent_instance: {
    message: { text: "Query built from user input." },
    location: { path: "test/db.test.ts", start_line: 4, end_line: 4 },
  },
}

const baseRoutes = (overrides: Record<string, Route | object> = {}) => ({
  "GRAPHQL latestOpinionatedReviews": { body: pullData() },
  "GRAPHQL reviewThreads(first: 50": { body: threadsData },
  "GET /repos/acme/widgets/pulls/7/reviews": {
    body: [copilotReview({ id: 900, commit: HEAD, at: "2026-01-01T10:00:00Z", body: changesBody })],
  },
  "GET /repos/acme/widgets/issues/7/timeline": { body: [] },
  "GET /repos/acme/widgets/pulls/7/requested_reviewers": { body: { users: [], teams: [] } },
  "GET /repos/acme/widgets/code-scanning/alerts": { body: [alert] },
  "GET /repos/acme/widgets/code-scanning/alerts/5": { body: alert },
  "GET /user": { body: { login: "dev" } },
  "GET /repos/acme/widgets/rules/branches/main": { body: [] },
  "GRAPHQL viewer { login id }": {
    body: {
      viewer: { login: "dev", id: "U_dev" },
      repository: {
        nameWithOwner: "acme/widgets",
        url: "https://github.com/acme/widgets",
        isPrivate: false,
        isFork: false,
        isArchived: false,
        hasIssuesEnabled: true,
        hasDiscussionsEnabled: false,
        viewerPermission: "WRITE",
        parent: null,
        owner: { login: "acme" },
        defaultBranchRef: { name: "main" },
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
      },
    },
  },
  "GRAPHQL history(author:": {
    body: {
      repository: { defaultBranchRef: { target: { history: { totalCount: 12 } } } },
      search: { issueCount: 0 },
    },
  },
  ...overrides,
})

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined }

interface FeedbackOutput {
  readonly items: ReadonlyArray<GitHubReview.Item>
  readonly copilot: GitHubReview.CopilotStatus
  readonly guidance?: string
}

describe("github review tools", () => {
  test("preference outputs carry the same keys the documented input does", () => {
    expect(Object.keys(GitHubPreferences.Values.fields)).toEqual(Object.keys(GitHubPreferences.Info.fields))
  })

  it.live("preferences stores globally and reports stored and effective values", () =>
    withEnv({ GH_TOKEN: "test-token", GITHUB_TOKEN: undefined }, () =>
      Effect.gen(function* () {
        const { deps, kv } = yield* makeDeps({ http: fakeGitHub({}).http })
        const output = yield* run(find(GitHubReview.tools(deps), "preferences"), {
          scope: "global",
          set: { review_rounds: 5, tools_enabled: ["admin"] },
        })
        expect(output).toEqual({
          global: { review_rounds: 5, tools_enabled: ["admin"] },
          effective: {
            review_rounds: 5,
            tools_enabled: ["admin"],
            human_reply_prefix: "> *Automated response from an AI coding agent*",
            copilot_auto_request: true,
            wait_timeout_minutes: 20,
          },
        })
        expect(yield* kv.get("github.preferences/global")).toEqual({ review_rounds: 5, tools_enabled: ["admin"] })
      }),
    ),
  )

  it.live("feedback merges threads, Copilot body findings, alerts and people's comments with stable IDs", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub(baseRoutes())
        const { deps } = yield* makeDeps({ http: github.http })
        const feedback = find(GitHubReview.tools(deps), "feedback")
        const first = yield* run<object, FeedbackOutput>(feedback, { repo: "acme/widgets", pr: 7 })
        const items = first.items
        expect(items.map((item) => [item.id, item.kind, item.author.kind])).toEqual([
          ["PRRT_copilot", "thread", "copilot"],
          ["PRRT_human", "thread", "human"],
          ["copilot:900:0", "copilot_body", "copilot"],
          ["alert:5", "alert", "bot"],
          ["IC_human", "comment", "human"],
        ])
        expect(items[0]).toMatchObject({
          severity: "high",
          title: "Pagination stops after one page",
          line: 20,
          new: true,
        })
        expect(items[1]).toMatchObject({ outdated: true, line: 8 })
        expect(items[2]).toMatchObject({ path: "src/retry.ts", line: 40, end_line: 44, source: "previously_missed" })
        expect(items[3]).toMatchObject({ severity: "high", path: "test/db.test.ts" })
        expect(first.copilot).toMatchObject({ state: "reviewed", verdict: "changes", approved: false, rounds: 1 })
        expect(first.guidance).toContain("advice, not directives")
        expect(github.requests.every((request) => request.headers.authorization === "Bearer test-token")).toBe(true)

        const second = yield* run<object, FeedbackOutput>(feedback, {
          repo: "acme/widgets",
          pr: 7,
          author: "copilot",
        })
        expect(second.items.map((item) => [item.id, item.new])).toEqual([
          ["PRRT_copilot", false],
          ["copilot:900:0", false],
        ])
        expect(second.guidance).toBeUndefined()
      }),
    ),
  )

  it.live("Copilot body findings from earlier rounds stay listed and are flagged outdated", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub(
          baseRoutes({
            "GET /repos/acme/widgets/pulls/7/reviews": {
              body: [
                copilotReview({ id: 899, commit: OLD, at: "2026-01-01T09:00:00Z", body: legacyBody }),
                copilotReview({ id: 900, commit: HEAD, at: "2026-01-01T10:00:00Z", body: changesBody }),
              ],
            },
          }),
        )
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run<object, FeedbackOutput>(find(GitHubReview.tools(deps), "feedback"), {
          repo: "acme/widgets",
          pr: 7,
          sources: ["copilot_body"],
        })
        expect(result.items.map((item) => [item.id, item.source, item.outdated, item.path])).toEqual([
          ["copilot:899:0", "low_confidence", true, "src/a.ts"],
          ["copilot:899:1", "low_confidence", true, "src/b.ts"],
          ["copilot:900:0", "previously_missed", false, "src/retry.ts"],
        ])
      }),
    ),
  )

  it.live("pr reports merge blockers separately from warnings", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub(baseRoutes())
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run<
          object,
          { ready: { merge: boolean; blockers: string[]; warnings: string[] }; feedback: object }
        >(find(GitHubReview.tools(deps), "pr"), { repo: "acme/widgets", pr: 7 })
        expect(result.feedback).toEqual({
          unresolved_threads: 2,
          copilot_threads: 1,
          human_threads: 1,
          outdated_threads: 1,
          open_alerts: 1,
        })
        expect(result.ready).toEqual({
          merge: false,
          blockers: [
            "Required checks failing: unit.",
            "1 unresolved thread(s) from people.",
            "1 unresolved high-severity bot finding(s).",
            "1 open high-severity code scanning alert(s).",
          ],
          warnings: [],
        })
      }),
    ),
  )

  it.live(
    "respond replies with the human prefix, resolves, dismisses alerts with a reason, and combines body replies",
    () =>
      withEnv(env, () =>
        Effect.gen(function* () {
          const github = fakeGitHub(
            baseRoutes({
              "GRAPHQL nodes(ids:": {
                body: {
                  nodes: [
                    {
                      __typename: "PullRequestReviewThread",
                      id: "PRRT_human",
                      isResolved: false,
                      path: "src/cache.ts",
                      comments: {
                        nodes: [
                          { author: { login: "maintainer", __typename: "User" }, body: "Why a Map here?", url: "u" },
                        ],
                      },
                    },
                  ],
                },
              },
              "GRAPHQL addPullRequestReviewThreadReply": {
                body: {
                  addPullRequestReviewThreadReply: {
                    comment: { url: "https://reply", pullRequestReview: { id: "PRR_pending", state: "PENDING" } },
                  },
                },
              },
              "GRAPHQL comments { totalCount }": { body: { node: { comments: { totalCount: 1 } } } },
              "GRAPHQL submitPullRequestReview": {
                body: { submitPullRequestReview: { pullRequestReview: { state: "COMMENTED" } } },
              },
              "GRAPHQL resolveReviewThread": { body: { resolveReviewThread: { thread: { isResolved: true } } } },
              "PATCH /repos/acme/widgets/code-scanning/alerts/5": (request) => ({
                body: { ...alert, state: "dismissed", request: request.body },
              }),
              "POST /repos/acme/widgets/issues/7/comments": { body: { html_url: "https://comment" } },
            }),
          )
          const { deps, asserted } = yield* makeDeps({ http: github.http })
          const tools = GitHubReview.tools(deps)
          const result = yield* run<
            object,
            {
              results: Array<Record<string, unknown>>
              submitted_reviews: number
              remaining_threads: number
              warnings: string[]
            }
          >(find(tools, "respond"), {
            repo: "acme/widgets",
            pr: 7,
            responses: [
              { id: "PRRT_human", body: "A Map keeps insertion order for eviction.", resolve: true },
              { id: "alert:5", resolve: true },
              { id: "copilot:900:0", body: "Capped at five attempts.", resolve: true },
            ],
          })
          expect(result.results.map((item) => [item.id, item.status, item.resolved])).toEqual([
            ["PRRT_human", "done", true],
            ["alert:5", "done", true],
            ["copilot:900:0", "done", true],
          ])
          expect(result.submitted_reviews).toBe(1)
          // Read back from GitHub, whose fake still reports both threads open.
          expect(result.remaining_threads).toBe(2)
          expect(asserted.map((item) => item.action)).toEqual(["github_respond"])

          const reply = github.requests.find((request) =>
            JSON.stringify(request.body ?? null).includes("addPullRequestReviewThreadReply"),
          )
          const replyBody = (reply?.body as { variables: { body: string } }).variables.body
          expect(replyBody.startsWith("> *Automated response from an AI coding agent*\n\n")).toBe(true)
          // The alert is in a test file, so dismissing without a reason picks "used in tests".
          const dismissal = github.requests.find((request) => request.method === "PATCH")
          expect(dismissal?.body).toMatchObject({ state: "dismissed", dismissed_reason: "used in tests" })
          const combined = github.requests.find(
            (request) => request.method === "POST" && request.path.endsWith("/issues/7/comments"),
          )
          expect((combined?.body as { body: string }).body).toBe(
            "Replies to findings in Copilot's review summary:\n\n---\n\n**Re: Guard the retry loop** (`src/retry.ts:40`)\n\nCapped at five attempts.\n\n<!-- opencode-github handled: copilot:900:0 -->",
          )

          const after = yield* run<object, { items: GitHubReview.Item[] }>(find(tools, "feedback"), {
            repo: "acme/widgets",
            pr: 7,
            sources: ["copilot_body"],
          })
          expect(after.items).toEqual([])
        }),
      ),
  )

  it.live("checks count a re-run once and call out jobs that never found a runner", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
        const checkRun = (name: string, fields: Record<string, unknown>) => ({
          __typename: "CheckRun",
          name,
          isRequired: false,
          detailsUrl: null,
          startedAt: null,
          completedAt: null,
          checkSuite: { createdAt: ago(1) },
          ...fields,
        })
        const data = pullData()
        const commit = data.repository.pullRequest.commits.nodes[0]!.commit
        const nodes = [
          checkRun("standards", {
            status: "COMPLETED",
            conclusion: "FAILURE",
            startedAt: ago(21),
            completedAt: ago(20),
          }),
          checkRun("standards", { status: "COMPLETED", conclusion: "SUCCESS", startedAt: ago(6), completedAt: ago(5) }),
          checkRun("unit", {
            status: "QUEUED",
            checkSuite: { createdAt: ago(30) },
            detailsUrl: "https://github.com/acme/widgets/actions/runs/5/job/77",
          }),
          checkRun("build", { status: "QUEUED" }),
        ]
        const github = fakeGitHub(
          baseRoutes({
            "GRAPHQL latestOpinionatedReviews": {
              body: {
                repository: {
                  pullRequest: {
                    ...data.repository.pullRequest,
                    commits: {
                      totalCount: 3,
                      nodes: [
                        {
                          commit: {
                            ...commit,
                            statusCheckRollup: { state: "PENDING", contexts: { totalCount: 4, nodes } },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
            "GET /repos/acme/widgets/actions/jobs/77": { body: { labels: ["blacksmith-4vcpu-ubuntu-2404"] } },
          }),
        )
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run<
          object,
          { checks: Record<string, unknown>; ready: { warnings: string[]; blockers: string[] } }
        >(find(GitHubReview.tools(deps), "pr"), { repo: "acme/widgets", pr: 7 })
        expect(result.checks).toMatchObject({
          total: 3,
          passed: 1,
          failing: [],
          pending: ["unit", "build"],
          required_pending: [],
          stalled: [
            {
              name: "unit",
              queued_minutes: 30,
              url: "https://github.com/acme/widgets/actions/runs/5/job/77",
              runner: "blacksmith-4vcpu-ubuntu-2404",
            },
          ],
        })
        expect(result.ready.blockers.some((blocker) => blocker.includes("check"))).toBe(false)
        expect(result.ready.warnings).toContain("1 optional check(s) still running.")
        expect(result.ready.warnings).toContain(
          "Optional checks unit queued for over 10 minutes without starting; they wait for runners labeled blacksmith-4vcpu-ubuntu-2404, which this repository may not have.",
        )
        // Waiting on checks stops at the ones still running, not the ones that will never start.
        nodes.splice(3, 1)
        const waited = yield* run<object, { status: string; message: string }>(find(GitHubReview.tools(deps), "wait"), {
          repo: "acme/widgets",
          pr: 7,
          for: "checks",
          background: false,
        })
        expect(waited.status).toBe("completed")
        expect(waited.message).toContain("never started (no runner?): unit")
      }),
    ),
  )

  it.live("handled markers in pull request comments are shared by every session, and a later reopen wins", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const comment = (id: string, body: string) => ({
          id,
          author: { login: "dev", __typename: "User" },
          body,
          createdAt: "2026-01-01T10:10:00Z",
          url: `https://github.com/acme/widgets/pull/7#${id}`,
          isMinimized: false,
        })
        const withComments = (comments: ReadonlyArray<ReturnType<typeof comment>>) => {
          const data = pullData()
          return {
            ...data,
            repository: { pullRequest: { ...data.repository.pullRequest, comments: { nodes: comments } } },
          }
        }
        const sources = ["copilot_body" as const]
        const handled = fakeGitHub(
          baseRoutes({
            "GRAPHQL latestOpinionatedReviews": {
              body: withComments([comment("IC_mark", "Replies…\n\n<!-- opencode-github handled: copilot:900:0 -->")]),
            },
          }),
        )
        // A new session with empty local storage still sees the finding as handled.
        const fresh = yield* makeDeps({ http: handled.http })
        const open = yield* run<object, FeedbackOutput>(find(GitHubReview.tools(fresh.deps), "feedback"), {
          repo: "acme/widgets",
          pr: 7,
          sources,
        })
        expect(open.items).toEqual([])
        const reopened = fakeGitHub(
          baseRoutes({
            "GRAPHQL latestOpinionatedReviews": {
              body: withComments([
                comment("IC_mark", "<!-- opencode-github handled: copilot:900:0 -->"),
                comment("IC_reopen", "Reopened.\n\n<!-- opencode-github reopened: copilot:900:0 -->"),
              ]),
            },
          }),
        )
        const again = yield* makeDeps({ http: reopened.http })
        const back = yield* run<object, FeedbackOutput>(find(GitHubReview.tools(again.deps), "feedback"), {
          repo: "acme/widgets",
          pr: 7,
          sources,
        })
        expect(back.items.map((item) => item.id)).toEqual(["copilot:900:0"])
      }),
    ),
  )

  it.live("an alert fixed in code is left for reanalysis instead of being dismissed", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub(baseRoutes())
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run<object, { results: Array<{ status: string }> }>(
          find(GitHubReview.tools(deps), "respond"),
          {
            repo: "acme/widgets",
            pr: 7,
            responses: [{ id: "alert:5", resolve: true, reason: "fixed" }],
          },
        )
        expect(result.results[0]?.status).toBe("awaiting_reanalysis")
        expect(github.requests.some((request) => request.method === "PATCH")).toBe(false)
      }),
    ),
  )

  it.live("a malformed alert id fails without calling the code-scanning API", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub(baseRoutes())
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run<object, { results: Array<{ status: string; note?: string }> }>(
          find(GitHubReview.tools(deps), "respond"),
          {
            repo: "acme/widgets",
            pr: 7,
            responses: [{ id: "alert:not-a-number", resolve: true }],
          },
        )
        expect(result.results[0]?.status).toBe("failed")
        expect(result.results[0]?.note).toContain("Invalid alert id")
        expect(github.requests.some((request) => request.path.includes("code-scanning"))).toBe(false)
      }),
    ),
  )

  it.live("copilot requests a review when the head commit has not been reviewed", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub(
          baseRoutes({
            "GRAPHQL latestOpinionatedReviews": { body: pullData("c".repeat(40)) },
            "POST /repos/acme/widgets/pulls/7/requested_reviewers": {
              body: { requested_reviewers: [{ login: "Copilot" }] },
            },
          }),
        )
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run<object, { action: string }>(find(GitHubReview.tools(deps), "copilot"), {
          repo: "acme/widgets",
          pr: 7,
        })
        expect(result.action).toBe("requested")
        const post = github.requests.find(
          (request) => request.method === "POST" && request.path.endsWith("/requested_reviewers"),
        )
        expect(post?.body).toEqual({ reviewers: ["copilot-pull-request-reviewer[bot]"] })
      }),
    ),
  )

  it.live("copilot does not re-request a review of an already reviewed head", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub(baseRoutes())
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run<object, { action: string; note?: string }>(
          find(GitHubReview.tools(deps), "copilot"),
          {
            repo: "acme/widgets",
            pr: 7,
          },
        )
        expect(result.action).toBe("none")
        expect(result.note).toContain("already reviewed")
        expect(
          github.requests.some((request) => request.method === "POST" && request.path.endsWith("/requested_reviewers")),
        ).toBe(false)
      }),
    ),
  )

  it.live("a foreground wait on an already reviewed head completes at once", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub(baseRoutes())
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run<object, { status: string; requested: string; message: string }>(
          find(GitHubReview.tools(deps), "wait"),
          {
            repo: "acme/widgets",
            pr: 7,
            background: false,
          },
        )
        expect(result).toMatchObject({ status: "completed", requested: "none" })
        expect(result.message).toContain("Changes recommended")
      }),
    ),
  )

  it.effect("a background wait rides out transient GitHub failures instead of dying", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-01-01T11:00:00Z"))
        const events: Array<Record<string, unknown>> = [
          { event: "review_requested", created_at: "2026-01-01T10:59:00Z", requested_reviewer: { login: "Copilot" } },
          { event: "copilot_work_started", created_at: "2026-01-01T10:59:30Z" },
        ]
        let outage = 0
        let reviewsList = [copilotReview({ id: 900, commit: OLD, at: "2026-01-01T10:00:00Z", body: changesBody })]
        const github = fakeGitHub(
          baseRoutes({
            "GRAPHQL latestOpinionatedReviews": () =>
              outage-- > 0 ? { status: 502, body: { message: "Bad Gateway" } } : { body: pullData() },
            "GET /repos/acme/widgets/pulls/7/reviews": () => ({ body: reviewsList }),
            "GET /repos/acme/widgets/issues/7/timeline": () => ({ body: events }),
          }),
        )
        const { deps, notified } = yield* makeDeps({ http: github.http })
        const wait = find(GitHubReview.tools(deps), "wait")
        const result = yield* run<object, { status: string; requested: string }>(wait, {
          repo: "acme/widgets",
          pr: 7,
          interval_seconds: 30,
        })
        expect(result).toMatchObject({ status: "running", requested: "none" })

        // Long enough that the client's own retries give up and the poll sees the failure.
        outage = 20
        const step = function* () {
          for (let tick = 0; tick < 40; tick++) {
            yield* TestClock.adjust("1 second")
            yield* Effect.yieldNow
          }
        }
        yield* Effect.gen(step)
        expect(notified).toEqual([])
        outage = 0
        reviewsList = [
          ...reviewsList,
          copilotReview({ id: 901, commit: HEAD, at: "2026-01-01T11:00:50Z", body: approvalBody }),
        ]
        yield* Effect.gen(step)
        for (let attempt = 0; attempt < 50 && notified.length === 0; attempt++) yield* Effect.yieldNow
        expect(notified).toHaveLength(1)
        expect(notified[0]?.text).toContain('state="completed"')
      }),
    ),
  )

  it.effect("a background wait requests a review, polls, and notifies the session when Copilot finishes", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-01-01T11:00:00Z"))
        // As on github.com: the request answers without listing Copilot, Copilot never shows up in
        // requested_reviewers, and progress is visible only as timeline events.
        const events: Array<Record<string, unknown>> = []
        let reviewsList = [copilotReview({ id: 900, commit: OLD, at: "2026-01-01T10:00:00Z", body: changesBody })]
        const github = fakeGitHub(
          baseRoutes({
            "GET /repos/acme/widgets/pulls/7/reviews": () => ({ body: reviewsList }),
            "GET /repos/acme/widgets/issues/7/timeline": () => ({ body: events }),
            "POST /repos/acme/widgets/pulls/7/requested_reviewers": () => {
              events.push({
                event: "review_requested",
                created_at: "2026-01-01T11:00:01Z",
                requested_reviewer: { login: "Copilot" },
              })
              return { status: 201, body: { requested_reviewers: [] } }
            },
          }),
        )
        const { deps, notified } = yield* makeDeps({ http: github.http })
        const wait = find(GitHubReview.tools(deps), "wait")
        const result = yield* run<object, { status: string; requested: string }>(wait, {
          repo: "acme/widgets",
          pr: 7,
          interval_seconds: 30,
        })
        expect(result).toMatchObject({ status: "running", requested: "requested" })
        expect(notified).toEqual([])
        // A second wait joins the running one instead of polling (and requesting) again.
        const again = yield* run<object, { status: string; message: string }>(wait, {
          repo: "acme/widgets",
          pr: 7,
        })
        expect(again.status).toBe("running")
        expect(
          github.requests.filter(
            (request) => request.method === "POST" && request.path.endsWith("/requested_reviewers"),
          ),
        ).toHaveLength(1)

        events.push({ event: "copilot_work_started", created_at: "2026-01-01T11:00:20Z" })
        yield* TestClock.adjust("30 seconds")
        yield* Effect.yieldNow
        expect(notified).toEqual([])

        reviewsList = [
          ...reviewsList,
          copilotReview({ id: 901, commit: HEAD, at: "2026-01-01T11:00:45Z", body: approvalBody }),
        ]
        yield* TestClock.adjust("30 seconds")
        for (let attempt = 0; attempt < 50 && notified.length === 0; attempt++) yield* Effect.yieldNow
        expect(notified).toHaveLength(1)
        expect(notified[0]?.text).toContain('state="completed"')
        expect(notified[0]?.text).toContain("Approval recommended")
        expect(notified[0]?.metadata).toMatchObject({ source: "github.wait", pr: "acme/widgets#7" })
        // The open items arrive with the notification, so the session can start without calling feedback.
        expect(notified[0]?.text).toContain(
          "Open items:\n- PRRT_copilot [high] src/page.ts:20 Pagination stops after one page\n- PRRT_human [human] src/cache.ts:8 Why a Map here?",
        )
      }),
    ),
  )

  it.effect("a background wait interrupted by a plugin reload resumes from storage and still notifies", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-01-01T11:00:00Z"))
        const events: Array<Record<string, unknown>> = [
          { event: "review_requested", created_at: "2026-01-01T10:59:00Z", requested_reviewer: { login: "Copilot" } },
          { event: "copilot_work_started", created_at: "2026-01-01T10:59:30Z" },
        ]
        let reviewsList = [copilotReview({ id: 900, commit: OLD, at: "2026-01-01T10:00:00Z", body: changesBody })]
        const github = fakeGitHub(
          baseRoutes({
            "GET /repos/acme/widgets/pulls/7/reviews": () => ({ body: reviewsList }),
            "GET /repos/acme/widgets/issues/7/timeline": () => ({ body: events }),
          }),
        )
        const made = yield* makeDeps({ http: github.http })
        const first = yield* Scope.make()
        yield* run(find(GitHubReview.tools({ ...made.deps, scope: first }), "wait"), {
          repo: "acme/widgets",
          pr: 7,
          interval_seconds: 30,
        })
        const recorded = () =>
          made.kv.scan({ prefix: "github.wait/" }).pipe(Effect.map((page) => page.entries.map((entry) => entry.key)))
        expect(yield* recorded()).toHaveLength(1)

        // The plugin reloads: its scope closes and the poll stops, but the record stays.
        yield* Scope.close(first, Exit.void)
        expect(yield* recorded()).toHaveLength(1)

        reviewsList = [
          ...reviewsList,
          copilotReview({ id: 901, commit: HEAD, at: "2026-01-01T11:00:40Z", body: approvalBody }),
        ]
        yield* GitHubReview.resume(made.deps)
        for (let attempt = 0; attempt < 50 && made.notified.length === 0; attempt++) yield* Effect.yieldNow
        expect(made.notified).toHaveLength(1)
        expect(made.notified[0]?.text).toContain('state="completed"')
        expect(yield* recorded()).toEqual([])
      }),
    ),
  )

  it.effect("a wait leaves a just-pushed commit to the repository's review-on-push rule before requesting", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-01-01T11:00:00Z"))
        const github = fakeGitHub(
          baseRoutes({
            "GET /repos/acme/widgets/pulls/7/reviews": {
              body: [copilotReview({ id: 900, commit: OLD, at: "2026-01-01T10:00:00Z", body: changesBody })],
            },
            "GET /repos/acme/widgets/rules/branches/main": {
              body: [{ type: "copilot_code_review", parameters: { review_on_push: true } }],
            },
            "POST /repos/acme/widgets/pulls/7/requested_reviewers": { status: 201, body: { requested_reviewers: [] } },
          }),
        )
        const posts = () =>
          github.requests.filter(
            (request) => request.method === "POST" && request.path.endsWith("/requested_reviewers"),
          )
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run<object, { requested: string }>(find(GitHubReview.tools(deps), "wait"), {
          repo: "acme/widgets",
          pr: 7,
          interval_seconds: 30,
        })
        expect(result.requested).toBe("none")
        yield* TestClock.adjust("30 seconds")
        for (let attempt = 0; attempt < 20; attempt++) yield* Effect.yieldNow
        expect(posts()).toHaveLength(0)
        // Nothing arrived on its own within a minute, so the next poll asks for the review itself.
        yield* TestClock.adjust("65 seconds")
        for (let attempt = 0; attempt < 20 && posts().length === 0; attempt++) yield* Effect.yieldNow
        expect(posts()).toHaveLength(1)
      }),
    ),
  )

  it.live("respond fills {sha} with the pushed head commit", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub(
          baseRoutes({
            "GRAPHQL nodes(ids:": {
              body: {
                nodes: [
                  {
                    __typename: "PullRequestReviewThread",
                    id: "PRRT_copilot",
                    isResolved: false,
                    path: "src/page.ts",
                    comments: {
                      nodes: [
                        { author: { login: "copilot-pull-request-reviewer", __typename: "Bot" }, body: "x", url: "u" },
                      ],
                    },
                  },
                ],
              },
            },
            "GRAPHQL addPullRequestReviewThreadReply": {
              body: { addPullRequestReviewThreadReply: { comment: { url: "https://reply", pullRequestReview: null } } },
            },
          }),
        )
        const { deps } = yield* makeDeps({ http: github.http })
        yield* run(find(GitHubReview.tools(deps), "respond"), {
          repo: "acme/widgets",
          pr: 7,
          responses: [{ id: "PRRT_copilot", body: "Fixed in {sha}: pagination follows the next link." }],
        })
        const reply = github.requests.find((request) =>
          JSON.stringify(request.body ?? null).includes("addPullRequestReviewThreadReply"),
        )
        expect((reply?.body as { variables: { body: string } }).variables.body).toBe(
          "Fixed in aaaaaaa: pagination follows the next link.",
        )
      }),
    ),
  )
})
