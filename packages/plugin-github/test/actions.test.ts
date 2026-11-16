import { describe, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { GitHubActions } from "../src/actions.js"
import { it, withEnv } from "./lib"
import { fakeGitHub, find, makeDeps, run, type Reply, type Route } from "./fixture"

const unwrap = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined }

/**
 * Wraps the JSON fake: answers `METHOD /path` keys in `raw` with plain text (job logs), and records each request's
 * query, which the fake cannot see because Effect keeps URL parameters apart from the URL.
 */
function wrap(github: ReturnType<typeof fakeGitHub>, raw: Record<string, string> = {}) {
  const queries: Array<{ path: string; query: Record<string, string> }> = []
  const http = HttpClient.make((request) => {
    const url = new URL(request.url)
    queries.push({
      path: url.pathname,
      query: Object.fromEntries(request.urlParams.params.map(([key, value]) => [key, unwrap(value)] as const)),
    })
    const text = raw[`${request.method} ${url.pathname}`]
    if (text === undefined) return github.http.execute(request)
    github.requests.push({
      method: request.method,
      url: request.url,
      path: url.pathname,
      query: {},
      headers: request.headers,
      body: undefined,
    })
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(text, { status: 200, headers: { "content-type": "text/plain" } }),
      ),
    )
  })
  return { http, queries }
}

const runData = {
  id: 500,
  name: "CI",
  display_title: "Fix the parser",
  event: "push",
  status: "completed",
  conclusion: "failure",
  head_branch: "main",
  head_sha: "abcdef1234567890",
  run_attempt: 2,
  html_url: "https://github.com/acme/widgets/actions/runs/500",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:05:30Z",
  run_started_at: "2026-01-01T00:00:00Z",
}

const jobs = [
  {
    id: 900,
    name: "test (linux)",
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/acme/widgets/actions/runs/500/job/900",
    started_at: "2026-01-01T00:01:00Z",
    completed_at: "2026-01-01T00:05:00Z",
    steps: [
      { number: 1, name: "Checkout", status: "completed", conclusion: "success" },
      { number: 2, name: "Test", status: "completed", conclusion: "failure" },
      { number: 3, name: "Upload", status: "completed", conclusion: "skipped" },
    ],
  },
  {
    id: 901,
    name: "lint",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/acme/widgets/actions/runs/500/job/901",
    started_at: "2026-01-01T00:01:00Z",
    completed_at: "2026-01-01T00:02:00Z",
    steps: [{ number: 1, name: "Lint", status: "completed", conclusion: "success" }],
  },
]

const LOG = [
  "\uFEFF2026-01-01T00:01:00.1234567Z ##[group]Run bun test",
  "2026-01-01T00:01:01.0000000Z running 3 tests",
  "2026-01-01T00:01:02.0000000Z ok parse",
  "2026-01-01T00:01:03.0000000Z FAIL tokenize: expected 2",
  "2026-01-01T00:01:04.0000000Z ok format",
  "2026-01-01T00:01:05.0000000Z ##[error]Process completed with exit code 1.",
  "",
].join("\n")

describe("github actions tools", () => {
  it.live("runs passes filters as query parameters and resolves workflows by file, name and pull request", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/actions/workflows/ci.yml/runs": {
            body: { total_count: 1, workflow_runs: [runData] },
          },
          "GET /repos/acme/widgets/actions/workflows": {
            body: {
              workflows: [
                { id: 11, name: "Release", path: ".github/workflows/release.yml", state: "active", html_url: "x" },
              ],
            },
          },
          "GET /repos/acme/widgets/actions/workflows/11/runs": { body: { workflow_runs: [] } },
          "GET /repos/acme/widgets/pulls/7": { body: { head: { ref: "feature-x", sha: "f".repeat(40) } } },
          "GET /repos/acme/widgets/actions/runs": { body: { workflow_runs: [] } },
        })
        const http = wrap(github)
        const { deps } = yield* makeDeps({ http: http.http })
        const runs = find(GitHubActions.tools(deps), "runs")

        const byFile = yield* run(runs, {
          repo: "acme/widgets",
          workflow: "ci.yml",
          branch: "main",
          status: "failure",
          limit: 2,
        })
        expect(byFile).toEqual({
          runs: [
            {
              id: 500,
              workflow: "CI",
              title: "Fix the parser",
              event: "push",
              status: "completed",
              conclusion: "failure",
              branch: "main",
              sha: "abcdef1",
              attempt: 2,
              url: "https://github.com/acme/widgets/actions/runs/500",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:05:30Z",
              duration_seconds: 330,
            },
          ],
        })
        expect(http.queries).toEqual([
          {
            path: "/repos/acme/widgets/actions/workflows/ci.yml/runs",
            query: { per_page: "2", branch: "main", status: "failure" },
          },
        ])

        yield* run(runs, { repo: "acme/widgets", workflow: "release", event: "workflow_dispatch" })
        expect(http.queries.slice(1)).toEqual([
          { path: "/repos/acme/widgets/actions/workflows", query: { per_page: "100" } },
          {
            path: "/repos/acme/widgets/actions/workflows/11/runs",
            query: { per_page: "20", event: "workflow_dispatch" },
          },
        ])

        const forPull = yield* run(runs, { repo: "acme/widgets", pr: 7 })
        expect(forPull).toEqual({ runs: [], head_sha: "f".repeat(40) })
        expect(http.queries.slice(3)).toEqual([
          { path: "/repos/acme/widgets/pulls/7", query: {} },
          { path: "/repos/acme/widgets/actions/runs", query: { per_page: "20", branch: "feature-x" } },
        ])
      }),
    ),
  )

  it.live("run reports failed steps, annotations of failed jobs only, artifacts and next steps", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/actions/runs/500": { body: runData },
          "GET /repos/acme/widgets/actions/runs/500/jobs": { body: { total_count: 2, jobs } },
          "GET /repos/acme/widgets/check-runs/900/annotations": {
            body: [
              {
                path: "src/parse.ts",
                start_line: 12,
                annotation_level: "failure",
                title: "tokenize",
                message: "expected 2, got 3",
              },
              {
                path: ".github",
                start_line: null,
                annotation_level: "failure",
                title: null,
                message: "Process completed with exit code 1.",
              },
            ],
          },
          "GET /repos/acme/widgets/actions/runs/500/artifacts": {
            body: {
              artifacts: [
                {
                  id: 70,
                  name: "coverage",
                  size_in_bytes: 2048,
                  expired: false,
                  created_at: "2026-01-01T00:05:00Z",
                  workflow_run: { id: 500 },
                },
              ],
            },
          },
        })
        const http = wrap(github)
        const { deps } = yield* makeDeps({ http: http.http })
        const output = yield* run(find(GitHubActions.tools(deps), "run"), {
          repo: "acme/widgets",
          run: "https://github.com/acme/widgets/actions/runs/500",
        })
        expect(output).toEqual({
          id: 500,
          name: "CI",
          title: "Fix the parser",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/acme/widgets/actions/runs/500",
          event: "push",
          branch: "main",
          sha: "abcdef1",
          attempt: 2,
          jobs: [
            {
              id: 900,
              name: "test (linux)",
              status: "completed",
              conclusion: "failure",
              url: "https://github.com/acme/widgets/actions/runs/500/job/900",
              started_at: "2026-01-01T00:01:00Z",
              completed_at: "2026-01-01T00:05:00Z",
              failed_steps: [{ number: 2, name: "Test", status: "completed", conclusion: "failure" }],
            },
            {
              id: 901,
              name: "lint",
              status: "completed",
              conclusion: "success",
              url: "https://github.com/acme/widgets/actions/runs/500/job/901",
              started_at: "2026-01-01T00:01:00Z",
              completed_at: "2026-01-01T00:02:00Z",
              failed_steps: [],
            },
          ],
          annotations: [
            {
              job: "test (linux)",
              path: "src/parse.ts",
              line: 12,
              level: "failure",
              title: "tokenize",
              message: "expected 2, got 3",
            },
            { job: "test (linux)", path: ".github", level: "failure", message: "Process completed with exit code 1." },
          ],
          artifacts: [
            { id: 70, name: "coverage", bytes: 2048, expired: false, created_at: "2026-01-01T00:05:00Z", run_id: 500 },
          ],
          next: [
            'logs({ job: 900 }) for the failing job "test (linux)"',
            'run_action({ run: 500, action: "rerun_failed" }) to retry only the failed jobs',
            "artifact_download({ artifact: <id> }) to fetch an artifact",
          ],
        })
        expect(github.requests.map((request) => `${request.method} ${request.path}`).sort()).toEqual([
          "GET /repos/acme/widgets/actions/runs/500",
          "GET /repos/acme/widgets/actions/runs/500/artifacts",
          "GET /repos/acme/widgets/actions/runs/500/jobs",
          "GET /repos/acme/widgets/check-runs/900/annotations",
        ])
        expect(http.queries.find((request) => request.path.endsWith("/jobs"))?.query).toEqual({
          per_page: "100",
          filter: "latest",
        })
      }),
    ),
  )

  it.live("logs strips timestamps, tails, greps with context, saves the full log, and defaults to failed jobs", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/actions/jobs/900": { body: jobs[0] },
          "GET /repos/acme/widgets/actions/runs/500/jobs": { body: { jobs } },
        })
        const { deps } = yield* makeDeps({
          http: wrap(github, {
            "GET /repos/acme/widgets/actions/jobs/900/logs": LOG,
            "GET /repos/acme/widgets/actions/jobs/901/logs": "2026-01-01T00:01:00.0000000Z lint ok\n",
          }).http,
        })
        const logs = find(GitHubActions.tools(deps), "logs")

        const tail = yield* run(logs, { repo: "acme/widgets", job: 900, tail: 2 })
        expect(tail).toEqual({
          jobs: [
            {
              id: 900,
              name: "test (linux)",
              conclusion: "failure",
              lines: 6,
              text: "… [4 earlier lines omitted]\nok format\n##[error]Process completed with exit code 1.",
              truncated: true,
            },
          ],
        })

        const stamped = yield* run<object, { jobs: Array<{ text: string }> }>(logs, {
          repo: "acme/widgets",
          job: "https://github.com/acme/widgets/actions/runs/500/job/900",
          tail: 1,
          timestamps: true,
        })
        expect(stamped.jobs[0].text).toBe(
          "… [5 earlier lines omitted]\n2026-01-01T00:01:05.0000000Z ##[error]Process completed with exit code 1.",
        )

        const grep = yield* run<object, { jobs: Array<{ text: string; path?: string }> }>(logs, {
          repo: "acme/widgets",
          run: 500,
          grep: "fail|error",
          context: 0,
          save: true,
        })
        expect(grep.jobs.map((job) => job.text)).toEqual([
          "4: FAIL tokenize: expected 2\n--\n6: ##[error]Process completed with exit code 1.",
        ])
        expect(grep.jobs[0].path).toEndWith(path.join("opencode-github", "logs", "acme-widgets-900.log"))
        expect(yield* Effect.promise(() => readFile(grep.jobs[0].path ?? "", "utf8"))).toBe(LOG.slice(1))

        const context = yield* run<object, { jobs: Array<{ text: string }> }>(logs, {
          repo: "acme/widgets",
          job: 900,
          grep: "tokenize",
          context: 1,
        })
        expect(context.jobs[0].text).toBe("3: ok parse\n4: FAIL tokenize: expected 2\n5: ok format")

        const all = yield* run<object, { jobs: Array<{ id: number }> }>(logs, {
          repo: "acme/widgets",
          run: 500,
          failed_only: false,
          job_name: "LINT",
        })
        expect(all.jobs.map((job) => job.id)).toEqual([901])
        expect(
          github.requests.filter((request) => request.path.endsWith("/logs")).map((request) => request.path),
        ).toEqual([
          "/repos/acme/widgets/actions/jobs/900/logs",
          "/repos/acme/widgets/actions/jobs/900/logs",
          "/repos/acme/widgets/actions/jobs/900/logs",
          "/repos/acme/widgets/actions/jobs/900/logs",
          "/repos/acme/widgets/actions/jobs/901/logs",
        ])
      }),
    ),
  )

  it.live("run_action posts to the endpoint of each action after asking permission", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const accepted: Reply = { status: 201, body: {} }
        const github = fakeGitHub({
          "POST /repos/acme/widgets/actions/runs/500/rerun": accepted,
          "POST /repos/acme/widgets/actions/runs/500/rerun-failed-jobs": accepted,
          "POST /repos/acme/widgets/actions/runs/500/cancel": { status: 202, body: {} },
          "POST /repos/acme/widgets/actions/runs/500/force-cancel": { status: 202, body: {} },
          "POST /repos/acme/widgets/actions/runs/500/approve": accepted,
          "POST /repos/acme/widgets/actions/jobs/900/rerun": accepted,
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubActions.tools(deps), "run_action")
        for (const action of ["rerun", "rerun_failed", "cancel", "force_cancel", "approve"])
          yield* run(tool, { repo: "acme/widgets", run: 500, action })
        const job = yield* run(tool, { repo: "acme/widgets", job: 900, action: "rerun", debug: true })
        expect(job).toEqual({
          action: "rerun",
          job: 900,
          status: "accepted",
          message: "Job 900 queued to re-run. Check progress with run({ run: <run id> }).",
        })
        expect(github.requests.map((request) => [request.method, request.path, request.body])).toEqual([
          ["POST", "/repos/acme/widgets/actions/runs/500/rerun", undefined],
          ["POST", "/repos/acme/widgets/actions/runs/500/rerun-failed-jobs", undefined],
          ["POST", "/repos/acme/widgets/actions/runs/500/cancel", undefined],
          ["POST", "/repos/acme/widgets/actions/runs/500/force-cancel", undefined],
          ["POST", "/repos/acme/widgets/actions/runs/500/approve", undefined],
          ["POST", "/repos/acme/widgets/actions/jobs/900/rerun", { enable_debug_logging: true }],
        ])
        expect(asserted.map((item) => [item.action, item.resources])).toEqual(
          Array.from({ length: 6 }, () => ["github_run_action", ["github.com/acme/widgets"]]),
        )
        const misuse = yield* run(tool, { repo: "acme/widgets", job: 900, action: "cancel" }).pipe(Effect.flip)
        expect(String(misuse)).toContain("cancel applies to a run")
      }),
    ),
  )

  it.live("dispatch returns the run from return_run_details, or finds it after a 204", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const workflow = {
          id: 11,
          name: "Deploy",
          path: ".github/workflows/deploy.yml",
          state: "active",
          html_url: "x",
        }
        const dispatches: Route[] = [
          () => ({
            status: 200,
            body: {
              workflow_run_id: 777,
              run_url: "api",
              html_url: "https://github.com/acme/widgets/actions/runs/777",
            },
          }),
          () => ({ status: 204 }),
        ]
        const github = fakeGitHub({
          "GET /repos/acme/widgets/actions/workflows/deploy.yml": { body: workflow },
          "GET /repos/acme/widgets": { body: { default_branch: "main" } },
          "POST /repos/acme/widgets/actions/workflows/11/dispatches": (request) => dispatches.shift()?.(request),
          "GET /repos/acme/widgets/actions/workflows/11/runs": () => ({
            body: {
              workflow_runs: [
                {
                  ...runData,
                  id: 778,
                  event: "workflow_dispatch",
                  created_at: new Date().toISOString(),
                  html_url: "https://github.com/acme/widgets/actions/runs/778",
                },
                { ...runData, id: 100, event: "workflow_dispatch", created_at: "2020-01-01T00:00:00Z" },
              ],
            },
          }),
        })
        const http = wrap(github)
        const { deps, asserted } = yield* makeDeps({ http: http.http })
        const tool = find(GitHubActions.tools(deps), "dispatch")

        const direct = yield* run(tool, {
          repo: "acme/widgets",
          workflow: "deploy.yml",
          inputs: { env: "prod", dry: true, count: 2 },
        })
        expect(direct).toEqual({
          workflow: "Deploy",
          ref: "main",
          run_id: 777,
          url: "https://github.com/acme/widgets/actions/runs/777",
        })
        expect(github.requests.find((request) => request.method === "POST")?.body).toEqual({
          ref: "main",
          inputs: { env: "prod", dry: "true", count: "2" },
          return_run_details: true,
        })

        const fallback = yield* run(tool, { repo: "acme/widgets", workflow: "deploy.yml", ref: "refs/heads/release" })
        expect(fallback).toEqual({
          workflow: "Deploy",
          ref: "refs/heads/release",
          run_id: 778,
          url: "https://github.com/acme/widgets/actions/runs/778",
        })
        const lookup = http.queries.at(-1)
        expect(lookup?.path).toBe("/repos/acme/widgets/actions/workflows/11/runs")
        expect(lookup?.query).toMatchObject({ event: "workflow_dispatch", branch: "release", per_page: "5" })
        expect(lookup?.query.created).toMatch(/^>=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
        expect(asserted.map((item) => item.action)).toEqual(["github_dispatch", "github_dispatch"])
      }),
    ),
  )

  it.live("workflows inspect reports workflow_dispatch inputs", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const yaml = [
          "name: Deploy",
          "on:",
          "  push:",
          "    branches: [main]",
          "  workflow_dispatch:",
          "    inputs:",
          "      environment:",
          "        description: Where to deploy",
          "        required: true",
          "        type: choice",
          "        options: [dev, prod]",
          "      dry_run:",
          "        type: boolean",
          "        default: 'false' # safe",
          "jobs:",
          "  deploy:",
          "    runs-on: ubuntu-latest",
        ].join("\n")
        const github = fakeGitHub({
          "GET /repos/acme/widgets/actions/workflows": {
            body: {
              workflows: [
                {
                  id: 11,
                  name: "Deploy",
                  path: ".github/workflows/deploy.yml",
                  state: "active",
                  html_url: "https://github.com/acme/widgets/actions/workflows/deploy.yml",
                },
                {
                  id: 12,
                  name: "CI",
                  path: ".github/workflows/ci.yml",
                  state: "disabled_manually",
                  html_url: "https://github.com/acme/widgets/actions/workflows/ci.yml",
                },
              ],
            },
          },
          "GET /repos/acme/widgets/contents/.github/workflows/deploy.yml": {
            body: { content: Buffer.from(yaml).toString("base64") },
          },
          "GET /repos/acme/widgets/contents/.github/workflows/ci.yml": {
            body: { content: Buffer.from("on: [push, pull_request]\njobs: {}\n").toString("base64") },
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const output = yield* run(find(GitHubActions.tools(deps), "workflows"), { repo: "acme/widgets", inspect: true })
        expect(output).toEqual({
          workflows: [
            {
              id: 11,
              name: "Deploy",
              file: "deploy.yml",
              path: ".github/workflows/deploy.yml",
              state: "active",
              url: "https://github.com/acme/widgets/actions/workflows/deploy.yml",
              dispatch: true,
              inputs: [
                { name: "environment", required: true, type: "choice" },
                { name: "dry_run", type: "boolean", default: "false" },
              ],
            },
            {
              id: 12,
              name: "CI",
              file: "ci.yml",
              path: ".github/workflows/ci.yml",
              state: "disabled_manually",
              url: "https://github.com/acme/widgets/actions/workflows/ci.yml",
              dispatch: false,
              inputs: [],
            },
          ],
        })
        expect(GitHubActions.dispatchInfo("on: workflow_dispatch\n")).toEqual({ dispatch: true, inputs: [] })
      }),
    ),
  )
})
