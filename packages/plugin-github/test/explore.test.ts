import { describe, expect } from "bun:test"
import { appendFileSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { GitHubExplore } from "../src/explore.js"
import { it, withEnv, withTempDir } from "./lib"
import { fakeGitHub, find, makeDeps, run, type Reply, type Route } from "./fixture"

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined, GH_HOST: undefined }

const setup = (routes: Record<string, Reply | Route>, directory?: string) =>
  Effect.gen(function* () {
    const github = fakeGitHub(routes)
    const made = yield* makeDeps({ http: github.http, ...(directory ? { directory } : {}) })
    const tools = GitHubExplore.tools(made.deps)
    return { github, asserted: made.asserted, tool: (name: string) => find(tools, name) }
  })

const repoPayload = {
  id: 42,
  full_name: "acme/widgets",
  html_url: "https://github.com/acme/widgets",
  description: "Widgets",
  visibility: "public",
  private: false,
  default_branch: "main",
  topics: ["widgets"],
  language: "TypeScript",
  archived: false,
  fork: false,
  stargazers_count: 12,
  open_issues_count: 3,
  has_issues: true,
  has_wiki: false,
  has_projects: false,
  has_discussions: true,
  pushed_at: "2026-01-02T00:00:00Z",
  permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
  allow_merge_commit: false,
  allow_squash_merge: true,
  allow_rebase_merge: false,
  allow_auto_merge: true,
  delete_branch_on_merge: true,
  squash_merge_commit_title: "PR_TITLE",
  squash_merge_commit_message: "PR_BODY",
  merge_commit_title: "MERGE_MESSAGE",
  merge_commit_message: "PR_TITLE",
  has_pull_requests: true,
  pull_request_creation_policy: "all",
  allow_forking: false,
  web_commit_signoff_required: true,
  custom_properties: { team: "platform" },
}

const commit = (sha: string, message: string, parents = 1, login = "octo") => ({
  sha,
  html_url: `https://github.com/acme/widgets/commit/${sha}`,
  commit: { message, author: { name: "Octo Cat", email: "octo@example.com", date: "2026-01-01T00:00:00Z" } },
  author: { login },
  committer: { login: "web-flow" },
  parents: Array.from({ length: parents }, (_, index) => ({ sha: `${index}`.repeat(40) })),
})

describe("github explore tools", () => {
  it.live("repo degrades sections without access to available: false and summarizes the default branch rules", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool } = yield* setup({
          "GET /repos/acme/widgets": { body: repoPayload },
          "GET /repos/acme/widgets/immutable-releases": { body: { enabled: true, enforced_by_owner: false } },
          "GET /repos/acme/widgets/branches/main/protection": {
            status: 403,
            body: { message: "Must have admin rights to Repository." },
          },
          "GET /repos/acme/widgets/rules/branches/main": {
            body: [
              {
                type: "required_status_checks",
                ruleset_id: 9,
                parameters: {
                  strict_required_status_checks_policy: true,
                  required_status_checks: [{ context: "ci/test" }, { context: "lint", integration_id: 15368 }],
                },
              },
              { type: "pull_request", ruleset_id: 9, parameters: { required_approving_review_count: 1 } },
              { type: "deletion", ruleset_id: 9 },
            ],
          },
          "GET /repos/acme/widgets/rulesets": {
            body: [
              {
                id: 9,
                name: "main",
                target: "branch",
                enforcement: "active",
                source: "acme/widgets",
                source_type: "Repository",
              },
            ],
          },
          "GET /repos/acme/widgets/code-scanning/default-setup": {
            status: 403,
            body: { message: "Resource not accessible by integration" },
          },
          "GET /repos/acme/widgets/actions/permissions": { status: 403, body: { message: "Must have admin rights" } },
          "GET /repos/acme/widgets/actions/permissions/workflow": {
            status: 403,
            body: { message: "Must have admin rights" },
          },
          "GET /repos/acme/widgets/environments": {
            body: {
              total_count: 1,
              environments: [
                {
                  name: "production",
                  protection_rules: [{ type: "required_reviewers" }, { type: "wait_timer" }],
                  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
                },
              ],
            },
          },
          "GET /repos/acme/widgets/contents/.github/CODEOWNERS": { status: 404, body: { message: "Not Found" } },
          "GET /repos/acme/widgets/contents/CODEOWNERS": {
            body: {
              content: Buffer.from("# owners\n* @acme/core\n\n/docs @acme/docs\n").toString("base64"),
              html_url: "https://github.com/acme/widgets/blob/main/CODEOWNERS",
            },
          },
        })
        const result = yield* run<object, unknown>(tool("repo"), { repo: "acme/widgets" })
        expect(result).toEqual({
          repo: "acme/widgets",
          url: "https://github.com/acme/widgets",
          general: {
            available: true,
            description: "Widgets",
            visibility: "public",
            default_branch: "main",
            topics: ["widgets"],
            language: "TypeScript",
            archived: false,
            fork: false,
            stars: 12,
            open_issues: 3,
            has_issues: true,
            has_wiki: false,
            has_projects: false,
            has_discussions: true,
            has_pull_requests: true,
            pull_request_creation: "all",
            allow_forking: false,
            commit_signoff_required: true,
            release_immutability: true,
            custom_properties: { team: "platform" },
            permission: "push",
            pushed_at: "2026-01-02T00:00:00Z",
          },
          merging: {
            available: true,
            allow_merge_commit: false,
            allow_squash_merge: true,
            allow_rebase_merge: false,
            allow_auto_merge: true,
            delete_branch_on_merge: true,
            squash_merge_commit_title: "PR_TITLE",
            squash_merge_commit_message: "PR_BODY",
            merge_commit_title: "MERGE_MESSAGE",
            merge_commit_message: "PR_TITLE",
            // The settings page's names for these title and message pairs.
            merge_commit_default: "Default message",
            squash_commit_default: "Pull request title and description",
          },
          protection: {
            available: true,
            branch: "main",
            classic_note: "requires admin access",
            rules: [
              {
                type: "required_status_checks",
                ruleset_id: 9,
                parameters: { contexts: ["ci/test", "lint"], strict: true },
              },
              { type: "pull_request", ruleset_id: 9, parameters: { required_approving_review_count: 1 } },
              { type: "deletion", ruleset_id: 9 },
            ],
          },
          rulesets: {
            available: true,
            rulesets: [{ id: 9, name: "main", target: "branch", enforcement: "active", source: "acme/widgets" }],
          },
          security: {
            available: false,
            reason: "requires admin access",
            notes: [
              "code scanning default setup: requires security_events access",
              "security_and_analysis and Dependabot alert settings require admin access",
            ],
          },
          actions: { available: false, reason: "requires admin access" },
          environments: {
            available: true,
            environments: [
              {
                name: "production",
                protections: ["required_reviewers", "wait_timer"],
                deployment_branches: "protected branches",
              },
            ],
          },
          codeowners: {
            available: true,
            path: "CODEOWNERS",
            rules: 2,
            preview: "# owners\n* @acme/core\n\n/docs @acme/docs\n",
            url: "https://github.com/acme/widgets/blob/main/CODEOWNERS",
          },
        })
        expect(github.requests.find((request) => request.path === "/repos/acme/widgets/rulesets")?.query).toEqual({
          includes_parents: "true",
          per_page: "100",
        })
        expect(github.requests.some((request) => request.path.endsWith("/vulnerability-alerts"))).toBe(false)
      }),
    ),
  )

  it.live("repo reads classic protection and admin security settings when visible", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { tool } = yield* setup({
          "GET /repos/acme/widgets": {
            body: {
              ...repoPayload,
              security_and_analysis: {
                secret_scanning: { status: "enabled" },
                secret_scanning_push_protection: { status: "disabled" },
              },
            },
          },
          "GET /repos/acme/widgets/branches/main/protection": {
            body: {
              required_status_checks: {
                strict: false,
                contexts: ["build"],
                checks: [{ context: "build" }, { context: "e2e" }],
              },
              required_pull_request_reviews: {
                required_approving_review_count: 2,
                require_code_owner_reviews: true,
                dismiss_stale_reviews: false,
              },
              enforce_admins: { enabled: true },
              required_linear_history: { enabled: true },
              required_signatures: { enabled: false },
              required_conversation_resolution: { enabled: true },
              allow_force_pushes: { enabled: false },
              allow_deletions: { enabled: false },
            },
          },
          "GET /repos/acme/widgets/rules/branches/main": { body: [] },
          "GET /repos/acme/widgets/code-scanning/default-setup": {
            body: { state: "configured", languages: ["javascript"], query_suite: "default" },
          },
          "GET /repos/acme/widgets/vulnerability-alerts": { status: 204 },
        })
        const result = yield* run<object, unknown>(tool("repo"), {
          repo: "acme/widgets",
          sections: ["protection", "security"],
        })
        expect(result).toEqual({
          repo: "acme/widgets",
          url: "https://github.com/acme/widgets",
          protection: {
            available: true,
            branch: "main",
            classic: {
              required_checks: ["build", "e2e"],
              strict_checks: false,
              required_reviews: 2,
              code_owner_reviews: true,
              dismiss_stale: false,
              enforce_admins: true,
              linear_history: true,
              signed_commits: false,
              conversation_resolution: true,
              force_pushes: false,
              deletions: false,
            },
            rules: [],
          },
          security: {
            available: true,
            security_and_analysis: { secret_scanning: "enabled", secret_scanning_push_protection: "disabled" },
            code_scanning_default_setup: { state: "configured", languages: ["javascript"], query_suite: "default" },
            dependabot_alerts: true,
          },
        })
      }),
    ),
  )

  it.live("search scopes repository searches to the repository and maps issues", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool } = yield* setup({
          "GET /search/issues": {
            body: {
              total_count: 1,
              items: [
                {
                  number: 5,
                  title: "Flaky test",
                  state: "open",
                  user: { login: "octo" },
                  html_url: "https://github.com/acme/widgets/issues/5",
                  updated_at: "2026-01-03T00:00:00Z",
                  repository_url: "https://api.github.com/repos/acme/widgets",
                },
              ],
            },
          },
        })
        const result = yield* run<object, unknown>(tool("search"), {
          type: "issues",
          query: "flaky",
          repo: "acme/widgets",
          limit: 5,
        })
        expect(result).toEqual({
          query: "flaky repo:acme/widgets is:issue",
          total: 1,
          items: [
            {
              repo: "acme/widgets",
              number: 5,
              title: "Flaky test",
              state: "open",
              author: "octo",
              url: "https://github.com/acme/widgets/issues/5",
              updated_at: "2026-01-03T00:00:00Z",
            },
          ],
        })
        expect(github.requests.map((request) => request.query)).toEqual([
          { q: "flaky repo:acme/widgets is:issue", per_page: "5" },
        ])

        yield* run(tool("search"), { type: "prs", query: "org:other is:pr review:required", repo: "acme/widgets" })
        expect(github.requests[1]?.query.q).toBe("org:other is:pr review:required")
      }),
    ),
  )

  it.live("search owner scope uses org: for organizations and user: for users, and code requests text matches", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool } = yield* setup({
          "GET /users/acme": { body: { login: "acme", type: "Organization" } },
          "GET /users/octo": { body: { login: "octo", type: "User" } },
          "GET /search/code": {
            body: {
              total_count: 1,
              items: [
                {
                  path: "src/retry.ts",
                  html_url: "https://github.com/acme/widgets/blob/main/src/retry.ts",
                  repository: { full_name: "acme/widgets" },
                  text_matches: [{ fragment: "retry(3)" }],
                },
              ],
            },
          },
        })
        const code = yield* run<object, unknown>(tool("search"), {
          type: "code",
          query: "retry",
          scope: "owner",
          repo: "acme/widgets",
        })
        expect(code).toEqual({
          query: "retry org:acme",
          total: 1,
          items: [
            {
              repo: "acme/widgets",
              path: "src/retry.ts",
              url: "https://github.com/acme/widgets/blob/main/src/retry.ts",
              fragments: ["retry(3)"],
            },
          ],
        })
        const codeRequest = github.requests.find((request) => request.path === "/search/code")
        expect(codeRequest?.headers.accept).toBe("application/vnd.github.text-match+json")

        yield* run(tool("search"), { type: "code", query: "retry", scope: "owner", repo: "octo/dotfiles" })
        expect(
          github.requests.filter((request) => request.path === "/search/code").map((request) => request.query.q),
        ).toEqual(["retry org:acme", "retry user:octo"])
      }),
    ),
  )

  it.live("search maps commits, repositories, users and discussions; repository searches default to global", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool } = yield* setup({
          "GET /search/commits": {
            body: {
              total_count: 1,
              items: [{ ...commit("c".repeat(40), "Fix retry\n\nDetails"), repository: { full_name: "acme/widgets" } }],
            },
          },
          "GET /search/repositories": {
            body: {
              total_count: 1,
              items: [
                {
                  full_name: "acme/gears",
                  description: null,
                  stargazers_count: 4,
                  language: "Go",
                  pushed_at: "2026-01-04T00:00:00Z",
                  archived: true,
                  html_url: "https://github.com/acme/gears",
                },
              ],
            },
          },
          "GET /search/users": {
            body: { total_count: 1, items: [{ login: "octo", type: "User", html_url: "https://github.com/octo" }] },
          },
          "GRAPHQL type: DISCUSSION": {
            body: {
              search: {
                discussionCount: 1,
                nodes: [
                  {
                    number: 3,
                    title: "Roadmap",
                    url: "https://github.com/acme/widgets/discussions/3",
                    isAnswered: null,
                    updatedAt: "2026-01-05T00:00:00Z",
                    repository: { nameWithOwner: "acme/widgets" },
                  },
                ],
              },
            },
          },
        })
        expect(yield* run(tool("search"), { type: "commits", query: "retry", repo: "acme/widgets" })).toEqual({
          query: "retry repo:acme/widgets",
          total: 1,
          items: [
            {
              repo: "acme/widgets",
              sha: "c".repeat(40),
              message: "Fix retry",
              author: "octo",
              date: "2026-01-01T00:00:00Z",
              url: `https://github.com/acme/widgets/commit/${"c".repeat(40)}`,
            },
          ],
        })
        expect(yield* run(tool("search"), { type: "repos", query: "gears", repo: "acme/widgets" })).toEqual({
          query: "gears",
          total: 1,
          items: [
            {
              full_name: "acme/gears",
              description: null,
              stars: 4,
              language: "Go",
              pushed_at: "2026-01-04T00:00:00Z",
              archived: true,
              url: "https://github.com/acme/gears",
            },
          ],
        })
        expect(yield* run(tool("search"), { type: "users", query: "octo" })).toEqual({
          query: "octo",
          total: 1,
          items: [{ login: "octo", type: "User", url: "https://github.com/octo" }],
        })
        expect(
          yield* run(tool("search"), { type: "discussions", query: "roadmap", repo: "acme/widgets", limit: 3 }),
        ).toEqual({
          query: "roadmap repo:acme/widgets",
          total: 1,
          items: [
            {
              repo: "acme/widgets",
              number: 3,
              title: "Roadmap",
              url: "https://github.com/acme/widgets/discussions/3",
              answered: false,
              updated_at: "2026-01-05T00:00:00Z",
            },
          ],
        })
        expect(github.requests.at(-1)?.body).toMatchObject({
          variables: { query: "roadmap repo:acme/widgets", first: 3 },
        })
      }),
    ),
  )

  it.live("commits filters by message and merges client-side and stops paging once the limit is met", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const pageOne = Array.from({ length: 100 }, (_, index) =>
          index === 10
            ? commit("a".repeat(40), "Fix the retry loop")
            : index === 20
              ? commit("m".repeat(40), "fix: merge main into release", 2)
              : commit(`${index}`.padStart(40, "e"), `chore ${index}`),
        )
        const pageTwo = Array.from({ length: 100 }, (_, index) =>
          index === 5
            ? commit("b".repeat(40), "fix: cache key", 1, "hubot")
            : index === 6
              ? commit("d".repeat(40), "FIX typo")
              : commit(`${index}`.padStart(40, "f"), `docs ${index}`),
        )
        const { github, tool } = yield* setup({
          "GET /repos/acme/widgets/commits": (request) => ({
            body: request.query.page === "1" ? pageOne : request.query.page === "2" ? pageTwo : [],
          }),
        })
        const result = yield* run<object, unknown>(tool("commits"), {
          repo: "acme/widgets",
          ref: "release",
          author: "octo@example.com",
          grep: "^fix",
          merges: "exclude",
          limit: 2,
        })
        expect(result).toEqual({
          commits: [
            {
              sha: "a".repeat(40),
              short: "aaaaaaa",
              message: "Fix the retry loop",
              author: { login: "octo", name: "Octo Cat", date: "2026-01-01T00:00:00Z" },
              committer_login: "web-flow",
              parents: ["0000000"],
              url: `https://github.com/acme/widgets/commit/${"a".repeat(40)}`,
            },
            {
              sha: "b".repeat(40),
              short: "bbbbbbb",
              message: "fix: cache key",
              author: { login: "hubot", name: "Octo Cat", date: "2026-01-01T00:00:00Z" },
              committer_login: "web-flow",
              parents: ["0000000"],
              url: `https://github.com/acme/widgets/commit/${"b".repeat(40)}`,
            },
          ],
          scanned: 200,
          more: true,
        })
        expect(github.requests.map((request) => request.query)).toEqual([
          { sha: "release", author: "octo@example.com", per_page: "100", page: "1" },
          { sha: "release", author: "octo@example.com", per_page: "100", page: "2" },
        ])
      }),
    ),
  )

  it.live("compare maps counts, the newest commits and files", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool } = yield* setup({
          "GET /repos/acme/widgets/compare/main...feature/x": {
            body: {
              status: "diverged",
              ahead_by: 2,
              behind_by: 1,
              total_commits: 2,
              html_url: "https://github.com/acme/widgets/compare/main...feature/x",
              merge_base_commit: { sha: "9".repeat(40) },
              commits: [commit("a".repeat(40), "First"), commit("b".repeat(40), "Second\nbody")],
              files: [{ filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@" }],
            },
          },
        })
        const result = yield* run<object, unknown>(tool("compare"), {
          repo: "acme/widgets",
          base: "main",
          head: "feature/x",
          files: true,
          limit: 1,
        })
        expect(result).toEqual({
          status: "diverged",
          ahead_by: 2,
          behind_by: 1,
          merge_base: "9".repeat(40),
          url: "https://github.com/acme/widgets/compare/main...feature/x",
          total_commits: 2,
          commits: [
            {
              sha: "b".repeat(40),
              short: "bbbbbbb",
              message: "Second",
              author: { login: "octo", name: "Octo Cat", date: "2026-01-01T00:00:00Z" },
              committer_login: "web-flow",
              parents: ["0000000"],
              url: `https://github.com/acme/widgets/commit/${"b".repeat(40)}`,
            },
          ],
          files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }],
        })
        expect(github.requests).toHaveLength(1)
      }),
    ),
  )

  it.live("repos aggregates a contributor's commits per repository, newest first", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const hit = (repo: string, date: string) => ({
          commit: { author: { date }, committer: { date } },
          repository: { full_name: repo, private: false, fork: false, html_url: `https://github.com/${repo}` },
        })
        const detail = (name: string, stars: number) => ({
          full_name: name,
          description: null,
          private: name.endsWith("secret"),
          archived: false,
          fork: false,
          language: "Go",
          stargazers_count: stars,
          pushed_at: "2026-02-01T00:00:00Z",
          default_branch: "main",
          html_url: `https://github.com/${name}`,
        })
        const { github, tool } = yield* setup({
          "GET /users/acme": { body: { login: "acme", type: "Organization" } },
          "GET /search/commits": {
            body: {
              total_count: 3,
              items: [
                hit("acme/widgets", "2026-01-01T00:00:00Z"),
                hit("acme/secret", "2026-01-10T00:00:00Z"),
                hit("acme/widgets", "2026-01-05T00:00:00Z"),
              ],
            },
          },
          "GET /repos/acme/widgets": { body: detail("acme/widgets", 5) },
          "GET /repos/acme/secret": { body: detail("acme/secret", 1) },
          "GET /repos/acme/quiet": { body: detail("acme/quiet", 0) },
          // The calendar knows a repository the capped commit search missed, and a larger count for another.
          "GRAPHQL commitContributionsByRepository": {
            body: {
              user: {
                contributionsCollection: {
                  commitContributionsByRepository: [
                    { repository: { nameWithOwner: "acme/widgets" }, contributions: { totalCount: 40, nodes: [] } },
                    {
                      repository: { nameWithOwner: "acme/quiet" },
                      contributions: { totalCount: 3, nodes: [{ occurredAt: "2025-12-01T00:00:00Z" }] },
                    },
                    {
                      repository: { nameWithOwner: "elsewhere/tool" },
                      contributions: { totalCount: 9, nodes: [{ occurredAt: "2026-01-20T00:00:00Z" }] },
                    },
                  ],
                },
              },
            },
          },
        })
        const result = yield* run<object, unknown>(tool("repos"), { owner: "acme", contributor: "octo" })
        expect(result).toEqual({
          owner: "acme",
          owner_type: "org",
          repositories: [
            {
              full_name: "acme/secret",
              private: true,
              archived: false,
              fork: false,
              language: "Go",
              stars: 1,
              pushed_at: "2026-02-01T00:00:00Z",
              default_branch: "main",
              url: "https://github.com/acme/secret",
              commits_by_contributor: 1,
              last_commit_by_contributor: "2026-01-10T00:00:00Z",
            },
            {
              full_name: "acme/widgets",
              private: false,
              archived: false,
              fork: false,
              language: "Go",
              stars: 5,
              pushed_at: "2026-02-01T00:00:00Z",
              default_branch: "main",
              url: "https://github.com/acme/widgets",
              commits_by_contributor: 40,
              last_commit_by_contributor: "2026-01-05T00:00:00Z",
            },
            {
              full_name: "acme/quiet",
              private: false,
              archived: false,
              fork: false,
              language: "Go",
              stars: 0,
              pushed_at: "2026-02-01T00:00:00Z",
              default_branch: "main",
              url: "https://github.com/acme/quiet",
              commits_by_contributor: 3,
              last_commit_by_contributor: "2025-12-01T00:00:00Z",
            },
          ],
        })
        expect(github.requests.find((request) => request.path === "/search/commits")?.query).toEqual({
          q: "author:octo org:acme",
          sort: "author-date",
          order: "desc",
          per_page: "100",
        })
      }),
    ),
  )

  it.live("upload posts the raw bytes with the token scheme and returns image or video markdown", () =>
    withEnv(env, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "shot.png"), "PNGDATA"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "demo.mp4"), "MP4DATA"))
          const { github, asserted, tool } = yield* setup(
            {
              "GET /repos/acme/widgets": { body: repoPayload },
              "POST /user-attachments/assets": (request) => ({
                status: 201,
                body: { url: `https://github.com/user-attachments/assets/${request.query.name}` },
              }),
            },
            tmp.path,
          )
          const image = yield* run<object, unknown>(tool("upload"), {
            path: "shot.png",
            repo: "acme/widgets",
            alt: "Login [page]",
          })
          expect(image).toEqual({
            url: "https://github.com/user-attachments/assets/shot.png",
            markdown: "![Login page](https://github.com/user-attachments/assets/shot.png)",
            name: "shot.png",
            bytes: 7,
            content_type: "image/png",
          })
          const posted = github.requests.find((request) => request.method === "POST")
          expect(posted?.url.startsWith("https://uploads.github.com/user-attachments/assets?")).toBe(true)
          expect(posted?.query).toEqual({ name: "shot.png", content_type: "image/png", repository_id: "42" })
          expect(posted?.headers.authorization).toBe("token test-token")
          expect(posted?.headers["content-type"]).toBe("application/octet-stream")
          expect(posted?.body).toBe("PNGDATA")
          expect(asserted.map((item) => [item.action, item.resources])).toEqual([
            ["github_upload", ["github.com/acme/widgets"]],
          ])

          const video = yield* run<object, unknown>(tool("upload"), {
            path: path.join(tmp.path, "demo.mp4"),
            repo: "acme/widgets",
          })
          expect(video).toEqual({
            url: "https://github.com/user-attachments/assets/demo.mp4",
            markdown: "https://github.com/user-attachments/assets/demo.mp4",
            name: "demo.mp4",
            bytes: 7,
            content_type: "video/mp4",
          })
        }),
      ),
    ),
  )

  it.live("upload fails as unsupported on GitHub Enterprise Server and rejects unknown types before any request", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool } = yield* setup({})
        const ghes = yield* Effect.flip(
          run(tool("upload"), { path: "/tmp/shot.png", repo: "ghe.example.com/acme/widgets" }),
        )
        expect(ghes).toMatchObject({ metadata: { kind: "unsupported" } })
        expect(ghes.message).toContain("ghe.example.com does not support user attachment uploads.")
        expect(ghes.message).toContain("release as an asset")
        const text = yield* Effect.flip(run(tool("upload"), { path: "/tmp/notes.txt", repo: "acme/widgets" }))
        expect(text).toMatchObject({ metadata: { kind: "validation" } })
        expect(github.requests).toEqual([])
      }),
    ),
  )

  it.live("upload explains a 404 from the attachments endpoint", () =>
    withEnv(env, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "shot.gif"), "GIF"))
          const { tool } = yield* setup(
            {
              "GET /repos/acme/widgets": { body: repoPayload },
              "POST /user-attachments/assets": { status: 404, body: { message: "Not Found" } },
            },
            tmp.path,
          )
          const error = yield* Effect.flip(run(tool("upload"), { path: "shot.gif", repo: "acme/widgets" }))
          expect(error.message).toContain("rejects GitHub App installation tokens")
          expect(error.message).toContain(`gh issue comment <number> --attach ${path.join(tmp.path, "shot.gif")}`)
        }),
      ),
    ),
  )

  it.live("upload rejects an image that grows after the size check instead of uploading past the authorized size", () =>
    withEnv(env, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "shot.png")
          yield* Effect.promise(() => fs.writeFile(file, "PNGDATA"))
          const { github, tool } = yield* setup(
            {
              // The repository lookup sits between the size check and the read; grow the file there.
              "GET /repos/acme/widgets": () => {
                appendFileSync(file, "MORE")
                return { body: repoPayload }
              },
              "POST /user-attachments/assets": {
                status: 201,
                body: { url: "https://github.com/user-attachments/assets/shot.png" },
              },
            },
            tmp.path,
          )
          const error = yield* Effect.flip(run(tool("upload"), { path: "shot.png", repo: "acme/widgets" }))
          expect(error).toMatchObject({ metadata: { kind: "validation" } })
          expect(error.message).toContain("changed while being read")
          expect(github.requests.filter((request) => request.method === "POST")).toEqual([])
        }),
      ),
    ),
  )

  it.live("upload rejects a video that grows after the size check instead of uploading past the authorized size", () =>
    withEnv(env, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "demo.mp4")
          yield* Effect.promise(() => fs.writeFile(file, "MP4DATA"))
          const { github, tool } = yield* setup(
            {
              "GET /repos/acme/widgets": () => {
                appendFileSync(file, "MORE")
                return { body: repoPayload }
              },
              "POST /user-attachments/assets": {
                status: 201,
                body: { url: "https://github.com/user-attachments/assets/demo.mp4" },
              },
            },
            tmp.path,
          )
          const error = yield* Effect.flip(run(tool("upload"), { path: "demo.mp4", repo: "acme/widgets" }))
          expect(error).toMatchObject({ metadata: { kind: "validation" } })
          expect(error.message).toContain("changed while being read")
          expect(github.requests.filter((request) => request.method === "POST")).toEqual([])
        }),
      ),
    ),
  )

  it.live("upload rejects a file replaced by one over the limit after the size check", () =>
    withEnv(env, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "shot.png")
          yield* Effect.promise(() => fs.writeFile(file, "PNGDATA"))
          const { github, tool } = yield* setup(
            {
              "GET /repos/acme/widgets": () => {
                writeFileSync(file, Buffer.alloc(10 * 1024 * 1024 + 1))
                return { body: repoPayload }
              },
              "POST /user-attachments/assets": {
                status: 201,
                body: { url: "https://github.com/user-attachments/assets/shot.png" },
              },
            },
            tmp.path,
          )
          const error = yield* Effect.flip(run(tool("upload"), { path: "shot.png", repo: "acme/widgets" }))
          expect(error).toMatchObject({ metadata: { kind: "validation" } })
          expect(error.message).toContain("over the 10485760-byte upload limit")
          expect(github.requests.filter((request) => request.method === "POST")).toEqual([])
        }),
      ),
    ),
  )

  it.live("upload accepts a file exactly at the image limit and rejects one byte over before uploading", () =>
    withEnv(env, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const max = 10 * 1024 * 1024
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "full.png"), Buffer.alloc(max, 1)))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "over.png"), Buffer.alloc(max + 1, 1)))
          const { github, tool } = yield* setup(
            {
              "GET /repos/acme/widgets": { body: repoPayload },
              "POST /user-attachments/assets": (request) => ({
                status: 201,
                body: { url: `https://github.com/user-attachments/assets/${request.query.name}` },
              }),
            },
            tmp.path,
          )
          const image = yield* run<object, unknown>(tool("upload"), { path: "full.png", repo: "acme/widgets" })
          expect(image).toMatchObject({ name: "full.png", bytes: max, content_type: "image/png" })
          const error = yield* Effect.flip(run(tool("upload"), { path: "over.png", repo: "acme/widgets" }))
          expect(error).toMatchObject({ metadata: { kind: "validation" } })
          expect(error.message).toContain("may be at most 10 MB")
          expect(github.requests.filter((request) => request.method === "POST")).toHaveLength(1)
        }),
      ),
    ),
  )

  it.live("api fills placeholders, asks permission only for writes and mutations, and paginates wrapped lists", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, asserted, tool } = yield* setup({
          "GET /repos/acme/widgets/topics": { body: { names: ["widgets"] } },
          "PUT /repos/acme/widgets/topics": (request) => ({ body: request.body }),
          "GET /repos/acme/widgets/actions/runs": (request) =>
            request.query.page === "2"
              ? { body: { total_count: 3, workflow_runs: [{ id: 3 }] } }
              : {
                  body: { total_count: 3, workflow_runs: [{ id: 1 }, { id: 2 }] },
                  headers: { link: '<https://api.github.com/repos/acme/widgets/actions/runs?page=2>; rel="next"' },
                },
          "GRAPHQL viewer": { body: { viewer: { login: "octo" } } },
          "GRAPHQL addStar": { body: { addStar: { starrable: { id: "R_1" } } } },
        })
        expect(yield* run(tool("api"), { path: "/repos/{owner}/{repo}/topics", repo: "acme/widgets" })).toEqual({
          status: 200,
          data: { names: ["widgets"] },
        })
        expect(asserted).toEqual([])

        expect(
          yield* run(tool("api"), {
            method: "PUT",
            path: "repos/{owner}/{repo}/topics",
            body: { names: ["a"] },
            repo: "acme/widgets",
          }),
        ).toEqual({ status: 200, data: { names: ["a"] } })
        expect(asserted.map((item) => [item.action, item.resources, item.metadata])).toEqual([
          ["github_api", ["github.com/acme/widgets"], { method: "PUT", path: "/repos/acme/widgets/topics" }],
        ])

        expect(
          yield* run(tool("api"), {
            path: "/repos/{owner}/{repo}/actions/runs",
            paginate: true,
            limit: 10,
            repo: "acme/widgets",
          }),
        ).toEqual({ data: [{ id: 1 }, { id: 2 }, { id: 3 }], items: 3 })
        expect(
          github.requests.filter((request) => request.path.endsWith("/actions/runs")).map((request) => request.query),
        ).toEqual([{ per_page: "10" }, { page: "2" }])

        expect(yield* run(tool("api"), { graphql: "query { viewer { login } }", repo: "acme/widgets" })).toEqual({
          data: { viewer: { login: "octo" } },
        })
        expect(asserted).toHaveLength(1)
        yield* run(tool("api"), {
          graphql: 'mutation { addStar(input: { starrableId: "R_1" }) { starrable { id } } }',
          repo: "acme/widgets",
        })
        expect(asserted.map((item) => item.action)).toEqual(["github_api", "github_api"])
        expect(asserted[1]?.resources).toEqual(["github.com/acme/widgets"])

        const absolute = yield* Effect.flip(
          run(tool("api"), { path: "https://evil.example.com/x", repo: "acme/widgets" }),
        )
        expect(absolute.message).toContain("path must be relative")
      }),
    ),
  )
})
