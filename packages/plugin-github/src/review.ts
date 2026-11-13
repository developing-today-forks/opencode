export * as GitHubReview from "./review.js"

import { Session } from "@opencode/schema/session"
import type { Tool } from "@opencode/schema/tool"
import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Result, Schema } from "effect"
import { GitHubClient } from "./client.js"
import { GitHubCopilot } from "./copilot.js"
import { GitHubPreferences } from "./preferences.js"
import { GitHubRepo } from "./repo.js"
import { GitHubShared } from "./shared.js"

type Deps = GitHubShared.Deps
type Api = GitHubClient.Api

// ---------------------------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------------------------

const Author = GitHubShared.Author

const Finding = Schema.Struct({
  title: Schema.String,
  severity: Schema.optionalKey(Schema.String),
  comment_id: Schema.optionalKey(Schema.Int),
  new: Schema.Boolean,
})

export const CopilotStatus = Schema.Struct({
  state: Schema.Literals(["reviewed", "in_progress", "requested", "stale", "none"]).annotate({
    description:
      "reviewed: latest review covers the head commit. in_progress: Copilot is reviewing. requested: waiting for Copilot to start. stale: the head changed since the last review and none is pending. none: never reviewed.",
  }),
  since: Schema.optionalKey(Schema.String),
  stuck: Schema.Boolean,
  rounds: Schema.Int.annotate({ description: "Copilot reviews submitted on this pull request." }),
  reviewed_commit: Schema.optionalKey(Schema.String),
  reviewed_at: Schema.optionalKey(Schema.String),
  reviewed_head: Schema.Boolean,
  verdict: Schema.optionalKey(Schema.Literals(["approve", "changes", "closer_look", "clean", "comments", "unknown"])),
  approved: Schema.Boolean.annotate({
    description:
      "Copilot never submits an approving review. True when its latest review covers the head commit and recommends approval or found nothing.",
  }),
  headline: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  open_findings: Schema.optionalKey(Schema.Int),
  body_findings: Schema.Int.annotate({
    description: "Findings only in the review body (low confidence, previously missed), with no thread.",
  }),
  findings: Schema.Array(Finding),
})
export type CopilotStatus = typeof CopilotStatus.Type

const Checks = Schema.Struct({
  state: Schema.String.annotate({ description: "SUCCESS, FAILURE, PENDING, ERROR, EXPECTED or NONE." }),
  total: Schema.Int.annotate({ description: "Distinct checks; a re-run counts once, by its latest result." }),
  passed: Schema.Int,
  pending: Schema.Array(Schema.String),
  required_pending: Schema.Array(Schema.String),
  stalled: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      queued_minutes: Schema.Int,
      url: Schema.optionalKey(Schema.String),
      runner: Schema.optionalKey(Schema.String).annotate({ description: "The runner labels the job is waiting for." }),
    }),
  ).annotate({ description: "Queued for over 10 minutes without starting, usually because no runner matches." }),
  failing: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      conclusion: Schema.String,
      required: Schema.Boolean,
      url: Schema.optionalKey(Schema.String),
    }),
  ),
})

const ItemKind = Schema.Literals(["thread", "copilot_body", "alert", "comment", "review"])

const Reply = Schema.Struct({ author: Author, body: Schema.String, created_at: Schema.String })

export const Item = Schema.Struct({
  id: Schema.String.annotate({ description: "Pass to respond." }),
  kind: ItemKind,
  author: Author,
  title: Schema.optionalKey(Schema.String),
  body: Schema.String,
  path: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Int),
  end_line: Schema.optionalKey(Schema.Int),
  severity: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String).annotate({
    description:
      "low_confidence or previously_missed for Copilot body findings, the tool for alerts, the state for reviews.",
  }),
  url: Schema.optionalKey(Schema.String),
  created_at: Schema.optionalKey(Schema.String),
  resolved: Schema.Boolean,
  outdated: Schema.optionalKey(Schema.Boolean),
  new: Schema.Boolean.annotate({ description: "Not returned to this session before, or has new replies since." }),
  suggestion: Schema.optionalKey(Schema.Boolean),
  replies: Schema.optionalKey(Schema.Array(Reply)),
  actions: Schema.Array(Schema.String).annotate({ description: "What respond can do with this item." }),
})
export type Item = typeof Item.Type

const PRRef = Schema.Struct({ repo: Schema.String, number: Schema.Int, url: Schema.String, head: Schema.String })

// ---------------------------------------------------------------------------------------------------------------
// GitHub data
// ---------------------------------------------------------------------------------------------------------------

interface GqlAuthor {
  readonly login: string
  readonly __typename?: string
}

interface CheckNode {
  readonly __typename: string
  readonly name?: string
  readonly status?: string
  readonly conclusion?: string | null
  readonly detailsUrl?: string | null
  readonly startedAt?: string | null
  readonly completedAt?: string | null
  readonly checkSuite?: { readonly createdAt: string } | null
  readonly context?: string
  readonly state?: string
  readonly targetUrl?: string | null
  readonly createdAt?: string
  readonly isRequired?: boolean
}

interface PullData {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: "OPEN" | "CLOSED" | "MERGED"
  readonly isDraft: boolean
  readonly author: GqlAuthor | null
  readonly baseRefName: string
  readonly baseRefOid: string
  readonly headRefName: string
  readonly headRefOid: string
  readonly headRepository: { readonly nameWithOwner: string } | null
  readonly mergeable: string
  readonly mergeStateStatus: string
  readonly reviewDecision: string | null
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  readonly autoMergeRequest: { readonly mergeMethod: string } | null
  readonly commits: {
    readonly totalCount: number
    readonly nodes: ReadonlyArray<{
      readonly commit: {
        readonly oid: string
        readonly statusCheckRollup: {
          readonly state: string
          readonly contexts: { readonly totalCount: number; readonly nodes: ReadonlyArray<CheckNode> }
        } | null
      }
    }>
  }
  readonly reviewRequests: {
    readonly nodes: ReadonlyArray<{
      readonly requestedReviewer: { readonly login?: string; readonly name?: string } | null
    }>
  }
  readonly latestOpinionatedReviews: {
    readonly nodes: ReadonlyArray<{ readonly state: string; readonly author: GqlAuthor | null }>
  }
  readonly comments: {
    readonly nodes: ReadonlyArray<{
      readonly id: string
      readonly author: GqlAuthor | null
      readonly body: string
      readonly createdAt: string
      readonly url: string
      readonly isMinimized: boolean
    }>
  }
}

const PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number title url state isDraft author { login __typename }
      baseRefName baseRefOid headRefName headRefOid headRepository { nameWithOwner }
      mergeable mergeStateStatus reviewDecision additions deletions changedFiles
      autoMergeRequest { mergeMethod }
      commits(last: 1) { totalCount nodes { commit { oid statusCheckRollup { state contexts(first: 100) { totalCount nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl startedAt completedAt checkSuite { createdAt } isRequired(pullRequestNumber: $number) }
        ... on StatusContext { context state targetUrl createdAt isRequired(pullRequestNumber: $number) }
      } } } } } }
      reviewRequests(first: 30) { nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Team { name } } } }
      latestOpinionatedReviews(first: 30) { nodes { state author { login __typename } } }
      comments(last: 100) { nodes { id author { login __typename } body createdAt url isMinimized } }
    }
  }
}`

interface ThreadData {
  readonly id: string
  readonly isResolved: boolean
  readonly isOutdated: boolean
  readonly path: string
  readonly line: number | null
  readonly startLine: number | null
  readonly originalLine: number | null
  readonly comments: {
    readonly totalCount: number
    readonly nodes: ReadonlyArray<{
      readonly databaseId: number
      readonly author: GqlAuthor | null
      readonly body: string
      readonly createdAt: string
      readonly url: string
    }>
  }
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine originalLine
          comments(first: 40) { totalCount nodes { databaseId author { login __typename } body createdAt url } }
        }
      }
    }
  }
}`

interface RestReview {
  readonly id: number
  readonly node_id: string
  readonly user: { readonly login: string; readonly type: string } | null
  readonly body: string | null
  readonly state: string
  readonly commit_id: string | null
  readonly submitted_at?: string
  readonly html_url: string
}

interface RestEvent {
  readonly event: string
  readonly created_at?: string
  readonly submitted_at?: string
  readonly requested_reviewer?: { readonly login: string } | null
}

interface Alert {
  readonly number: number
  readonly state: string
  readonly html_url: string
  readonly created_at: string
  readonly dismissed_reason?: string | null
  readonly rule: {
    readonly id: string
    readonly description?: string
    readonly severity?: string
    readonly security_severity_level?: string | null
  }
  readonly tool: { readonly name: string }
  readonly most_recent_instance: {
    readonly message?: { readonly text?: string }
    readonly location?: { readonly path?: string; readonly start_line?: number; readonly end_line?: number }
  }
}

const pull = (api: Api, repo: GitHubRepo.Ref, number: number) =>
  api
    .graphql<{ repository: { pullRequest: PullData | null } | null }>(PULL_QUERY, {
      owner: repo.owner,
      name: repo.name,
      number,
    })
    .pipe(
      Effect.flatMap((data) =>
        data.repository?.pullRequest
          ? Effect.succeed(data.repository.pullRequest)
          : Effect.fail(
              new GitHubClient.Error({
                kind: "not_found",
                message: `Pull request ${GitHubRepo.slug(repo)}#${number} not found`,
              }),
            ),
      ),
    )

interface ThreadsPage {
  readonly repository: {
    readonly pullRequest: {
      readonly reviewThreads: {
        readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null }
        readonly nodes: ReadonlyArray<ThreadData>
      }
    }
  }
}

const threads = Effect.fn("GitHubReview.threads")(function* (api: Api, repo: GitHubRepo.Ref, number: number) {
  const all: ThreadData[] = []
  let cursor: string | null = null
  do {
    const page: ThreadsPage = yield* api.graphql<ThreadsPage>(THREADS_QUERY, {
      owner: repo.owner,
      name: repo.name,
      number,
      cursor,
    })
    all.push(...page.repository.pullRequest.reviewThreads.nodes)
    cursor = page.repository.pullRequest.reviewThreads.pageInfo.hasNextPage
      ? page.repository.pullRequest.reviewThreads.pageInfo.endCursor
      : null
  } while (cursor)
  return all
})

const reviews = (api: Api, repo: GitHubRepo.Ref, number: number) =>
  api.paginate<RestReview>(`/repos/${GitHubRepo.slug(repo)}/pulls/${number}/reviews`, { limit: 500 })

// The timeline is oldest-first and Copilot's progress is at its end, so read only the last two pages.
const timeline = Effect.fn("GitHubReview.timeline")(function* (api: Api, repo: GitHubRepo.Ref, number: number) {
  const path = `/repos/${GitHubRepo.slug(repo)}/issues/${number}/timeline`
  const first = yield* api.request<RestEvent[]>("GET", path, { query: { per_page: 100 } })
  const last = GitHubClient.link(first.headers.link, "last")
  const page = last ? Number(new URL(last).searchParams.get("page")) : 1
  const tail =
    page > 1
      ? yield* Effect.forEach(
          [page - 1, page].filter((value) => value > 1),
          (value) => api.json<RestEvent[]>("GET", path, { query: { per_page: 100, page: value } }),
          { concurrency: 2 },
        )
      : []
  return [...first.data, ...tail.flat()].map(
    (event): GitHubCopilot.TimelineEvent => ({
      event: event.event,
      at: event.created_at ?? event.submitted_at ?? "",
      ...(event.requested_reviewer?.login ? { reviewer: event.requested_reviewer.login } : {}),
    }),
  )
})

const copilotPending = (api: Api, repo: GitHubRepo.Ref, number: number) =>
  api
    .json<{
      users: ReadonlyArray<{ login: string }>
    }>("GET", `/repos/${GitHubRepo.slug(repo)}/pulls/${number}/requested_reviewers`)
    .pipe(Effect.map((data) => data.users.some((user) => GitHubCopilot.authorKind(user.login) === "copilot")))

const copilotReviews = (all: ReadonlyArray<RestReview>) =>
  all.flatMap((review) =>
    GitHubCopilot.authorKind(review.user?.login, review.user?.type) === "copilot" && review.submitted_at
      ? [{ id: review.id, commit: review.commit_id ?? "", at: review.submitted_at, body: review.body ?? "" }]
      : [],
  )

const copilotStatus = Effect.fn("GitHubReview.copilotStatus")(function* (
  api: Api,
  repo: GitHubRepo.Ref,
  number: number,
  head: string,
  all: ReadonlyArray<RestReview>,
) {
  const [events, pending, now] = yield* Effect.all(
    [timeline(api, repo, number), copilotPending(api, repo, number), Clock.currentTimeMillis],
    { concurrency: "unbounded" },
  )
  const state = GitHubCopilot.state({ head, reviews: copilotReviews(all), events, pending, now })
  return status(state, head)
})

function status(state: GitHubCopilot.State, head: string): CopilotStatus {
  const parsed = state.latest ? GitHubCopilot.parseReview(state.latest.body) : undefined
  const onHead = state.latest?.commit === head
  return {
    state: state.state,
    ...(state.since ? { since: state.since } : {}),
    stuck: state.stuck,
    rounds: state.rounds,
    ...(state.latest ? { reviewed_commit: state.latest.commit, reviewed_at: state.latest.at } : {}),
    reviewed_head: onHead,
    ...(parsed ? { verdict: parsed.verdict } : {}),
    approved: onHead && (parsed?.verdict === "approve" || parsed?.verdict === "clean"),
    ...(parsed?.headline ? { headline: parsed.headline } : {}),
    ...(parsed?.summary ? { summary: parsed.summary } : {}),
    ...(parsed?.open !== undefined ? { open_findings: parsed.open } : {}),
    body_findings: parsed?.body.length ?? 0,
    findings: (parsed?.findings ?? []).map((finding) => ({
      title: finding.title,
      ...(finding.severity ? { severity: finding.severity } : {}),
      ...(finding.commentID ? { comment_id: finding.commentID } : {}),
      new: finding.new,
    })),
  }
}

export const STALLED_MS = 10 * 60_000

function checks(data: PullData, now: number) {
  const rollup = data.commits.nodes[0]?.commit.statusCheckRollup
  const time = (node: CheckNode) =>
    Date.parse(node.completedAt ?? node.startedAt ?? node.createdAt ?? node.checkSuite?.createdAt ?? "") || 0
  // A workflow that runs again for the same commit (another event, a re-run) adds a second check of the same name;
  // only the latest one says anything about the commit now.
  const latest = new Map<string, CheckNode>()
  for (const node of rollup?.contexts.nodes ?? []) {
    const name = node.name ?? node.context ?? "check"
    const current = latest.get(name)
    if (!current || time(node) >= time(current)) latest.set(name, node)
  }
  const entries = [...latest].map(([name, node]) => {
    const url = node.detailsUrl ?? node.targetUrl ?? undefined
    const required = node.isRequired === true
    if (node.__typename === "CheckRun") {
      if (node.status !== "COMPLETED") {
        const queued = node.startedAt ? 0 : now - (Date.parse(node.checkSuite?.createdAt ?? "") || now)
        return { name, result: "pending" as const, conclusion: node.status ?? "PENDING", required, url, queued }
      }
      const ok = node.conclusion === "SUCCESS" || node.conclusion === "NEUTRAL" || node.conclusion === "SKIPPED"
      return {
        name,
        result: ok ? ("passed" as const) : ("failed" as const),
        conclusion: node.conclusion ?? "UNKNOWN",
        required,
        url,
        queued: 0,
      }
    }
    if (node.state === "PENDING" || node.state === "EXPECTED")
      return { name, result: "pending" as const, conclusion: node.state, required, url, queued: 0 }
    return {
      name,
      result: node.state === "SUCCESS" ? ("passed" as const) : ("failed" as const),
      conclusion: node.state ?? "UNKNOWN",
      required,
      url,
      queued: 0,
    }
  })
  const pending = entries.filter((entry) => entry.result === "pending")
  return {
    state: rollup?.state ?? "NONE",
    total: entries.length,
    passed: entries.filter((entry) => entry.result === "passed").length,
    pending: pending.map((entry) => entry.name),
    required_pending: pending.filter((entry) => entry.required).map((entry) => entry.name),
    stalled: pending
      .filter((entry) => entry.queued > STALLED_MS)
      .map((entry) => ({
        name: entry.name,
        queued_minutes: Math.floor(entry.queued / 60_000),
        ...(entry.url ? { url: entry.url } : {}),
      })),
    failing: entries
      .filter((entry) => entry.result === "failed")
      .map((entry) => ({
        name: entry.name,
        conclusion: entry.conclusion,
        required: entry.required,
        ...(entry.url ? { url: entry.url } : {}),
      })),
  }
}

/** Adds the runner labels a stalled Actions job waits for, which usually explains why it never starts. */
const explainStalled = (api: Api, repo: GitHubRepo.Ref, summary: ReturnType<typeof checks>) =>
  Effect.forEach(
    summary.stalled,
    (check) => {
      const job = /\/actions\/runs\/\d+\/job\/(\d+)/.exec(check.url ?? "")?.[1]
      if (!job) return Effect.succeed(check)
      return api
        .json<{ labels?: ReadonlyArray<string> }>("GET", `/repos/${GitHubRepo.slug(repo)}/actions/jobs/${job}`)
        .pipe(
          Effect.map((data) => (data.labels?.length ? { ...check, runner: data.labels.join(", ") } : check)),
          Effect.orElseSucceed(() => check),
        )
    },
    { concurrency: 4 },
  ).pipe(Effect.map((stalled) => ({ ...summary, stalled })))

const alerts = Effect.fn("GitHubReview.alerts")(function* (
  api: Api,
  repo: GitHubRepo.Ref,
  number: number,
  open: boolean,
) {
  return yield* api
    .paginate<Alert>(`/repos/${GitHubRepo.slug(repo)}/code-scanning/alerts`, {
      query: { pr: number, ...(open ? { state: "open" } : {}) },
      limit: 300,
    })
    .pipe(
      Effect.map((items) => ({ items, note: undefined as string | undefined })),
      // Repositories without code scanning, or tokens without security_events, answer 403 or 404.
      Effect.catchIf(
        (error) => error.kind === "not_found" || error.kind === "forbidden",
        (error) =>
          Effect.succeed({
            items: [] as Alert[],
            note: `Code scanning alerts unavailable (${error.kind}): enable code scanning or grant the security_events scope to see them.`,
          }),
      ),
    )
})

// ---------------------------------------------------------------------------------------------------------------
// Session-scoped bookkeeping
// ---------------------------------------------------------------------------------------------------------------

const prKey = (repo: GitHubRepo.Ref, number: number) => `${repo.host}/${GitHubRepo.slug(repo)}/${number}`.toLowerCase()
const seenKey = (sessionID: string, repo: GitHubRepo.Ref, number: number) =>
  `github.seen/${sessionID}/${prKey(repo, number)}`
const handledKey = (repo: GitHubRepo.Ref, number: number) => `github.handled/${prKey(repo, number)}`
const cursorKey = (sessionID: string, repo: GitHubRepo.Ref, number: number) =>
  `github.cursor/${sessionID}/${prKey(repo, number)}`

// Items with no thread to resolve (Copilot body findings, review summaries, comments that cannot be hidden) are
// recorded as handled in a hidden marker in a pull request comment, so every session and machine sees the same state.
const MARKER = /<!-- opencode-github (handled|reopened): ([^>]*?) -->/g
const marker = (kind: "handled" | "reopened", ids: ReadonlyArray<string>) =>
  ids.length ? `<!-- opencode-github ${kind}: ${ids.join(" ")} -->` : ""

/** Replays handled and reopened markers in comment order. */
export function markedHandled(comments: ReadonlyArray<{ readonly body: string }>) {
  const handled = new Set<string>()
  for (const comment of comments)
    for (const match of comment.body.matchAll(MARKER))
      for (const id of match[2].split(/\s+/).filter(Boolean)) {
        if (match[1] === "handled") handled.add(id)
        else handled.delete(id)
      }
  return handled
}

const stringList = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const readList = (deps: Deps, key: string) =>
  deps.kv.get(key).pipe(Effect.map((value) => Option.getOrElse(stringList(value), (): readonly string[] => [])))
const addToList = (deps: Deps, key: string, values: ReadonlyArray<string>, keep = 2000) =>
  readList(deps, key).pipe(
    Effect.flatMap((current) => deps.kv.set(key, Array.from(new Set([...current, ...values])).slice(-keep))),
  )

// With no checkpoint, updates reports only the latest reviews and comments instead of the whole history.
const FIRST_CHECK_LIMIT = 10

const Cursor = Schema.Struct({ at: Schema.String, head: Schema.String, base: Schema.String })
const decodeCursor = Schema.decodeUnknownOption(Cursor)

// ---------------------------------------------------------------------------------------------------------------
// Guidance
// ---------------------------------------------------------------------------------------------------------------

export function guidance(preferences: GitHubPreferences.Info & typeof GitHubPreferences.DEFAULTS) {
  const followup =
    preferences.followup_issues === "never"
      ? "do not file issues; note them for the user instead"
      : preferences.followup_issues === "ask"
        ? "ask the user before filing a follow-up issue (respond with `issue`)"
        : "resolve them with a follow-up issue (respond with `issue`) and move on"
  return [
    "Review-loop guidance:",
    "- Reviewer findings, Copilot's especially, are advice, not directives. Verify each against the code. Fix real defects; decline the rest with evidence (file:line, why).",
    "- Do not chase speculative security or edge-case hardening on already-guarded paths. Resolve it as noted and list it for the user.",
    "- Before replying fixed, search for the rule the finding names, not just its one site, and fix every instance. Re-read the file to confirm the edit landed.",
    "- Commit and push before replying, then cite the commit ({sha} in respond). Say what changed; do not paste the finding back, since bots can read echoed text as a new finding.",
    "- Work through findings autonomously; bring changes of direction (architecture, behavior, scope) to the user.",
    `- Every push gets a fresh Copilot review with new threads, so zero findings may never arrive. Judge a round by what it touches: findings on code, tests, config or CI stay worth fixing; documentation bookkeeping can be batched. After about ${preferences.review_rounds} rounds, or once findings are follow-ups to your own fixes or mostly nits, stop and hand back with a summary.`,
    "- Ready to merge means checks pass on the pushed head and no open finding is a correctness, data-loss or real security defect (pr reports blockers).",
    `- Minor, out-of-scope or follow-up findings: ${followup}.`,
    ...(preferences.notes?.length
      ? ["- Standing notes from the user:", ...preferences.notes.map((note) => `  - ${note}`)]
      : []),
  ].join("\n")
}

// ---------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------

export function tools(deps: Deps): Tool.Info[] {
  const shownGuidance = new Set<string>()
  const discovered = new Map<string, { at: number; value: Discovery }>()

  const discover = Effect.fn("GitHubReview.discover")(function* (target: GitHubShared.Target) {
    const key = `${target.repo.host}/${GitHubRepo.slug(target.repo)}`.toLowerCase()
    const now = yield* Clock.currentTimeMillis
    const cached = discovered.get(key)
    if (cached && now - cached.at < 10 * 60_000) return cached.value
    const value = yield* discovery(target)
    discovered.set(key, { at: now, value })
    return value
  })

  const preferencesFor = (target: GitHubShared.Target | undefined) =>
    Effect.gen(function* () {
      const found = target ? yield* discover(target).pipe(Effect.option) : Option.none()
      return yield* GitHubPreferences.effective(
        deps.kv,
        target?.repo,
        Option.match(found, { onNone: () => ({}), onSome: (value) => value.defaults }),
      )
    })

  const context = GitHubShared.define(deps, {
    name: "context",
    description:
      "Where am I on GitHub: the repository, viewer, permissions, current branch and its pull request, review-loop preferences and guidance. Call once per session before other github tools.",
    input: Schema.Struct({ repo: GitHubShared.RepoField }),
    output: Schema.Struct({
      repo: Schema.Struct({
        slug: Schema.String,
        host: Schema.String,
        url: Schema.String,
        default_branch: Schema.String,
        private: Schema.Boolean,
        fork: Schema.Boolean,
        parent: Schema.optionalKey(Schema.String),
        archived: Schema.Boolean,
        issues: Schema.Boolean,
        discussions: Schema.Boolean,
        merge_methods: Schema.Array(Schema.String),
      }),
      viewer: Schema.Struct({
        login: Schema.String,
        permission: Schema.String,
        owner: Schema.Boolean,
        commits_on_default_branch: Schema.Int,
        issues_authored: Schema.Int,
      }),
      local: Schema.optionalKey(
        Schema.Struct({
          directory: Schema.String,
          remote: Schema.String,
          branch: Schema.optionalKey(Schema.String),
          head: Schema.optionalKey(Schema.String),
        }),
      ),
      pull_request: Schema.optionalKey(
        Schema.Struct({
          number: Schema.Int,
          title: Schema.String,
          url: Schema.String,
          state: Schema.String,
          draft: Schema.Boolean,
        }),
      ),
      auth: Schema.String.annotate({ description: "Where the token came from." }),
      preferences: GitHubPreferences.Values.annotate({
        description: "Effective preferences; the preferences tool shows what is stored where and changes them.",
      }),
      discovered: Schema.Array(Schema.String).annotate({ description: "Why default preferences were chosen." }),
      guidance: Schema.String,
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const target = yield* GitHubShared.target(deps, input.repo)
        const [found, token] = yield* Effect.all([discover(target), target.api.token], { concurrency: 2 })
        const prefs = yield* GitHubPreferences.effective(deps.kv, target.repo, found.defaults)
        const branch = target.local?.push?.branch ?? target.local?.branch
        const current =
          branch && target.local
            ? yield* GitHubShared.pullRequest(deps, { repo: input.repo }).pipe(
                Effect.flatMap((resolved) => pull(resolved.api, resolved.repo, resolved.number)),
                Effect.option,
              )
            : Option.none()
        return {
          repo: found.repo,
          viewer: found.viewer,
          ...(target.local
            ? {
                local: {
                  directory: deps.directory,
                  remote: target.local.remote,
                  ...(target.local.branch ? { branch: target.local.branch } : {}),
                  ...(target.local.head ? { head: target.local.head } : {}),
                },
              }
            : {}),
          ...(Option.isSome(current)
            ? {
                pull_request: {
                  number: current.value.number,
                  title: current.value.title,
                  url: current.value.url,
                  state: current.value.state,
                  draft: current.value.isDraft,
                },
              }
            : {}),
          auth: token.source,
          preferences: prefs.effective,
          discovered: found.reasons,
          guidance: guidance(prefs.effective),
        }
      }),
  })

  const preferences = GitHubShared.define(deps, {
    name: "preferences",
    description:
      "Read or change persistent preferences for the review loop and other github tools, for one repository or globally. Record what the user tells you (round limits, whether to file follow-up issues, standing notes) so later sessions follow it.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      scope: Schema.optionalKey(Schema.Literals(["repo", "global"])).annotate({
        description: "Where to write. Default repo. Reads always return both plus the effective merge.",
      }),
      set: Schema.optionalKey(GitHubPreferences.Info),
      clear: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Preference names to remove." }),
    }),
    output: Schema.Struct({
      effective: GitHubPreferences.Values,
      global: GitHubPreferences.Values,
      repo: Schema.optionalKey(GitHubPreferences.Values),
      repo_slug: Schema.optionalKey(Schema.String),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const target = yield* GitHubShared.target(deps, input.repo).pipe(Effect.option)
        const resolved = Option.getOrUndefined(target)
        const scope = input.scope ?? (resolved ? "repo" : "global")
        if (input.set || input.clear) {
          if (scope === "repo" && !resolved)
            return yield* new GitHubClient.Error({
              kind: "validation",
              message: "No repository to store preferences for; use scope global.",
            })
          const key =
            scope === "repo" && resolved ? GitHubPreferences.repoKey(resolved.repo) : GitHubPreferences.globalKey
          yield* GitHubPreferences.write(deps.kv, key, input.set ?? {}, input.clear ?? [])
        }
        const prefs = yield* preferencesFor(resolved)
        return {
          effective: prefs.effective,
          global: prefs.stored.global,
          ...(resolved ? { repo: prefs.stored.repo, repo_slug: GitHubRepo.slug(resolved.repo) } : {}),
        }
      }),
  })

  const pr = GitHubShared.define(deps, {
    name: "pr",
    description:
      "Status of a pull request in one call: state, mergeability, checks, human reviews, Copilot's review state and verdict, unresolved feedback counts, whether the local branch matches the pushed head, and suggested next steps.",
    input: Schema.Struct({ repo: GitHubShared.RepoField, pr: GitHubShared.PRField }),
    output: Schema.Struct({
      number: Schema.Int,
      title: Schema.String,
      url: Schema.String,
      state: Schema.String,
      draft: Schema.Boolean,
      author: Schema.String,
      base: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
      head: Schema.Struct({ ref: Schema.String, sha: Schema.String, repo: Schema.optionalKey(Schema.String) }),
      mergeable: Schema.String,
      merge_state: Schema.String,
      review_decision: Schema.optionalKey(Schema.String),
      auto_merge: Schema.optionalKey(Schema.String),
      changes: Schema.Struct({ files: Schema.Int, additions: Schema.Int, deletions: Schema.Int, commits: Schema.Int }),
      checks: Checks,
      reviews: Schema.Struct({
        approved_by: Schema.Array(Schema.String),
        changes_requested_by: Schema.Array(Schema.String),
        pending_reviewers: Schema.Array(Schema.String),
      }),
      copilot: CopilotStatus,
      feedback: Schema.Struct({
        unresolved_threads: Schema.Int,
        copilot_threads: Schema.Int,
        human_threads: Schema.Int,
        outdated_threads: Schema.Int,
        open_alerts: Schema.optionalKey(Schema.Int),
      }),
      local: Schema.optionalKey(
        Schema.Struct({ branch: Schema.optionalKey(Schema.String), head: Schema.String, pushed: Schema.Boolean }),
      ),
      ready: Schema.Struct({
        merge: Schema.Boolean.annotate({
          description: "No blockers: safe to merge if you are satisfied with the change.",
        }),
        blockers: Schema.Array(Schema.String),
        warnings: Schema.Array(Schema.String).annotate({
          description: "Worth knowing, but not a reason to hold the merge.",
        }),
      }),
      next: Schema.Array(Schema.String),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.pullRequest(deps, input)
        const { api, repo, number } = resolved
        const [data, threadList, reviewList, alertList] = yield* Effect.all(
          [
            pull(api, repo, number),
            threads(api, repo, number),
            reviews(api, repo, number),
            alerts(api, repo, number, true),
          ],
          { concurrency: "unbounded" },
        )
        const copilot = yield* copilotStatus(api, repo, number, data.headRefOid, reviewList)
        const open = threadList.filter((thread) => !thread.isResolved)
        const kindOf = (thread: ThreadData) =>
          GitHubCopilot.authorKind(
            thread.comments.nodes[0]?.author?.login,
            thread.comments.nodes[0]?.author?.__typename,
          )
        const checkSummary = yield* explainStalled(api, repo, checks(data, yield* Clock.currentTimeMillis))
        const localHead =
          (resolved.local?.push?.branch ?? resolved.local?.branch) === data.headRefName
            ? resolved.local?.head
            : undefined
        const severities = findingIndex(
          copilotReviews(reviewList).map((review) => GitHubCopilot.parseReview(review.body)),
        )
        const feedback = {
          unresolved_threads: open.length,
          copilot_threads: open.filter((thread) => kindOf(thread) === "copilot").length,
          human_threads: open.filter((thread) => kindOf(thread) === "human").length,
          outdated_threads: open.filter((thread) => thread.isOutdated).length,
          ...(alertList.note ? {} : { open_alerts: alertList.items.length }),
        }
        const prefs = yield* preferencesFor(resolved)
        return {
          number: data.number,
          title: data.title,
          url: data.url,
          state: data.state,
          draft: data.isDraft,
          author: data.author?.login ?? "ghost",
          base: { ref: data.baseRefName, sha: data.baseRefOid },
          head: {
            ref: data.headRefName,
            sha: data.headRefOid,
            ...(data.headRepository ? { repo: data.headRepository.nameWithOwner } : {}),
          },
          mergeable: data.mergeable,
          merge_state: data.mergeStateStatus,
          ...(data.reviewDecision ? { review_decision: data.reviewDecision } : {}),
          ...(data.autoMergeRequest ? { auto_merge: data.autoMergeRequest.mergeMethod } : {}),
          changes: {
            files: data.changedFiles,
            additions: data.additions,
            deletions: data.deletions,
            commits: data.commits.totalCount,
          },
          checks: checkSummary,
          reviews: {
            approved_by: data.latestOpinionatedReviews.nodes
              .filter((review) => review.state === "APPROVED")
              .map((review) => review.author?.login ?? "ghost"),
            changes_requested_by: data.latestOpinionatedReviews.nodes
              .filter((review) => review.state === "CHANGES_REQUESTED")
              .map((review) => review.author?.login ?? "ghost"),
            pending_reviewers: data.reviewRequests.nodes.flatMap((request) =>
              (request.requestedReviewer?.login ?? request.requestedReviewer?.name)
                ? [request.requestedReviewer.login ?? request.requestedReviewer.name ?? ""]
                : [],
            ),
          },
          copilot,
          feedback,
          ...(localHead
            ? { local: { branch: resolved.local?.branch, head: localHead, pushed: localHead === data.headRefOid } }
            : {}),
          ready: readiness({
            data,
            copilot,
            checks: checkSummary,
            localHead,
            threads: open.map((thread) => {
              const first = thread.comments.nodes[0]
              return {
                kind: kindOf(thread),
                outdated: thread.isOutdated,
                severity: first ? severities.get(first.databaseId)?.severity : undefined,
              }
            }),
            alerts: alertList.items.map(
              (alert) => alert.rule.security_severity_level ?? alert.rule.severity ?? "unknown",
            ),
          }),
          next: nextSteps({
            data,
            copilot,
            feedback,
            checks: checkSummary,
            localHead,
            autoRequest: prefs.effective.copilot_auto_request,
          }),
        }
      }),
  })

  const feedback = GitHubShared.define(deps, {
    name: "feedback",
    description: [
      "Everything reviewers asked for on a pull request, as one list with stable IDs for respond: review threads (Copilot, human and bot, with replies, severity and outdated flags), findings that exist only in Copilot's review body (low confidence, previously missed), code scanning alerts, and conversation comments and review summaries from people.",
      "Items not returned to this session before, or with new replies, are marked new. The first call per pull request includes review-loop guidance.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      pr: GitHubShared.PRField,
      state: Schema.optionalKey(Schema.Literals(["open", "all"])).annotate({
        description: "open (default): unresolved threads, open alerts, unhandled comments. all: include resolved.",
      }),
      author: Schema.optionalKey(Schema.Literals(["copilot", "human", "bot", "all"])).annotate({
        description:
          "Filter by author kind. By default conversation comments and reviews from bots other than Copilot are left out.",
      }),
      sources: Schema.optionalKey(Schema.Array(ItemKind)).annotate({ description: "Limit to these kinds of item." }),
      new_only: Schema.optionalKey(Schema.Boolean).annotate({ description: "Only items marked new." }),
      max_body: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 50_000 }))).annotate({
        description: "Characters kept per body. Default 3000.",
      }),
    }),
    output: Schema.Struct({
      pr: PRRef,
      items: Schema.Array(Item),
      counts: Schema.Struct({
        total: Schema.Int,
        new: Schema.Int,
        by_kind: Schema.Record(Schema.String, Schema.Int),
        by_author: Schema.Record(Schema.String, Schema.Int),
      }),
      copilot: CopilotStatus,
      notes: Schema.Array(Schema.String),
      guidance: Schema.optionalKey(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.pullRequest(deps, input)
        const { api, repo, number } = resolved
        const open = (input.state ?? "open") === "open"
        const wants = (kind: Item["kind"]) => !input.sources || input.sources.includes(kind)
        const [data, threadList, reviewList, alertList, handled, seen] = yield* Effect.all(
          [
            pull(api, repo, number),
            wants("thread") ? threads(api, repo, number) : Effect.succeed([] as ThreadData[]),
            reviews(api, repo, number),
            wants("alert")
              ? alerts(api, repo, number, open)
              : Effect.succeed({ items: [] as Alert[], note: undefined }),
            readList(deps, handledKey(repo, number)),
            readList(deps, seenKey(context.sessionID, repo, number)),
          ],
          { concurrency: "unbounded" },
        )
        const viewer = yield* viewerLogin(api)
        const copilot = yield* copilotStatus(api, repo, number, data.headRefOid, reviewList)
        const items = collect({
          data,
          threads: threadList,
          reviews: reviewList,
          alerts: alertList.items,
          handled: new Set([...handled, ...markedHandled(data.comments.nodes)]),
          seen: new Set(seen),
          viewer,
          open,
          author: input.author,
          wants,
          max: input.max_body ?? 3000,
        }).filter((item) => !input.new_only || item.new)
        yield* addToList(deps, seenKey(context.sessionID, repo, number), items.map(seenToken))
        const guidanceKey = `${context.sessionID}:${prKey(repo, number)}`
        const firstTime = !shownGuidance.has(guidanceKey)
        shownGuidance.add(guidanceKey)
        const prefs = firstTime ? yield* preferencesFor(resolved) : undefined
        const tally = (values: string[]) =>
          values.reduce<Record<string, number>>(
            (counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }),
            {},
          )
        return {
          pr: { repo: GitHubRepo.slug(repo), number, url: data.url, head: data.headRefOid },
          items,
          counts: {
            total: items.length,
            new: items.filter((item) => item.new).length,
            by_kind: tally(items.map((item) => item.kind)),
            by_author: tally(items.map((item) => item.author.kind)),
          },
          copilot,
          notes: [
            ...(alertList.note ? [alertList.note] : []),
            ...(copilot.state === "in_progress" || copilot.state === "requested"
              ? ["Copilot is reviewing; more findings will arrive. Use wait to be notified."]
              : []),
          ],
          ...(prefs ? { guidance: guidance(prefs.effective) } : {}),
        }
      }),
  })

  const respond = GitHubShared.define(deps, {
    name: "respond",
    description: [
      "Reply to, resolve, or dismiss feedback items by the IDs feedback returned, in one batch.",
      "Threads get a reply and are resolved. Code scanning alerts cannot be resolved, so resolve dismisses them with a reason (fixed alerts close when analysis of the fix runs). Copilot body findings have no thread: replies are combined into one pull request comment and resolve marks them handled. Conversation comments get a quoting reply and resolve hides them as resolved.",
      "Replies to people get the configured automated-reply prefix. Pending review drafts created by the replies are submitted so they are visible. Optionally file a follow-up issue for an item and link it in the reply.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      pr: GitHubShared.PRField,
      responses: Schema.Array(
        Schema.Struct({
          id: Schema.String.annotate({ description: "Item ID from feedback." }),
          body: Schema.optionalKey(Schema.String).annotate({
            description:
              "Reply text: what changed and where, or why not, without restating the finding. {sha} becomes the pushed head commit. Omit to use a short default for the reason.",
          }),
          resolve: Schema.optionalKey(Schema.Boolean).annotate({
            description: "true resolves or dismisses the item, false reopens it, omitted leaves its state alone.",
          }),
          reason: Schema.optionalKey(
            Schema.Literals([
              "fixed",
              "false_positive",
              "wont_fix",
              "used_in_tests",
              "noted",
              "deferred",
              "duplicate",
              "outdated",
            ]),
          ).annotate({ description: "Why. Required context for alert dismissals; also picks the default reply." }),
          issue: Schema.optionalKey(
            Schema.Union([
              Schema.Boolean,
              Schema.Struct({
                title: Schema.optionalKey(Schema.String),
                body: Schema.optionalKey(Schema.String),
                labels: Schema.optionalKey(Schema.Array(Schema.String)),
              }),
            ]),
          ).annotate({ description: "File a follow-up issue for this item first and link it in the reply." }),
        }),
      ).check(Schema.isMinLength(1)),
    }),
    output: Schema.Struct({
      results: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          kind: Schema.String,
          status: Schema.Literals(["done", "failed", "awaiting_reanalysis", "dismissal_requested"]),
          replied: Schema.optionalKey(Schema.String),
          resolved: Schema.optionalKey(Schema.Boolean),
          issue: Schema.optionalKey(Schema.Struct({ number: Schema.Int, url: Schema.String })),
          note: Schema.optionalKey(Schema.String),
        }),
      ),
      submitted_reviews: Schema.Int,
      remaining_threads: Schema.Int.annotate({ description: "Review threads still unresolved after this call." }),
      warnings: Schema.Array(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.pullRequest(deps, input)
        yield* GitHubShared.authorize(deps, context, "respond", resolved.repo, { count: input.responses.length })
        const prefs = yield* preferencesFor(resolved)
        return yield* respondAll({ deps, target: resolved, responses: input.responses, prefs: prefs.effective })
      }),
  })

  const updates = GitHubShared.define(deps, {
    name: "updates",
    description:
      "What changed on a pull request since this session last asked (or since a time): new commits on the branch (including force pushes), new commits on the target branch and how far behind it is, new reviews and comments, check results and Copilot's state. Each call advances the session's checkpoint unless peek is set.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      pr: GitHubShared.PRField,
      since: Schema.optionalKey(Schema.String).annotate({ description: "ISO time. Overrides the session checkpoint." }),
      peek: Schema.optionalKey(Schema.Boolean).annotate({ description: "Do not advance the checkpoint." }),
    }),
    output: Schema.Struct({
      pr: PRRef,
      since: Schema.NullOr(Schema.String),
      now: Schema.String,
      first_check: Schema.Boolean,
      head: Schema.Struct({
        sha: Schema.String,
        previous: Schema.optionalKey(Schema.String),
        force_pushed: Schema.Boolean,
        new_commits: Schema.Array(CommitSummary),
      }),
      base: Schema.Struct({
        ref: Schema.String,
        sha: Schema.String,
        previous: Schema.optionalKey(Schema.String),
        new_commits: Schema.Array(CommitSummary),
        behind_by: Schema.Int,
        ahead_by: Schema.Int,
      }),
      reviews: Schema.Array(
        Schema.Struct({
          author: Author,
          state: Schema.String,
          at: Schema.String,
          verdict: Schema.optionalKey(Schema.String),
          commit: Schema.optionalKey(Schema.String),
        }),
      ),
      comments: Schema.Array(
        Schema.Struct({
          author: Author,
          at: Schema.String,
          path: Schema.optionalKey(Schema.String),
          thread: Schema.optionalKey(Schema.String),
          excerpt: Schema.String,
          url: Schema.String,
        }),
      ),
      checks: Checks,
      copilot: CopilotStatus,
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.pullRequest(deps, input)
        const { api, repo, number } = resolved
        const key = cursorKey(context.sessionID, repo, number)
        const stored = Option.getOrUndefined(decodeCursor(yield* deps.kv.get(key)))
        const since = input.since ?? stored?.at
        const [data, threadList, reviewList] = yield* Effect.all(
          [pull(api, repo, number), threads(api, repo, number), reviews(api, repo, number)],
          { concurrency: "unbounded" },
        )
        const slug = GitHubRepo.slug(repo)
        const branch = yield* api.json<{ commit: { sha: string } }>(
          "GET",
          `/repos/${slug}/branches/${GitHubShared.refPath(data.baseRefName)}`,
        )
        const baseSha = branch.commit.sha
        const compare = (from: string, to: string): Effect.Effect<Option.Option<CompareData>> =>
          api
            .json<CompareData>("GET", `/repos/${slug}/compare/${from}...${to}`, { query: { per_page: 50 } })
            .pipe(Effect.option)
        const previousHead = input.since ? undefined : stored?.head
        const previousBase = input.since ? undefined : stored?.base
        const [headDiff, baseDiff, position, copilot, now] = yield* Effect.all(
          [
            previousHead && previousHead !== data.headRefOid
              ? compare(previousHead, data.headRefOid)
              : Effect.succeed(Option.none<CompareData>()),
            previousBase && previousBase !== baseSha
              ? compare(previousBase, baseSha)
              : Effect.succeed(Option.none<CompareData>()),
            compare(baseSha, data.headRefOid),
            copilotStatus(api, repo, number, data.headRefOid, reviewList),
            Clock.currentTimeMillis,
          ],
          { concurrency: "unbounded" },
        )
        const after = (time: string | undefined) => since === undefined || (time !== undefined && time > since)
        const headCommits = Option.match(headDiff, {
          onNone: () => [] as CompareData["commits"],
          onSome: (diff) => diff.commits,
        })
        const headSince =
          previousHead || !since
            ? headCommits
            : (yield* api.paginate<CompareData["commits"][number]>(`/repos/${slug}/pulls/${number}/commits`, {
                limit: 250,
              })).filter((commit) => after(commit.commit.committer?.date ?? commit.commit.author?.date))
        const nowIso = new Date(now).toISOString()
        if (!input.peek) yield* deps.kv.set(key, { at: nowIso, head: data.headRefOid, base: baseSha })
        return {
          pr: { repo: slug, number, url: data.url, head: data.headRefOid },
          since: since ?? null,
          now: nowIso,
          first_check: stored === undefined && input.since === undefined,
          head: {
            sha: data.headRefOid,
            ...(previousHead ? { previous: previousHead } : {}),
            force_pushed: Option.match(headDiff, {
              onNone: () => false,
              onSome: (diff) => diff.status === "diverged" || diff.status === "behind",
            }),
            new_commits: headSince.map(commitSummary),
          },
          base: {
            ref: data.baseRefName,
            sha: baseSha,
            ...(previousBase ? { previous: previousBase } : {}),
            new_commits: Option.match(baseDiff, {
              onNone: () => [],
              onSome: (diff) => diff.commits.map(commitSummary),
            }),
            behind_by: Option.match(position, { onNone: () => 0, onSome: (diff) => diff.behind_by }),
            ahead_by: Option.match(position, { onNone: () => 0, onSome: (diff) => diff.ahead_by }),
          },
          reviews: reviewList
            // Thread replies create empty COMMENTED reviews; their comments are listed below.
            .filter(
              (review) =>
                review.submitted_at &&
                after(review.submitted_at) &&
                (review.body?.trim() || review.state !== "COMMENTED"),
            )
            .slice(since === undefined ? -FIRST_CHECK_LIMIT : 0)
            .map((review) => {
              const kind = GitHubCopilot.authorKind(review.user?.login, review.user?.type)
              return {
                author: { login: review.user?.login ?? "ghost", kind },
                state: review.state,
                at: review.submitted_at ?? "",
                ...(kind === "copilot" ? { verdict: GitHubCopilot.parseReview(review.body).verdict } : {}),
                ...(review.commit_id ? { commit: review.commit_id } : {}),
              }
            }),
          comments: [
            ...threadList.flatMap((thread) =>
              thread.comments.nodes
                .filter((comment) => after(comment.createdAt))
                .map((comment) => ({
                  author: authorOf(comment.author),
                  at: comment.createdAt,
                  path: thread.path,
                  thread: thread.id,
                  excerpt: GitHubShared.clip(GitHubCopilot.plain(comment.body), 300),
                  url: comment.url,
                })),
            ),
            ...data.comments.nodes
              .filter((comment) => after(comment.createdAt))
              .map((comment) => ({
                author: authorOf(comment.author),
                at: comment.createdAt,
                excerpt: GitHubShared.clip(GitHubCopilot.plain(comment.body), 300),
                url: comment.url,
              })),
          ]
            .toSorted((left, right) => left.at.localeCompare(right.at))
            .slice(since === undefined ? -FIRST_CHECK_LIMIT : 0),
          checks: checks(data, now),
          copilot,
        }
      }),
  })

  const copilot = GitHubShared.define(deps, {
    name: "copilot",
    description:
      "Copilot's review state on a pull request, and request a review. By default a review is requested only when none is pending and the head commit has not been reviewed, and a request stuck for over 10 minutes is re-sent. force re-requests even when the head was reviewed.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      pr: GitHubShared.PRField,
      request: Schema.optionalKey(Schema.Literals(["if_needed", "force", "never"])).annotate({
        description: "Default if_needed.",
      }),
    }),
    output: Schema.Struct({
      pr: PRRef,
      status: CopilotStatus,
      action: Schema.Literals(["none", "requested", "re-requested"]),
      note: Schema.optionalKey(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.pullRequest(deps, input)
        const { api, repo, number } = resolved
        const [data, reviewList] = yield* Effect.all([pull(api, repo, number), reviews(api, repo, number)], {
          concurrency: 2,
        })
        const current = yield* copilotStatus(api, repo, number, data.headRefOid, reviewList)
        const mode = input.request ?? "if_needed"
        const action = requestAction(current, mode)
        if (action === "none")
          return {
            pr: { repo: GitHubRepo.slug(repo), number, url: data.url, head: data.headRefOid },
            status: current,
            action,
            ...(mode !== "never" && current.state === "reviewed"
              ? { note: "The head commit is already reviewed. Push changes or use force to request another review." }
              : {}),
          }
        yield* GitHubShared.authorize(deps, context, "copilot", repo)
        yield* requestCopilot(api, repo, number, action === "re-requested")
        const after = yield* copilotStatus(api, repo, number, data.headRefOid, reviewList)
        return {
          pr: { repo: GitHubRepo.slug(repo), number, url: data.url, head: data.headRefOid },
          status: after,
          action,
        }
      }),
  })

  const wait = GitHubShared.define(deps, {
    name: "wait",
    description: [
      "Wait for the next Copilot review and/or for checks to finish on a pull request.",
      "When waiting for Copilot and no review is pending or in progress for the head commit, one is requested first (see the copilot_auto_request preference); a request that never starts is re-sent.",
      "background (default true) returns immediately and the result arrives later as a message in this session; do not poll. Foreground blocks until done or timeout.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      pr: GitHubShared.PRField,
      for: Schema.optionalKey(Schema.Literals(["copilot", "checks", "both"])).annotate({
        description: "Default copilot.",
      }),
      timeout_minutes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 720 }))).annotate({
        description: "Default from the wait_timeout_minutes preference (20).",
      }),
      interval_seconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 600 }))).annotate({
        description: "Polling interval. Default 30.",
      }),
      background: Schema.optionalKey(Schema.Boolean),
      request: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Request a Copilot review when none is pending. Defaults to the copilot_auto_request preference.",
      }),
    }),
    output: WaitResult,
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.pullRequest(deps, input)
        const { api, repo, number } = resolved
        const prefs = yield* preferencesFor(resolved)
        const goal = input.for ?? "copilot"
        const started = yield* Clock.currentTimeMillis
        const timeout = Duration.minutes(input.timeout_minutes ?? prefs.effective.wait_timeout_minutes)
        const interval = Duration.seconds(input.interval_seconds ?? 30)
        const allowRequest = input.request ?? prefs.effective.copilot_auto_request
        const label = `${GitHubRepo.slug(repo)}#${number}`

        // One background wait per pull request and goal: a second call joins the first instead of polling twice.
        const key = `${context.sessionID}:${prKey(repo, number)}:${goal}`
        if (input.background !== false && running.has(key))
          return {
            ...backgroundResult(label, goal, "none"),
            message: `A wait for ${goal} on ${label} is already running in the background. You will be notified when it finishes; DO NOT poll.`,
          }

        // Kick off a review up front so a request failure is reported to the caller, not to a background message.
        let requested: "none" | "requested" | "re-requested" = "none"
        let lastRequest = 0
        if (goal !== "checks") {
          const [data, reviewList] = yield* Effect.all([pull(api, repo, number), reviews(api, repo, number)], {
            concurrency: 2,
          })
          const current = yield* copilotStatus(api, repo, number, data.headRefOid, reviewList)
          const action = requestAction(current, "if_needed")
          if (action !== "none" && !allowRequest && current.state !== "requested")
            return yield* new GitHubClient.Error({
              kind: "validation",
              message: `No Copilot review is pending on ${label} (state ${current.state}) and request is false.`,
              hint: "Call again with request: true, or request one with copilot.",
            })
          // Repositories with a review-on-push rule request Copilot themselves shortly after a push; give that a
          // minute before requesting, so a just-pushed commit is not requested twice.
          const automatic =
            action === "requested" && current.state === "stale" && (yield* reviewsOnPush(api, repo, data.baseRefName))
          if (automatic) lastRequest = started
          if (action !== "none" && allowRequest && !automatic) {
            yield* GitHubShared.authorize(deps, context, "copilot", repo)
            yield* requestCopilot(api, repo, number, action === "re-requested")
            requested = action
            lastRequest = started
          }
        }

        if (input.background === false)
          return yield* poll({
            api,
            repo,
            number,
            goal,
            started,
            timeout,
            interval,
            requested,
            allowRequest,
            lastRequest,
          })
        yield* background(deps, {
          key,
          sessionID: context.sessionID,
          directory: deps.directory,
          host: repo.host,
          owner: repo.owner,
          name: repo.name,
          number,
          goal,
          started,
          timeout: Duration.toMillis(timeout),
          interval: Duration.toMillis(interval),
          requested,
          allowRequest,
          lastRequest,
        })
        return backgroundResult(label, goal, requested)
      }),
  })

  return [context, preferences, pr, feedback, respond, updates, copilot, wait]

  // -------------------------------------------------------------------------------------------------------------

  function viewerLogin(api: Api) {
    return api.json<{ login: string }>("GET", "/user").pipe(Effect.map((user) => user.login))
  }

  function discovery(target: GitHubShared.Target): Effect.Effect<Discovery, GitHubClient.Error> {
    return Effect.gen(function* () {
      const data = yield* target.api.graphql<ContextData>(CONTEXT_QUERY, {
        owner: target.repo.owner,
        name: target.repo.name,
      })
      const repository = data.repository
      if (!repository)
        return yield* new GitHubClient.Error({
          kind: "not_found",
          message: `Repository ${GitHubRepo.slug(target.repo)} not found`,
        })
      const counts = yield* target.api
        .graphql<CountsData>(COUNTS_QUERY, {
          owner: target.repo.owner,
          name: target.repo.name,
          author: data.viewer.id,
          search: `repo:${GitHubRepo.slug(target.repo)} is:issue author:${data.viewer.login}`,
        })
        .pipe(Effect.option)
      const commits = Option.match(counts, {
        onNone: () => 0,
        onSome: (value) => value.repository?.defaultBranchRef?.target?.history?.totalCount ?? 0,
      })
      const issues = Option.match(counts, { onNone: () => 0, onSome: (value) => value.search.issueCount })
      const owner = repository.owner.login.toLowerCase() === data.viewer.login.toLowerCase()
      const maintainer = repository.viewerPermission === "ADMIN" || repository.viewerPermission === "MAINTAIN"
      const methods = [
        ...(repository.mergeCommitAllowed ? ["merge"] : []),
        ...(repository.squashMergeAllowed ? ["squash"] : []),
        ...(repository.rebaseMergeAllowed ? ["rebase"] : []),
      ]
      const reasons: string[] = []
      const followup: GitHubPreferences.Info["followup_issues"] = !repository.hasIssuesEnabled
        ? "never"
        : owner || maintainer || commits >= 5 || issues >= 3
          ? "auto"
          : "ask"
      reasons.push(
        !repository.hasIssuesEnabled
          ? "followup_issues=never: issues are disabled on this repository."
          : followup === "auto"
            ? `followup_issues=auto: you ${owner ? "own the repository" : maintainer ? `have ${repository.viewerPermission} permission` : `have ${commits} commits on the default branch and ${issues} authored issues`}.`
            : `followup_issues=ask: you have ${commits} commits and ${issues} authored issues here, so filing issues may not be welcome.`,
      )
      const mergeMethod = methods[0] as GitHubPreferences.Info["merge_method"]
      if (mergeMethod) reasons.push(`merge_method=${mergeMethod}: first method the repository allows.`)
      return {
        repo: {
          slug: repository.nameWithOwner,
          host: target.repo.host,
          url: repository.url,
          default_branch: repository.defaultBranchRef?.name ?? "main",
          private: repository.isPrivate,
          fork: repository.isFork,
          ...(repository.parent ? { parent: repository.parent.nameWithOwner } : {}),
          archived: repository.isArchived,
          issues: repository.hasIssuesEnabled,
          discussions: repository.hasDiscussionsEnabled,
          merge_methods: methods,
        },
        viewer: {
          login: data.viewer.login,
          permission: repository.viewerPermission ?? "NONE",
          owner,
          commits_on_default_branch: commits,
          issues_authored: issues,
        },
        defaults: { followup_issues: followup, ...(mergeMethod ? { merge_method: mergeMethod } : {}) },
        reasons,
      }
    })
  }
}

interface Discovery {
  readonly repo: {
    readonly slug: string
    readonly host: string
    readonly url: string
    readonly default_branch: string
    readonly private: boolean
    readonly fork: boolean
    readonly parent?: string
    readonly archived: boolean
    readonly issues: boolean
    readonly discussions: boolean
    readonly merge_methods: string[]
  }
  readonly viewer: {
    readonly login: string
    readonly permission: string
    readonly owner: boolean
    readonly commits_on_default_branch: number
    readonly issues_authored: number
  }
  readonly defaults: GitHubPreferences.Info
  readonly reasons: string[]
}

interface ContextData {
  readonly viewer: { readonly login: string; readonly id: string }
  readonly repository: {
    readonly nameWithOwner: string
    readonly url: string
    readonly isPrivate: boolean
    readonly isFork: boolean
    readonly isArchived: boolean
    readonly hasIssuesEnabled: boolean
    readonly hasDiscussionsEnabled: boolean
    readonly viewerPermission: string | null
    readonly parent: { readonly nameWithOwner: string } | null
    readonly owner: { readonly login: string }
    readonly defaultBranchRef: { readonly name: string } | null
    readonly mergeCommitAllowed: boolean
    readonly squashMergeAllowed: boolean
    readonly rebaseMergeAllowed: boolean
  } | null
}

const CONTEXT_QUERY = `query($owner: String!, $name: String!) {
  viewer { login id }
  repository(owner: $owner, name: $name) {
    nameWithOwner url isPrivate isFork isArchived hasIssuesEnabled hasDiscussionsEnabled viewerPermission
    parent { nameWithOwner } owner { login } defaultBranchRef { name }
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
  }
}`

interface CountsData {
  readonly repository: {
    readonly defaultBranchRef: { readonly target: { readonly history?: { readonly totalCount: number } } | null } | null
  } | null
  readonly search: { readonly issueCount: number }
}

const COUNTS_QUERY = `query($owner: String!, $name: String!, $author: ID!, $search: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit { history(author: { id: $author }) { totalCount } } } }
  }
  search(type: ISSUE, query: $search, first: 0) { issueCount }
}`

// ---------------------------------------------------------------------------------------------------------------
// Feedback collection
// ---------------------------------------------------------------------------------------------------------------

function authorOf(author: GqlAuthor | null | undefined) {
  return { login: author?.login ?? "ghost", kind: GitHubCopilot.authorKind(author?.login, author?.__typename) }
}

/** Maps a Copilot review comment's database ID to the severity and title its review listed it with. */
function findingIndex(summaries: ReadonlyArray<GitHubCopilot.Review>) {
  return new Map(
    summaries.flatMap((summary) =>
      summary.findings.flatMap((finding) =>
        finding.commentID ? [[finding.commentID, { severity: finding.severity, title: finding.title }] as const] : [],
      ),
    ),
  )
}

const seenToken = (item: Item) => `${item.id}@${item.replies?.length ?? 0}`

function collect(input: {
  readonly data: PullData
  readonly threads: ReadonlyArray<ThreadData>
  readonly reviews: ReadonlyArray<RestReview>
  readonly alerts: ReadonlyArray<Alert>
  readonly handled: ReadonlySet<string>
  readonly seen: ReadonlySet<string>
  readonly viewer: string
  readonly open: boolean
  readonly author: "copilot" | "human" | "bot" | "all" | undefined
  readonly wants: (kind: Item["kind"]) => boolean
  readonly max: number
}): Item[] {
  const copilotReviews = input.reviews.filter(
    (review) => GitHubCopilot.authorKind(review.user?.login, review.user?.type) === "copilot",
  )
  const parsed = copilotReviews.map((review) => ({ review, summary: GitHubCopilot.parseReview(review.body) }))
  const severity = findingIndex(parsed.map((entry) => entry.summary))
  const authorMatches = (kind: GitHubCopilot.AuthorKind, conversation: boolean) => {
    if (input.author === undefined) return !conversation || kind !== "bot"
    return input.author === "all" || input.author === kind
  }
  const viewer = input.viewer.toLowerCase()
  const mark = (item: Omit<Item, "new">): Item => ({
    ...item,
    new: !input.seen.has(seenToken({ ...item, new: false })),
  })

  const threadItems = input.threads.flatMap((thread): Item[] => {
    const [first, ...rest] = thread.comments.nodes
    if (!first) return []
    if (input.open && thread.isResolved) return []
    const author = authorOf(first.author)
    if (!authorMatches(author.kind, false)) return []
    const known = severity.get(first.databaseId)
    const body = GitHubCopilot.plain(first.body)
    return [
      mark({
        id: thread.id,
        kind: "thread",
        author,
        ...(known?.title ? { title: known.title } : {}),
        body: GitHubShared.clip(body, input.max),
        path: thread.path,
        ...((thread.line ?? thread.originalLine) ? { line: thread.line ?? thread.originalLine ?? 0 } : {}),
        ...(thread.startLine && thread.line && thread.startLine !== thread.line
          ? { line: thread.startLine, end_line: thread.line }
          : {}),
        ...(known?.severity ? { severity: known.severity } : {}),
        url: first.url,
        created_at: first.createdAt,
        resolved: thread.isResolved,
        outdated: thread.isOutdated,
        ...(/```suggestion/.test(first.body) ? { suggestion: true } : {}),
        ...(rest.length > 0
          ? {
              replies: rest.map((comment) => ({
                author: authorOf(comment.author),
                body: GitHubShared.clip(GitHubCopilot.plain(comment.body), Math.min(input.max, 1500)),
                created_at: comment.createdAt,
              })),
            }
          : {}),
        actions: thread.isResolved ? ["reply", "reopen"] : ["reply", "resolve"],
      }),
    ]
  })

  // Body-only findings are never repeated by later rounds, so every review's findings stay listed until handled.
  // Those from reviews of an older commit are flagged outdated, since the code may have changed under them.
  const bodyItems = authorMatches("copilot", false)
    ? parsed.flatMap((entry) =>
        entry.summary.body.flatMap((finding, index): Item[] => {
          const id = `copilot:${entry.review.id}:${index}`
          const handled = input.handled.has(id)
          if (input.open && handled) return []
          return [
            mark({
              id,
              kind: "copilot_body",
              author: { login: entry.review.user?.login ?? "copilot-pull-request-reviewer", kind: "copilot" },
              ...(finding.title ? { title: finding.title } : {}),
              body: GitHubShared.clip(finding.body, input.max),
              ...(finding.path ? { path: finding.path } : {}),
              ...(finding.line ? { line: finding.line } : {}),
              ...(finding.endLine ? { end_line: finding.endLine } : {}),
              ...(finding.severity ? { severity: finding.severity } : {}),
              source: finding.kind,
              url: entry.review.html_url,
              ...(entry.review.submitted_at ? { created_at: entry.review.submitted_at } : {}),
              resolved: handled,
              outdated: entry.review.commit_id !== input.data.headRefOid,
              actions: ["reply", "resolve"],
            }),
          ]
        }),
      )
    : []

  const alertItems = input.alerts.flatMap((alert): Item[] => {
    const resolved = alert.state !== "open"
    if (input.open && resolved) return []
    if (input.author !== undefined && input.author !== "all" && input.author !== "bot") return []
    const location = alert.most_recent_instance.location
    return [
      mark({
        id: `alert:${alert.number}`,
        kind: "alert",
        author: { login: alert.tool.name, kind: "bot" },
        title: alert.rule.description ?? alert.rule.id,
        body: GitHubShared.clip(alert.most_recent_instance.message?.text ?? alert.rule.id, input.max),
        ...(location?.path ? { path: location.path } : {}),
        ...(location?.start_line ? { line: location.start_line } : {}),
        ...(location?.end_line && location.end_line !== location.start_line ? { end_line: location.end_line } : {}),
        severity: alert.rule.security_severity_level ?? alert.rule.severity ?? "unknown",
        source: `${alert.tool.name}:${alert.rule.id}`,
        url: alert.html_url,
        created_at: alert.created_at,
        resolved,
        actions: resolved ? ["reopen"] : ["dismiss (resolve with a reason)"],
      }),
    ]
  })

  const commentItems = input.data.comments.nodes.flatMap((comment): Item[] => {
    const author = authorOf(comment.author)
    if (author.login.toLowerCase() === viewer) return []
    if (comment.body.includes("<!-- opencode-github ")) return []
    const handled = comment.isMinimized || input.handled.has(comment.id)
    if (input.open && handled) return []
    if (!authorMatches(author.kind, true)) return []
    return [
      mark({
        id: comment.id,
        kind: "comment",
        author,
        body: GitHubShared.clip(GitHubCopilot.plain(comment.body), input.max),
        url: comment.url,
        created_at: comment.createdAt,
        resolved: handled,
        actions: ["reply", "resolve (hide as resolved)"],
      }),
    ]
  })

  const reviewItems = input.reviews.flatMap((review): Item[] => {
    const kind = GitHubCopilot.authorKind(review.user?.login, review.user?.type)
    if (kind === "copilot" || !review.body?.trim() || review.state === "PENDING") return []
    if ((review.user?.login ?? "").toLowerCase() === viewer) return []
    const id = review.node_id
    const handled = input.handled.has(id)
    if (input.open && handled) return []
    if (!authorMatches(kind, true)) return []
    return [
      mark({
        id,
        kind: "review",
        author: { login: review.user?.login ?? "ghost", kind },
        body: GitHubShared.clip(GitHubCopilot.plain(review.body), input.max),
        source: review.state,
        url: review.html_url,
        ...(review.submitted_at ? { created_at: review.submitted_at } : {}),
        resolved: handled,
        actions: ["reply", "resolve (mark handled)"],
      }),
    ]
  })

  return [
    ...(input.wants("thread") ? threadItems : []),
    ...(input.wants("copilot_body") ? bodyItems : []),
    ...(input.wants("alert") ? alertItems : []),
    ...(input.wants("review") ? reviewItems : []),
    ...(input.wants("comment") ? commentItems : []),
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Responding
// ---------------------------------------------------------------------------------------------------------------

type Response = {
  readonly id: string
  readonly body?: string
  readonly resolve?: boolean
  readonly reason?:
    | "fixed"
    | "false_positive"
    | "wont_fix"
    | "used_in_tests"
    | "noted"
    | "deferred"
    | "duplicate"
    | "outdated"
  readonly issue?:
    | boolean
    | { readonly title?: string; readonly body?: string; readonly labels?: ReadonlyArray<string> }
}

type Result = {
  id: string
  kind: string
  status: "done" | "failed" | "awaiting_reanalysis" | "dismissal_requested"
  replied?: string
  resolved?: boolean
  issue?: { number: number; url: string }
  note?: string
}

interface NodeData {
  readonly __typename: string
  readonly id: string
  readonly isResolved?: boolean
  readonly path?: string
  readonly url?: string
  readonly body?: string
  readonly author?: GqlAuthor | null
  readonly viewerCanMinimize?: boolean
  readonly comments?: {
    readonly nodes: ReadonlyArray<{ readonly author: GqlAuthor | null; readonly body: string; readonly url: string }>
  }
}

const NODES_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename id
    ... on PullRequestReviewThread { isResolved path comments(first: 1) { nodes { author { login __typename } body url } } }
    ... on IssueComment { url body author { login __typename } viewerCanMinimize }
    ... on PullRequestReview { url body author { login __typename } }
  }
}`

const DEFAULT_REPLY: Record<NonNullable<Response["reason"]>, string> = {
  fixed: "Fixed.",
  false_positive: "Not a defect here; closing as a false positive.",
  wont_fix: "Won't fix; the trade-off is intentional.",
  used_in_tests: "Only used in tests.",
  noted: "Noted as non-blocking; left for the maintainers to triage.",
  deferred: "Deferred to a follow-up.",
  duplicate: "Duplicate of another finding addressed in this review.",
  outdated: "Outdated: the code this referred to has changed.",
}

const ALERT_REASON: Record<NonNullable<Response["reason"]>, string | undefined> = {
  fixed: undefined,
  false_positive: "false positive",
  used_in_tests: "used in tests",
  wont_fix: "won't fix",
  noted: "won't fix",
  deferred: "won't fix",
  duplicate: "won't fix",
  outdated: "won't fix",
}

const respondAll = Effect.fn("GitHubReview.respond")(function* (input: {
  readonly deps: Deps
  readonly target: GitHubShared.Target & { readonly number: number }
  readonly responses: ReadonlyArray<Response>
  readonly prefs: GitHubPreferences.Info & typeof GitHubPreferences.DEFAULTS
}) {
  const { api, repo, number } = input.target
  const slug = GitHubRepo.slug(repo)
  const warnings: string[] = []
  const graphIDs = input.responses
    .map((response) => response.id)
    .filter((id) => !id.startsWith("alert:") && !id.startsWith("copilot:"))
  const nodes = graphIDs.length
    ? (yield* api.graphql<{ nodes: ReadonlyArray<NodeData | null> }>(NODES_QUERY, { ids: graphIDs })).nodes
    : []
  const byID = new Map(nodes.flatMap((node) => (node ? [[node.id, node] as const] : [])))
  const data = yield* pull(api, repo, number)
  const short = data.headRefOid.slice(0, 7)
  const localHead =
    (input.target.local?.push?.branch ?? input.target.local?.branch) === data.headRefName
      ? input.target.local?.head
      : undefined
  if (localHead && localHead !== data.headRefOid && input.responses.some((response) => response.reason === "fixed"))
    warnings.push(
      `Local HEAD ${localHead.slice(0, 7)} differs from the pushed head ${short}. Push before claiming fixes so reviewers can see them.`,
    )
  const prefix = input.prefs.human_reply_prefix
  const withPrefix = (body: string, author: GqlAuthor | null | undefined) =>
    prefix && GitHubCopilot.authorKind(author?.login, author?.__typename) === "human" && !body.includes(prefix)
      ? `${prefix}\n\n${body}`
      : body
  const defaultBody = (response: Response) =>
    response.reason === "fixed" ? `Fixed in ${short}.` : response.reason ? DEFAULT_REPLY[response.reason] : undefined

  const fileIssue = (response: Response, title: string, link: string, quoted: string) =>
    Effect.gen(function* () {
      if (!response.issue) return undefined
      if (input.prefs.followup_issues === "never")
        return yield* new GitHubClient.Error({
          kind: "validation",
          message: "The followup_issues preference is never; not filing an issue.",
        })
      const options = typeof response.issue === "object" ? response.issue : {}
      const created = yield* api.json<{ number: number; html_url: string }>("POST", `/repos/${slug}/issues`, {
        body: {
          title: options.title ?? `Follow-up from #${number}: ${title}`.slice(0, 120),
          body: [
            `Raised in review of #${number} ([comment](${link})).`,
            "",
            quoted
              .split("\n")
              .slice(0, 30)
              .map((line) => `> ${line}`)
              .join("\n"),
            ...(options.body ? ["", options.body] : []),
          ].join("\n"),
          ...(options.labels?.length ? { labels: options.labels } : {}),
        },
      })
      return { number: created.number, url: created.html_url }
    })

  // Body findings have no thread, so the combined reply names each one by its title and location.
  const bodyFindings = input.responses.some((response) => response.id.startsWith("copilot:"))
    ? new Map(
        (yield* reviews(api, repo, number)).flatMap((review) =>
          GitHubCopilot.parseReview(review.body).body.map(
            (finding, index) => [`copilot:${review.id}:${index}`, finding] as const,
          ),
        ),
      )
    : new Map<string, GitHubCopilot.BodyFinding>()
  const pendingReviews = new Map<string, number>()
  const bodyReplies: string[] = []
  const marks = { handled: [] as string[], reopened: [] as string[], titles: [] as string[] }
  const results: Result[] = []

  // {sha} lets a reply written before the push name the commit reviewers will see.
  const responses = input.responses.map((response) =>
    response.body === undefined ? response : { ...response, body: response.body.replaceAll("{sha}", short) },
  )
  for (const response of responses) {
    const outcome = yield* Effect.gen(function* (): Effect.fn.Return<Result, GitHubClient.Error> {
      if (response.id.startsWith("alert:")) {
        const alertNumber = Number(response.id.slice("alert:".length))
        if (!Number.isSafeInteger(alertNumber) || alertNumber <= 0)
          return yield* new GitHubClient.Error({
            kind: "validation",
            message: `Invalid alert id ${response.id}: expected alert:<positive integer>`,
          })
        const alert = yield* api.json<Alert>("GET", `/repos/${slug}/code-scanning/alerts/${alertNumber}`)
        if (response.resolve === false) {
          yield* api.json("PATCH", `/repos/${slug}/code-scanning/alerts/${alertNumber}`, { body: { state: "open" } })
          return { id: response.id, kind: "alert", status: "done", resolved: false }
        }
        if (!response.resolve)
          return {
            id: response.id,
            kind: "alert",
            status: "done",
            note: "Alerts take no replies; set resolve to dismiss.",
          }
        if (response.reason === "fixed")
          return {
            id: response.id,
            kind: "alert",
            status: "awaiting_reanalysis",
            note: "Code scanning closes an alert when analysis of the fixed code runs on the pushed head; it cannot be dismissed as fixed.",
          }
        const path = alert.most_recent_instance.location?.path ?? ""
        const reason = response.reason
          ? ALERT_REASON[response.reason]
          : /(^|\/)(tests?|__tests__|spec|fixtures?)\/|[._-](test|spec)\.\w+$/i.test(path)
            ? "used in tests"
            : "won't fix"
        const comment = (
          response.body ?? (response.reason ? DEFAULT_REPLY[response.reason] : "Dismissed after review.")
        ).slice(0, 280)
        const updated = yield* api.json<{ state: string }>(
          "PATCH",
          `/repos/${slug}/code-scanning/alerts/${alertNumber}`,
          {
            body: { state: "dismissed", dismissed_reason: reason, dismissed_comment: comment },
          },
        )
        if (updated.state !== "dismissed")
          return {
            id: response.id,
            kind: "alert",
            status: "dismissal_requested",
            note: "The repository requires approval for alert dismissals; a dismissal request was created.",
          }
        return { id: response.id, kind: "alert", status: "done", resolved: true, note: `Dismissed as ${reason}.` }
      }

      if (response.id.startsWith("copilot:")) {
        const issue = yield* fileIssue(response, "Copilot finding", data.url, response.body ?? "")
        const body = response.body ?? defaultBody(response)
        const finding = bodyFindings.get(response.id)
        const heading = [
          `**Re: ${finding?.title ?? "finding in Copilot's review"}**`,
          finding?.path ? `(\`${finding.path}${finding.line ? `:${finding.line}` : ""}\`)` : undefined,
          issue ? `— tracked in #${issue.number}` : undefined,
        ]
          .filter(Boolean)
          .join(" ")
        if (body) bodyReplies.push(`${heading}\n\n${body}`)
        if (response.resolve === true) {
          yield* addToList(input.deps, handledKey(repo, number), [response.id])
          marks.handled.push(response.id)
          if (!body) marks.titles.push(finding?.title ?? response.id)
        }
        if (response.resolve === false) {
          yield* removeFromList(input.deps, handledKey(repo, number), response.id)
          marks.reopened.push(response.id)
        }
        return {
          id: response.id,
          kind: "copilot_body",
          status: "done",
          ...(response.resolve !== undefined ? { resolved: response.resolve } : {}),
          ...(issue ? { issue } : {}),
          ...(body ? { note: "Reply posted in a combined pull request comment." } : {}),
        }
      }

      const node = byID.get(response.id)
      if (!node) return yield* new GitHubClient.Error({ kind: "not_found", message: `No feedback item ${response.id}` })

      if (node.__typename === "PullRequestReviewThread") {
        const first = node.comments?.nodes[0]
        const issue = yield* fileIssue(
          response,
          node.path ?? "review thread",
          first?.url ?? data.url,
          first?.body ?? "",
        )
        const text = response.body ?? defaultBody(response) ?? (issue ? "" : undefined)
        const body =
          text === undefined
            ? undefined
            : [text, issue ? `Tracked in #${issue.number}.` : ""].filter(Boolean).join("\n\n")
        const reply = body
          ? yield* api.graphql<{
              addPullRequestReviewThreadReply: {
                comment: { url: string; pullRequestReview: { id: string; state: string } | null }
              }
            }>(
              `mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { url pullRequestReview { id state } } } }`,
              { thread: node.id, body: withPrefix(body, first?.author) },
            )
          : undefined
        const review = reply?.addPullRequestReviewThreadReply.comment.pullRequestReview
        if (review?.state === "PENDING") pendingReviews.set(review.id, (pendingReviews.get(review.id) ?? 0) + 1)
        if (response.resolve === true && !node.isResolved)
          yield* api.graphql(
            `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }`,
            {
              thread: node.id,
            },
          )
        if (response.resolve === false && node.isResolved)
          yield* api.graphql(
            `mutation($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }`,
            {
              thread: node.id,
            },
          )
        if (response.resolve === true && !body) warnings.push(`${node.id} was resolved without a reply.`)
        return {
          id: response.id,
          kind: "thread",
          status: "done",
          ...(reply ? { replied: reply.addPullRequestReviewThreadReply.comment.url } : {}),
          ...(response.resolve !== undefined ? { resolved: response.resolve } : {}),
          ...(issue ? { issue } : {}),
        }
      }

      if (node.__typename === "IssueComment" || node.__typename === "PullRequestReview") {
        const kind = node.__typename === "IssueComment" ? "comment" : "review"
        const issue = yield* fileIssue(
          response,
          `comment by @${node.author?.login ?? "ghost"}`,
          node.url ?? data.url,
          node.body ?? "",
        )
        const text = response.body ?? defaultBody(response)
        const body =
          text === undefined
            ? undefined
            : [text, issue ? `Tracked in #${issue.number}.` : ""].filter(Boolean).join("\n\n")
        const quote = (node.body ?? "").split("\n").find((line) => line.trim()) ?? ""
        // GitHub can hide a comment as resolved; anything else is recorded with a marker in the reply.
        const durable = kind === "comment" && node.viewerCanMinimize === true
        const state =
          durable || response.resolve === undefined ? "" : marker(response.resolve ? "handled" : "reopened", [node.id])
        const posted = body
          ? yield* api.json<{ html_url: string }>("POST", `/repos/${slug}/issues/${number}/comments`, {
              body: {
                body: withPrefix(
                  `> ${GitHubShared.clip(quote, 200).replace(/\n/g, " ")}\n> — @${node.author?.login ?? "ghost"} ([${kind}](${node.url}))\n\n${body}${state ? `\n\n${state}` : ""}`,
                  node.author,
                ),
              },
            })
          : undefined
        if (!posted && state) {
          if (response.resolve) marks.handled.push(node.id)
          else marks.reopened.push(node.id)
          if (response.resolve) marks.titles.push(`${kind} by @${node.author?.login ?? "ghost"}`)
        }
        let resolved: boolean | undefined
        if (response.resolve === true) {
          if (kind === "comment" && node.viewerCanMinimize)
            yield* api.graphql(
              `mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: RESOLVED }) { minimizedComment { isMinimized } } }`,
              { id: node.id },
            )
          yield* addToList(input.deps, handledKey(repo, number), [node.id])
          resolved = true
        }
        if (response.resolve === false) {
          if (kind === "comment" && node.viewerCanMinimize)
            yield* api.graphql(
              `mutation($id: ID!) { unminimizeComment(input: { subjectId: $id }) { unminimizedComment { isMinimized } } }`,
              {
                id: node.id,
              },
            )
          yield* removeFromList(input.deps, handledKey(repo, number), node.id)
          resolved = false
        }
        return {
          id: response.id,
          kind,
          status: "done",
          ...(posted ? { replied: posted.html_url } : {}),
          ...(resolved !== undefined ? { resolved } : {}),
          ...(issue ? { issue } : {}),
        }
      }

      return yield* new GitHubClient.Error({
        kind: "validation",
        message: `Unsupported item type ${node.__typename} for ${response.id}`,
      })
    }).pipe(
      Effect.catch((error: GitHubClient.Error) =>
        Effect.succeed<Result>({
          id: response.id,
          kind: response.id.split(/[:_]/)[0] ?? "item",
          status: "failed",
          note: [error.message, error.hint].filter(Boolean).join(" "),
        }),
      ),
    )
    results.push(outcome)
  }

  const state = [marker("handled", marks.handled), marker("reopened", marks.reopened)].filter(Boolean).join("\n")
  if (bodyReplies.length > 0 || state)
    yield* api.json("POST", `/repos/${slug}/issues/${number}/comments`, {
      body: {
        body: [
          ...(bodyReplies.length ? [`Replies to findings in Copilot's review summary:`, ...bodyReplies] : []),
          ...(marks.titles.length ? [`Handled without a reply: ${marks.titles.join("; ")}.`] : []),
          ...(marks.reopened.length && !bodyReplies.length && !marks.titles.length
            ? ["Reopened for another look."]
            : []),
        ]
          .join("\n\n---\n\n")
          .concat(state ? `\n\n${state}` : ""),
      },
    })

  // A thread reply can land in the viewer's pending review, where nobody else can see it. Submit only reviews that
  // hold nothing but these replies, so a draft the user is writing by hand is never published.
  let submitted = 0
  for (const [reviewID, count] of pendingReviews) {
    const review = yield* api.graphql<{ node: { comments: { totalCount: number } } | null }>(
      `query($id: ID!) { node(id: $id) { ... on PullRequestReview { comments { totalCount } } } }`,
      { id: reviewID },
    )
    if ((review.node?.comments.totalCount ?? 0) > count) {
      warnings.push(
        "Some replies are in a pending review that also holds your own draft comments; submit it on GitHub to publish them.",
      )
      continue
    }
    yield* api.graphql(
      `mutation($id: ID!) { submitPullRequestReview(input: { pullRequestReviewId: $id, event: COMMENT }) { pullRequestReview { state } } }`,
      { id: reviewID },
    )
    submitted++
  }

  // Re-read rather than count: a thread resolved elsewhere, or one this call could not resolve, still shows here.
  const remaining = (yield* threads(api, repo, number)).filter((thread) => !thread.isResolved).length
  return { results, submitted_reviews: submitted, remaining_threads: remaining, warnings }
})

const removeFromList = (deps: Deps, key: string, value: string) =>
  readList(deps, key).pipe(
    Effect.flatMap((current) =>
      deps.kv.set(
        key,
        current.filter((item) => item !== value),
      ),
    ),
  )

// ---------------------------------------------------------------------------------------------------------------
// Copilot requests and waiting
// ---------------------------------------------------------------------------------------------------------------

function requestAction(current: CopilotStatus, mode: "if_needed" | "force" | "never") {
  if (mode === "never") return "none" as const
  if (mode === "force") return current.state === "none" ? ("requested" as const) : ("re-requested" as const)
  if (current.stuck) return "re-requested" as const
  if (current.state === "stale" || current.state === "none") return "requested" as const
  return "none" as const
}

const requestCopilot = Effect.fn("GitHubReview.requestCopilot")(function* (
  api: Api,
  repo: GitHubRepo.Ref,
  number: number,
  again: boolean,
) {
  const path = `/repos/${GitHubRepo.slug(repo)}/pulls/${number}/requested_reviewers`
  const body = { reviewers: [GitHubCopilot.REVIEWER] }
  // Removing first makes GitHub treat the request as new; a plain re-request of a pending reviewer is ignored.
  if (again) yield* api.request("DELETE", path, { body, allow: [404, 422] })
  // GitHub answers 201 without listing Copilot among requested_reviewers, even when the request starts a review, so
  // progress is read from the timeline (review_requested, copilot_work_started) instead of this response.
  yield* api.request("POST", path, { body }).pipe(
    Effect.mapError((error) =>
      error.kind === "validation"
        ? new GitHubClient.Error({
            ...error,
            message: error.message,
            hint: "Copilot code review may not be enabled for this repository or account, or the pull request is closed.",
          })
        : error,
    ),
  )
})

const WaitResult = Schema.Struct({
  pr: Schema.String,
  status: Schema.Literals(["completed", "timed_out", "stopped", "running"]).annotate({
    description: "stopped: the pull request closed, or no Copilot review is pending and none could be requested.",
  }),
  waited_seconds: Schema.Int,
  requested: Schema.Literals(["none", "requested", "re-requested"]),
  copilot: Schema.optionalKey(CopilotStatus),
  checks: Schema.optionalKey(Checks),
  head: Schema.optionalKey(Schema.String),
  message: Schema.String,
})

const CommitSummary = Schema.Struct({
  sha: Schema.String,
  message: Schema.String,
  author: Schema.String,
  date: Schema.optionalKey(Schema.String),
})

interface CompareData {
  readonly status: string
  readonly ahead_by: number
  readonly behind_by: number
  readonly commits: ReadonlyArray<{
    readonly sha: string
    readonly commit: {
      readonly message: string
      readonly author?: { readonly name?: string; readonly date?: string } | null
      readonly committer?: { readonly date?: string } | null
    }
    readonly author?: { readonly login: string } | null
  }>
}

function commitSummary(commit: CompareData["commits"][number]) {
  return {
    sha: commit.sha,
    message: commit.commit.message.split("\n")[0] ?? "",
    author: commit.author?.login ?? commit.commit.author?.name ?? "unknown",
    ...(commit.commit.author?.date ? { date: commit.commit.author.date } : {}),
  }
}

function backgroundResult(
  label: string,
  goal: string,
  requested: "none" | "requested" | "re-requested",
): typeof WaitResult.Type {
  return {
    pr: label,
    status: "running",
    waited_seconds: 0,
    requested,
    message: [
      `Waiting in the background for ${goal === "both" ? "Copilot and checks" : goal} on ${label}${requested !== "none" ? ` (Copilot review ${requested})` : ""}.`,
      "You will be notified in this session when it finishes. DO NOT poll or sleep. Keep working on anything that does not depend on the result, or end your response.",
    ].join("\n"),
  }
}

const MAX_POLL_FAILURES = 5

const poll = Effect.fn("GitHubReview.poll")(function* (input: {
  readonly api: Api
  readonly repo: GitHubRepo.Ref
  readonly number: number
  readonly goal: "copilot" | "checks" | "both"
  readonly started: number
  readonly timeout: Duration.Duration
  readonly interval: Duration.Duration
  readonly requested: "none" | "requested" | "re-requested"
  readonly allowRequest: boolean
  readonly lastRequest: number
}) {
  const label = `${GitHubRepo.slug(input.repo)}#${input.number}`
  let rekicks = input.requested === "none" ? 0 : 1
  let lastRequest = input.lastRequest
  let failures = 0
  while (true) {
    // A long wait outlives brief network or rate-limit trouble; only give up after several polls in a row fail.
    const snapshot = yield* Effect.all(
      [pull(input.api, input.repo, input.number), reviews(input.api, input.repo, input.number)],
      { concurrency: 2 },
    ).pipe(
      Effect.flatMap(
        ([data, reviewList]): Effect.Effect<
          { data: PullData; reviewList: ReadonlyArray<RestReview>; copilot?: CopilotStatus },
          GitHubClient.Error
        > =>
          input.goal === "checks"
            ? Effect.succeed({ data, reviewList })
            : copilotStatus(input.api, input.repo, input.number, data.headRefOid, reviewList).pipe(
                Effect.map((copilot) => ({ data, reviewList, copilot })),
              ),
      ),
      Effect.result,
    )
    if (Result.isFailure(snapshot)) {
      const transient = ["network", "server", "rate_limited"].includes(snapshot.failure.kind)
      failures++
      if (!transient || failures >= MAX_POLL_FAILURES) return yield* snapshot.failure
      yield* Effect.sleep(input.interval)
      continue
    }
    failures = 0
    const data = snapshot.success.data
    const copilot = snapshot.success.copilot
    const now = yield* Clock.currentTimeMillis
    const checkSummary = input.goal === "copilot" ? undefined : checks(data, now)
    const reviewedSinceStart =
      copilot?.reviewed_at !== undefined && Date.parse(copilot.reviewed_at) >= input.started - 5_000
    const copilotDone =
      copilot === undefined || copilot.state === "reviewed" || (reviewedSinceStart && copilot.state !== "in_progress")
    const checksDone =
      checkSummary === undefined ||
      // Checks queued with no runner never finish; waiting on them would only run into the timeout.
      (checkSummary.pending.every((name) => checkSummary.stalled.some((check) => check.name === name)) &&
        checkSummary.state !== "EXPECTED")
    const waited = Math.round((now - input.started) / 1000)
    const base = {
      pr: label,
      waited_seconds: waited,
      requested: input.requested,
      head: data.headRefOid,
      ...(copilot ? { copilot } : {}),
      ...(checkSummary ? { checks: checkSummary } : {}),
    }
    if (data.state !== "OPEN")
      return {
        ...base,
        status: "stopped" as const,
        message: `${label} is ${data.state.toLowerCase()}. ${summarize(base)}`,
      }
    if (copilotDone && checksDone) {
      // List what is open now, so the session can start on the findings without another call.
      const open =
        copilot === undefined
          ? []
          : yield* openItems(input.api, input.repo, input.number, data, snapshot.success.reviewList).pipe(
              Effect.orElseSucceed((): string[] => []),
            )
      return {
        ...base,
        status: "completed" as const,
        message: [summarize(base), ...(open.length ? ["Open items:", ...open] : [])].join("\n"),
      }
    }
    if (now - input.started >= Duration.toMillis(input.timeout))
      return { ...base, status: "timed_out" as const, message: `Timed out after ${waited}s. ${summarize(base)}` }
    // A push during the wait leaves nothing pending unless the repository requests reviews on push. Give a fresh
    // request a minute to show up in the timeline before deciding that.
    const idle = copilot && !copilotDone && (copilot.state === "stale" || copilot.state === "none")
    const stuck = copilot?.state === "requested" && copilot.stuck
    if ((idle || stuck) && now - lastRequest > 60_000) {
      if (!input.allowRequest || rekicks >= 3)
        return {
          ...base,
          status: "stopped" as const,
          message: `No Copilot review is pending on ${label}${input.allowRequest ? " after 3 requests" : " and requesting is disabled"}. ${summarize(base)}`,
        }
      rekicks++
      lastRequest = now
      yield* requestCopilot(input.api, input.repo, input.number, stuck === true).pipe(Effect.ignore)
    }
    yield* Effect.sleep(input.interval)
  }
})

function summarize(input: {
  readonly copilot?: CopilotStatus
  readonly checks?: typeof Checks.Type
  readonly pr: string
}) {
  const lines: string[] = []
  if (input.copilot) {
    const copilot = input.copilot
    lines.push(
      copilot.state === "reviewed" || (copilot.reviewed_at && copilot.state === "stale")
        ? `Copilot reviewed ${copilot.reviewed_commit?.slice(0, 7) ?? "?"} (round ${copilot.rounds})${copilot.headline ? `: ${copilot.headline}` : ""}${copilot.summary ? ` — ${copilot.summary}` : ""}. Approved: ${copilot.approved ? "yes" : "no"}.`
        : `Copilot state: ${copilot.state}${copilot.reviewed_commit ? ` (last reviewed ${copilot.reviewed_commit.slice(0, 7)})` : ""}.`,
    )
    const findings = copilot.findings.filter((finding) => finding.new)
    if (findings.length > 0)
      lines.push(
        `${findings.length} new finding(s): ${findings.map((finding) => `[${finding.severity ?? "?"}] ${finding.title}`).join("; ")}`,
      )
    if (copilot.body_findings > 0) lines.push(`${copilot.body_findings} finding(s) only in the review body.`)
  }
  if (input.checks)
    lines.push(
      `Checks ${input.checks.state}: ${input.checks.passed}/${input.checks.total} passed${input.checks.failing.length ? `, failing: ${input.checks.failing.map((check) => check.name).join(", ")}` : ""}${input.checks.pending.length ? `, pending: ${input.checks.pending.length}` : ""}${input.checks.stalled.length ? `, never started (no runner?): ${input.checks.stalled.map((check) => check.name).join(", ")}` : ""}.`,
    )
  lines.push(`Next: call github feedback for ${input.pr} to read and respond to findings.`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------------------------------------------
// Background waits that outlive the plugin
// ---------------------------------------------------------------------------------------------------------------

const PendingWait = Schema.Struct({
  key: Schema.String,
  sessionID: Session.ID,
  directory: Schema.String,
  host: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  number: Schema.Int,
  goal: Schema.Literals(["copilot", "checks", "both"]),
  started: Schema.Number,
  timeout: Schema.Number,
  interval: Schema.Number,
  requested: Schema.Literals(["none", "requested", "re-requested"]),
  allowRequest: Schema.Boolean,
  lastRequest: Schema.Number,
})
type PendingWait = typeof PendingWait.Type
const decodeWait = Schema.decodeUnknownOption(PendingWait)
const WAIT_PREFIX = "github.wait/"

/** Fibers of the background waits in this process, by session, pull request and goal. */
const running = new Map<string, Fiber.Fiber<unknown, unknown>>()

/**
 * Runs a wait on the plugin's scope and records it in storage until it settles. A plugin reload or a server restart
 * interrupts the fiber but keeps the record, and `resume` picks it up again, so the session still gets its message.
 */
const background = Effect.fn("GitHubReview.background")(function* (deps: Deps, wait: PendingWait) {
  yield* deps.kv.set(`${WAIT_PREFIX}${wait.key}`, wait)
  const repo = { host: wait.host, owner: wait.owner, name: wait.name }
  const label = `${GitHubRepo.slug(repo)}#${wait.number}`
  const fiber = yield* poll({
    api: deps.client.forHost(wait.host),
    repo,
    number: wait.number,
    goal: wait.goal,
    started: wait.started,
    timeout: Duration.millis(wait.timeout),
    interval: Duration.millis(wait.interval),
    requested: wait.requested,
    allowRequest: wait.allowRequest,
    lastRequest: wait.lastRequest,
  }).pipe(
    Effect.exit,
    // Settled either way: drop the record while the message is delivered, so a slow admission cannot resend it.
    Effect.flatMap((exit) =>
      Effect.all([notify(deps, wait.sessionID, label, exit), deps.kv.remove(`${WAIT_PREFIX}${wait.key}`)], {
        concurrency: "unbounded",
        discard: true,
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        // A resumed wait may already have replaced this one.
        if (running.get(wait.key) === fiber) running.delete(wait.key)
      }),
    ),
    // Not started immediately, so the fiber is registered before it can finish.
    Effect.forkIn(deps.scope),
  )
  running.set(wait.key, fiber)
})

/** Restarts the waits recorded for this working directory, replacing any left over from an earlier plugin load. */
export const resume = Effect.fn("GitHubReview.resume")(function* (deps: Deps) {
  const records: PendingWait[] = []
  let after: string | undefined
  do {
    const page = yield* deps.kv.scan({ prefix: WAIT_PREFIX, ...(after ? { after } : {}) })
    records.push(...page.entries.flatMap((entry) => Option.toArray(decodeWait(entry.value))))
    after = page.next
  } while (after)
  yield* Effect.forEach(
    records.filter((wait) => wait.directory === deps.directory),
    (wait) =>
      Effect.gen(function* () {
        const stale = running.get(wait.key)
        if (stale) yield* Fiber.interrupt(stale)
        yield* background(deps, wait)
      }),
    { discard: true },
  )
})

/** Posts a finished background wait into its session, which wakes the session if it is idle. */
const notify = (
  deps: Deps,
  sessionID: Tool.Context["sessionID"],
  label: string,
  exit: Exit.Exit<typeof WaitResult.Type, GitHubClient.Error>,
) => {
  // The plugin scope closing interrupts waits; there is nobody left to tell.
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return Effect.void
  const state = Exit.isSuccess(exit) ? exit.value.status : "error"
  const text = Exit.isSuccess(exit)
    ? exit.value.message
    : `The wait failed: ${Cause.squash(exit.cause) instanceof GitHubClient.Error ? (Cause.squash(exit.cause) as GitHubClient.Error).message : Cause.pretty(exit.cause)}`
  return deps.sessions
    .synthetic({
      sessionID,
      description: `GitHub wait on ${label}`,
      text: `<github-wait pr="${label}" state="${state}">\n${text}\n</github-wait>`,
      metadata: { source: "github.wait", pr: label, state },
    })
    .pipe(Effect.ignore)
}

/** One line per open review thread and Copilot body finding, for a wait's completion message. */
const openItems = Effect.fn("GitHubReview.openItems")(function* (
  api: Api,
  repo: GitHubRepo.Ref,
  number: number,
  data: PullData,
  reviewList: ReadonlyArray<RestReview>,
) {
  const threadList = yield* threads(api, repo, number)
  const summaries = copilotReviews(reviewList).map((review) => ({
    review,
    summary: GitHubCopilot.parseReview(review.body),
  }))
  const known = findingIndex(summaries.map((entry) => entry.summary))
  const location = (path: string | undefined, line: number | null | undefined) =>
    path ? ` ${path}${line ? `:${line}` : ""}` : ""
  const lines = [
    ...threadList
      .filter((thread) => !thread.isResolved)
      .map((thread) => {
        const first = thread.comments.nodes[0]
        const finding = first ? known.get(first.databaseId) : undefined
        const text = finding?.title ?? GitHubCopilot.plain(first?.body ?? "").split("\n")[0] ?? ""
        return `- ${thread.id} [${finding?.severity ?? authorOf(first?.author).kind}]${location(thread.path, thread.line ?? thread.originalLine)} ${GitHubShared.clip(text, 140)}`
      }),
    ...summaries
      .filter((entry) => entry.review.commit === data.headRefOid)
      .flatMap((entry) =>
        entry.summary.body.map(
          (finding, index) =>
            `- copilot:${entry.review.id}:${index} [${finding.severity ?? finding.kind}]${location(finding.path, finding.line)} ${GitHubShared.clip(finding.title ?? finding.body.split("\n")[0] ?? "", 140)}`,
        ),
      ),
  ]
  return lines.length > OPEN_ITEM_LIMIT
    ? [...lines.slice(0, OPEN_ITEM_LIMIT), `- … ${lines.length - OPEN_ITEM_LIMIT} more; call feedback for all of them.`]
    : lines
})

const OPEN_ITEM_LIMIT = 20

/** Whether the base branch's rules ask Copilot to review every push on its own. */
const reviewsOnPush = (api: Api, repo: GitHubRepo.Ref, branch: string) =>
  api
    .json<
      ReadonlyArray<{ type: string; parameters?: { review_on_push?: boolean } }>
    >("GET", `/repos/${GitHubRepo.slug(repo)}/rules/branches/${GitHubShared.refPath(branch)}`)
    .pipe(
      Effect.map((rules) =>
        rules.some((rule) => rule.type === "copilot_code_review" && rule.parameters?.review_on_push),
      ),
      Effect.orElseSucceed(() => false),
    )

/**
 * Merge readiness as reviewers here treat it: CI green on the pushed head and no open correctness or security defect.
 * Waiting for zero Copilot threads never converges, because every push gets a fresh review, so low and medium Copilot
 * findings only warn.
 */
function readiness(input: {
  readonly data: PullData
  readonly copilot: CopilotStatus
  readonly checks: typeof Checks.Type
  readonly localHead: string | undefined
  readonly threads: ReadonlyArray<{
    readonly kind: GitHubCopilot.AuthorKind
    readonly outdated: boolean
    readonly severity?: string
  }>
  readonly alerts: ReadonlyArray<string>
}) {
  const blockers: string[] = []
  const warnings: string[] = []
  if (input.data.state !== "OPEN") blockers.push(`The pull request is ${input.data.state.toLowerCase()}.`)
  if (input.data.isDraft) blockers.push("Draft: mark it ready for review first.")
  if (input.data.mergeable === "CONFLICTING") blockers.push(`Conflicts with ${input.data.baseRefName}.`)
  if (input.localHead && input.localHead !== input.data.headRefOid) blockers.push("Local commits are not pushed.")
  const failing = input.checks.failing.filter((check) => check.required)
  if (failing.length) blockers.push(`Required checks failing: ${failing.map((check) => check.name).join(", ")}.`)
  if (input.checks.failing.length > failing.length)
    warnings.push(
      `Optional checks failing: ${input.checks.failing
        .filter((check) => !check.required)
        .map((check) => check.name)
        .join(", ")}.`,
    )
  const stalled = new Set(input.checks.stalled.map((check) => check.name))
  const running = input.checks.pending.filter((name) => !stalled.has(name))
  const requiredRunning = running.filter((name) => input.checks.required_pending.includes(name))
  if (requiredRunning.length) blockers.push(`Required checks still running: ${requiredRunning.join(", ")}.`)
  if (running.length > requiredRunning.length)
    warnings.push(`${running.length - requiredRunning.length} optional check(s) still running.`)
  const runners = Array.from(new Set(input.checks.stalled.flatMap((check) => (check.runner ? [check.runner] : []))))
  const stalledRequired = input.checks.stalled.filter((check) => input.checks.required_pending.includes(check.name))
  const stalledText = `queued for over ${STALLED_MS / 60_000} minutes without starting${runners.length ? `; they wait for runners labeled ${runners.join(" | ")}, which this repository may not have` : ""}`
  if (stalledRequired.length)
    blockers.push(`Required checks ${stalledRequired.map((check) => check.name).join(", ")} ${stalledText}.`)
  if (input.checks.stalled.length > stalledRequired.length)
    warnings.push(
      `Optional checks ${input.checks.stalled
        .filter((check) => !stalledRequired.includes(check))
        .map((check) => check.name)
        .join(", ")} ${stalledText}.`,
    )
  if (input.data.reviewDecision === "CHANGES_REQUESTED") blockers.push("A reviewer requested changes.")
  if (input.data.reviewDecision === "REVIEW_REQUIRED") blockers.push("An approving review is required.")
  const human = input.threads.filter((thread) => thread.kind === "human")
  if (human.length) blockers.push(`${human.length} unresolved thread(s) from people.`)
  const serious = input.threads.filter(
    (thread) => thread.kind !== "human" && (thread.severity === "high" || thread.severity === "critical"),
  )
  if (serious.length) blockers.push(`${serious.length} unresolved high-severity bot finding(s).`)
  const minor = input.threads.length - human.length - serious.length
  if (minor > 0) warnings.push(`${minor} unresolved lower-severity bot thread(s); resolve or file them as follow-ups.`)
  const severeAlerts = input.alerts.filter((level) => level === "critical" || level === "high" || level === "error")
  if (severeAlerts.length) blockers.push(`${severeAlerts.length} open high-severity code scanning alert(s).`)
  if (input.alerts.length > severeAlerts.length)
    warnings.push(`${input.alerts.length - severeAlerts.length} other open code scanning alert(s).`)
  if (input.data.mergeStateStatus === "BEHIND") warnings.push(`Behind ${input.data.baseRefName}.`)
  if (input.copilot.state === "in_progress" || input.copilot.state === "requested")
    warnings.push("Copilot is still reviewing.")
  if (input.copilot.state === "stale") warnings.push("Copilot has not reviewed the latest commit.")
  return { merge: blockers.length === 0, blockers, warnings }
}

function nextSteps(input: {
  readonly data: PullData
  readonly copilot: CopilotStatus
  readonly feedback: { readonly unresolved_threads: number; readonly open_alerts?: number }
  readonly checks: typeof Checks.Type
  readonly localHead: string | undefined
  readonly autoRequest: boolean
}) {
  const steps: string[] = []
  if (input.data.state !== "OPEN") return [`The pull request is ${input.data.state.toLowerCase()}.`]
  if (input.localHead && input.localHead !== input.data.headRefOid)
    steps.push("Local HEAD differs from the pushed head: push before asking for review.")
  if (input.feedback.unresolved_threads > 0 || (input.feedback.open_alerts ?? 0) > 0 || input.copilot.body_findings > 0)
    steps.push("Read open findings with feedback, then respond.")
  if (input.copilot.state === "in_progress" || input.copilot.state === "requested")
    steps.push("Copilot is reviewing: wait (background) to be notified.")
  if ((input.copilot.state === "stale" || input.copilot.state === "none") && input.autoRequest)
    steps.push("Head commit not reviewed by Copilot: wait requests a review and notifies you.")
  if (input.copilot.stuck) steps.push("Copilot's review looks stuck: copilot re-requests it.")
  if (input.checks.failing.length > 0) steps.push("Checks failing: inspect with run and logs.")
  if (input.checks.pending.length > input.checks.stalled.length) steps.push("Checks pending: wait with for: checks.")
  if (input.checks.stalled.length > 0)
    steps.push("Some checks never started: look at their runs (run) and the runner labels they need.")
  if (input.data.mergeable === "CONFLICTING")
    steps.push(`Merge conflicts with ${input.data.baseRefName}: merge or rebase the target branch.`)
  if (input.data.mergeStateStatus === "BEHIND")
    steps.push(`Branch is behind ${input.data.baseRefName}: update it before merging.`)
  if (steps.length === 0 && input.data.mergeStateStatus === "CLEAN")
    steps.push("Ready to merge (pr_merge) once you are satisfied.")
  return steps
}
