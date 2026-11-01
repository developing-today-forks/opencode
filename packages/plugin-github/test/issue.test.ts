import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { GitHubIssues } from "../src/issue.js"
import { it, withEnv } from "./lib"
import { fakeGitHub, find, makeDeps, run, type Request } from "./fixture"

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined }

type Body = { query: string; variables: Record<string, unknown> }
const graphql = (requests: ReadonlyArray<Request>) =>
  requests.filter((request) => request.path === "/graphql").map((request) => request.body as Body)
const rest = (requests: ReadonlyArray<Request>) =>
  requests
    .filter((request) => request.path !== "/graphql")
    .map((request) => [request.method, request.path, request.body])

const searchNode = {
  number: 12,
  title: "Crash on start",
  url: "https://github.com/acme/widgets/issues/12",
  state: "CLOSED",
  stateReason: "NOT_PLANNED",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  author: { login: "dependabot[bot]", __typename: "Bot" },
  labels: { nodes: [{ name: "bug" }] },
  assignees: { nodes: [{ login: "alice" }] },
  comments: { totalCount: 3 },
  repository: { nameWithOwner: "acme/widgets" },
}

describe("github issues", () => {
  it.live("issues builds a repo-scoped issue search with qualifiers and maps results", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GRAPHQL search(type: ISSUE": { body: { search: { issueCount: 41, nodes: [searchNode, {}] } } },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run<object, unknown>(find(GitHubIssues.tools(deps), "issues"), {
          repo: "acme/widgets",
          state: "closed",
          label: ["bug", "good first issue"],
          assignee: "alice",
          query: "crash",
          limit: 5,
        })
        expect(graphql(github.requests)[0]?.variables).toEqual({
          query:
            'is:issue repo:acme/widgets is:closed assignee:alice label:bug label:"good first issue" sort:updated-desc crash',
          first: 5,
        })
        expect(result).toEqual({
          total: 41,
          query:
            'is:issue repo:acme/widgets is:closed assignee:alice label:bug label:"good first issue" sort:updated-desc crash',
          items: [
            {
              repo: "acme/widgets",
              number: 12,
              title: "Crash on start",
              url: "https://github.com/acme/widgets/issues/12",
              state: "closed",
              state_reason: "not_planned",
              author: { login: "dependabot[bot]", kind: "bot" },
              labels: ["bug"],
              assignees: ["alice"],
              comments: 3,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
            },
          ],
        })
      }),
    ),
  )

  it.live("issues drops the repository qualifier when the query scopes to an org", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({ "GRAPHQL search(type: ISSUE": { body: { search: { issueCount: 0, nodes: [] } } } })
        const { deps } = yield* makeDeps({ http: github.http })
        yield* run(find(GitHubIssues.tools(deps), "issues"), {
          repo: "acme/widgets",
          state: "all",
          sort: "created",
          query: "org:acme flaky",
        })
        expect(graphql(github.requests)[0]?.variables).toEqual({
          query: "is:issue sort:created-desc org:acme flaky",
          first: 30,
        })
      }),
    ),
  )

  it.live("issue maps body, hidden comments and de-duplicated linked pull requests", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const pull = (number: number) => ({
          __typename: "PullRequest",
          number,
          title: `Fix ${number}`,
          url: `https://github.com/acme/widgets/pull/${number}`,
          state: "MERGED",
          repository: { nameWithOwner: "acme/widgets" },
        })
        const github = fakeGitHub({
          "GRAPHQL issue(number: $number)": {
            body: {
              repository: {
                issue: {
                  number: 12,
                  title: "Crash on start",
                  body: "It crashes.<!-- template -->",
                  url: "https://github.com/acme/widgets/issues/12",
                  state: "OPEN",
                  stateReason: null,
                  locked: false,
                  createdAt: "2026-01-01T00:00:00Z",
                  closedAt: null,
                  author: { login: "alice", __typename: "User" },
                  labels: { nodes: [{ name: "bug" }] },
                  assignees: { nodes: [] },
                  milestone: { number: 3, title: "v1" },
                  comments: {
                    totalCount: 9,
                    nodes: [
                      {
                        id: "IC_1",
                        databaseId: 101,
                        body: "Same here",
                        createdAt: "2026-01-03T00:00:00Z",
                        url: "https://github.com/acme/widgets/issues/12#issuecomment-101",
                        isMinimized: true,
                        minimizedReason: "OUTDATED",
                        author: { login: "bob", __typename: "User" },
                      },
                    ],
                  },
                  timelineItems: {
                    nodes: [
                      { __typename: "CrossReferencedEvent", willCloseTarget: true, source: pull(20) },
                      { __typename: "CrossReferencedEvent", willCloseTarget: false, source: { __typename: "Issue" } },
                      { __typename: "ConnectedEvent", subject: pull(20) },
                      { __typename: "ConnectedEvent", subject: pull(21) },
                    ],
                  },
                },
              },
            },
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run<object, unknown>(find(GitHubIssues.tools(deps), "issue"), {
          repo: "acme/widgets",
          issue: "#12",
          comment_limit: 10,
        })
        expect(graphql(github.requests)[0]?.variables).toEqual({
          owner: "acme",
          name: "widgets",
          number: 12,
          comments: true,
          commentLimit: 10,
        })
        expect(result).toEqual({
          repo: "acme/widgets",
          number: 12,
          title: "Crash on start",
          url: "https://github.com/acme/widgets/issues/12",
          state: "open",
          locked: false,
          author: { login: "alice", kind: "human" },
          body: "It crashes.",
          labels: ["bug"],
          assignees: [],
          milestone: { number: 3, title: "v1" },
          created_at: "2026-01-01T00:00:00Z",
          linked_pull_requests: [
            {
              repo: "acme/widgets",
              number: 20,
              title: "Fix 20",
              url: "https://github.com/acme/widgets/pull/20",
              state: "merged",
              closes: true,
            },
            {
              repo: "acme/widgets",
              number: 21,
              title: "Fix 21",
              url: "https://github.com/acme/widgets/pull/21",
              state: "merged",
            },
          ],
          comments_total: 9,
          comments: [
            {
              id: "IC_1",
              database_id: 101,
              author: { login: "bob", kind: "human" },
              body: "Same here",
              created_at: "2026-01-03T00:00:00Z",
              url: "https://github.com/acme/widgets/issues/12#issuecomment-101",
              hidden: "outdated",
            },
          ],
        })
      }),
    ),
  )

  it.live("issue_update closes with a reason and adds and removes labels after authorizing", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "PATCH /repos/acme/widgets/issues/12": {
            body: { html_url: "https://github.com/acme/widgets/issues/12", state: "closed" },
          },
          "POST /repos/acme/widgets/issues/12/labels": { body: [] },
          "DELETE /repos/acme/widgets/issues/12/labels/needs%20triage": {
            status: 404,
            body: { message: "Label does not exist" },
          },
          "PUT /repos/acme/widgets/issues/12/lock": { status: 204 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const result = yield* run<object, unknown>(find(GitHubIssues.tools(deps), "issue_update"), {
          repo: "acme/widgets",
          issue: 12,
          state: "closed",
          state_reason: "not_planned",
          add_labels: ["wontfix"],
          remove_labels: ["needs triage"],
          lock: true,
        })
        expect(asserted.map((item) => [item.action, item.resources])).toEqual([
          ["github_issue_update", ["github.com/acme/widgets"]],
        ])
        expect(rest(github.requests)).toEqual([
          ["PATCH", "/repos/acme/widgets/issues/12", { state: "closed", state_reason: "not_planned" }],
          ["POST", "/repos/acme/widgets/issues/12/labels", { labels: ["wontfix"] }],
          ["DELETE", "/repos/acme/widgets/issues/12/labels/needs%20triage", undefined],
          ["PUT", "/repos/acme/widgets/issues/12/lock", undefined],
        ])
        expect(result).toEqual({
          number: 12,
          url: "https://github.com/acme/widgets/issues/12",
          state: "closed",
          changed: ["state: closed (not_planned)", "added labels: wontfix", "removed labels: needs triage", "locked"],
        })
      }),
    ),
  )

  it.live("comment posts to the issue comments API or to a discussion thread", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "POST /repos/acme/widgets/issues/7/comments": {
            body: { node_id: "IC_new", html_url: "https://github.com/acme/widgets/pull/7#issuecomment-1" },
          },
          "GRAPHQL discussion(number: $number) { id }": { body: { repository: { discussion: { id: "D_5" } } } },
          "GRAPHQL addDiscussionComment": {
            body: {
              addDiscussionComment: {
                comment: { id: "DC_new", url: "https://github.com/acme/widgets/discussions/5#discussioncomment-1" },
              },
            },
          },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubIssues.tools(deps), "comment")
        const onIssue = yield* run(tool, { repo: "acme/widgets", on: 7, body: "Thanks!" })
        const onDiscussion = yield* run(tool, {
          repo: "acme/widgets",
          discussion: 5,
          reply_to: "DC_parent",
          body: "Agreed",
        })
        expect(onIssue).toEqual({ id: "IC_new", url: "https://github.com/acme/widgets/pull/7#issuecomment-1" })
        expect(onDiscussion).toEqual({
          id: "DC_new",
          url: "https://github.com/acme/widgets/discussions/5#discussioncomment-1",
        })
        expect(rest(github.requests)).toEqual([["POST", "/repos/acme/widgets/issues/7/comments", { body: "Thanks!" }]])
        expect(graphql(github.requests).map((body) => body.variables)).toEqual([
          { owner: "acme", name: "widgets", number: 5 },
          { discussionId: "D_5", body: "Agreed", replyToId: "DC_parent" },
        ])
        expect(asserted.map((item) => item.action)).toEqual(["github_comment", "github_comment"])

        const both = yield* run(tool, { repo: "acme/widgets", on: 7, discussion: 5, body: "x" }).pipe(Effect.flip)
        expect(both.message).toBe("github.comment: Pass exactly one of on or discussion.")
      }),
    ),
  )

  it.live("comment_update routes edits by node type and hides with the uppercase classifier", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GRAPHQL node(id: $id)": (request) => {
            const id = (request.body as { variables: { id: string } }).variables.id
            if (id === "DC_9")
              return {
                body: {
                  node: {
                    __typename: "DiscussionComment",
                    url: "https://old",
                    discussion: { repository: { nameWithOwner: "acme/widgets" } },
                  },
                },
              }
            // A comment from another repository is authorized against that repository, not the one passed in.
            return {
              body: {
                node: { __typename: "IssueComment", url: "https://x", repository: { nameWithOwner: "acme/other" } },
              },
            }
          },
          "GRAPHQL updateDiscussionComment(": {
            body: { result: { comment: { url: "https://github.com/acme/widgets/discussions/5#c" } } },
          },
          "GRAPHQL { minimizeComment(": { body: { minimizeComment: { minimizedComment: { isMinimized: true } } } },
          "PATCH /repos/acme/widgets/issues/comments/555": {
            body: { node_id: "IC_555", html_url: "https://github.com/acme/widgets/issues/1#issuecomment-555" },
          },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubIssues.tools(deps), "comment_update")
        const edited = yield* run(tool, { repo: "acme/widgets", id: "DC_9", body: "Edited" })
        const hidden = yield* run(tool, { repo: "acme/widgets", id: "IC_3", hide: "off_topic" })
        const rested = yield* run(tool, { repo: "acme/widgets", id: "555", body: "REST edit" })
        expect(edited).toEqual({ id: "DC_9", action: "edited", url: "https://github.com/acme/widgets/discussions/5#c" })
        expect(hidden).toEqual({ id: "IC_3", action: "hidden" })
        expect(rested).toEqual({
          id: "IC_555",
          action: "edited",
          url: "https://github.com/acme/widgets/issues/1#issuecomment-555",
        })
        const calls = graphql(github.requests)
        expect(calls.map((body) => body.variables)).toEqual([
          { id: "DC_9" },
          { id: "DC_9", body: "Edited" },
          { id: "IC_3" },
          { id: "IC_3", classifier: "OFF_TOPIC" },
        ])
        expect(calls[1]?.query).toContain("updateDiscussionComment(input: { commentId: $id")
        expect(calls[3]?.query).toContain("minimizeComment(input:")
        expect(asserted.map((item) => item.resources)).toEqual([
          ["github.com/acme/widgets"],
          ["github.com/acme/other"],
          ["github.com/acme/widgets"],
        ])
        expect(rest(github.requests)).toEqual([
          ["PATCH", "/repos/acme/widgets/issues/comments/555", { body: "REST edit" }],
        ])
      }),
    ),
  )

  it.live("comment_update rejects prototype node types without authorizing or sending a mutation", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GRAPHQL node(id: $id)": (request) => ({
            body: {
              node: {
                __typename: (request.body as Body).variables.id,
                repository: { nameWithOwner: "acme/widgets" },
              },
            },
          }),
          // Keep the pre-fix non-string query path deterministic so the assertions can detect it.
          "GRAPHQL ": { body: {} },
          "POST /graphql": { body: {} },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubIssues.tools(deps), "comment_update")
        const cases = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"].flatMap((typename) =>
          ["edit", "delete"].map((action) => ({ typename, action })),
        )
        const failures = yield* Effect.forEach(cases, ({ typename, action }) =>
          run(tool, {
            repo: "acme/widgets",
            id: typename,
            ...(action === "edit" ? { body: "Edited" } : { delete: true }),
          }).pipe(Effect.flip),
        )

        expect(failures.map((error) => error.message)).toEqual(
          cases.map(
            ({ typename }) =>
              `github.comment_update: ${typename} is a ${typename}, not a comment this tool can change.`,
          ),
        )
        const calls = graphql(github.requests)
        expect(calls).toHaveLength(cases.length)
        expect(calls.every((request) => request.query.includes("node(id: $id)"))).toBe(true)
        expect(rest(github.requests)).toEqual([])
        expect(asserted).toEqual([])
      }),
    ),
  )

  it.live("comment_update edits and deletes all supported comment types", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const types = ["IssueComment", "DiscussionComment", "PullRequestReviewComment"] as const
        const operations = types.flatMap((typename) =>
          ["edit", "delete"].map((action) => ({ typename, action, id: `${typename}-${action}` })),
        )
        const github = fakeGitHub({
          "GRAPHQL node(id: $id)": (request) => {
            const id = String((request.body as Body).variables.id)
            const typename = id.slice(0, id.lastIndexOf("-"))
            return {
              body: {
                node: {
                  __typename: typename,
                  repository: { nameWithOwner: "acme/widgets" },
                  ...(typename === "DiscussionComment"
                    ? { discussion: { repository: { nameWithOwner: "acme/widgets" } } }
                    : {}),
                },
              },
            }
          },
          "GRAPHQL updateIssueComment(": { body: { result: { comment: { url: "https://example.test/issue" } } } },
          "GRAPHQL updateDiscussionComment(": {
            body: { result: { comment: { url: "https://example.test/discussion" } } },
          },
          "GRAPHQL updatePullRequestReviewComment(": {
            body: { result: { comment: { url: "https://example.test/review" } } },
          },
          "GRAPHQL deleteIssueComment(": { body: { result: { clientMutationId: "issue" } } },
          "GRAPHQL deleteDiscussionComment(": { body: { result: { clientMutationId: "discussion" } } },
          "GRAPHQL deletePullRequestReviewComment(": { body: { result: { clientMutationId: "review" } } },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubIssues.tools(deps), "comment_update")
        const outputs = yield* Effect.forEach(operations, ({ id, action }) =>
          run(tool, {
            repo: "acme/widgets",
            id,
            ...(action === "edit" ? { body: "Edited" } : { delete: true }),
          }),
        )

        expect(outputs).toHaveLength(operations.length)
        const mutations = graphql(github.requests)
          .filter(({ query }) => query.includes("mutation"))
          .map(({ query }) => query)
        expect(mutations).toHaveLength(operations.length)
        expect(
          [
            "updateIssueComment",
            "updateDiscussionComment",
            "updatePullRequestReviewComment",
            "deleteIssueComment",
            "deleteDiscussionComment",
            "deletePullRequestReviewComment",
          ].every((name) => mutations.some((query) => query.includes(name))),
        ).toBe(true)
        expect(asserted).toHaveLength(operations.length)
      }),
    ),
  )
})
