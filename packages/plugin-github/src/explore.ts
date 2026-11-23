export * as GitHubExplore from "./explore.js"

import fs from "node:fs/promises"
import path from "node:path"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema } from "effect"
import { GitHubClient } from "./client.js"
import { GitHubRepo } from "./repo.js"
import { GitHubShared } from "./shared.js"

type Deps = GitHubShared.Deps
type Api = GitHubClient.Api

const defaultHost = () => process.env.GH_HOST || "github.com"

const Opt = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)
const StringList = Schema.Array(Schema.String)

const SCOPED = /(^|\s)-?(repo|org|user):/i

const firstLine = (text: string | null | undefined) => (text ?? "").split("\n")[0]?.trim() ?? ""

/** Resolves `repo` when given (failing on a bad one); otherwise uses the working directory's repository if there is one. */
const optionalTarget = Effect.fn("GitHubExplore.optionalTarget")(function* (deps: Deps, repo?: string) {
  const resolved =
    repo === undefined
      ? Option.getOrUndefined(yield* GitHubShared.target(deps).pipe(Effect.option))
      : yield* GitHubShared.target(deps, repo)
  return { resolved, api: resolved?.api ?? deps.client.forHost(defaultHost()) }
})

type Attempt<A> = { readonly ok: true; readonly data: A } | { readonly ok: false; readonly error: GitHubClient.Error }

// Settings endpoints answer 403 or 404 without admin access; those become unavailable sections rather than failures.
const attempt = <A>(effect: Effect.Effect<A, GitHubClient.Error>): Effect.Effect<Attempt<A>> =>
  effect.pipe(
    Effect.map((data): Attempt<A> => ({ ok: true, data })),
    Effect.catch((error) => Effect.succeed<Attempt<A>>({ ok: false, error })),
  )

const why = (error: GitHubClient.Error, missing: string, forbidden = "requires admin access") => {
  if (error.kind === "forbidden") return forbidden
  if (error.kind === "not_found") return missing
  return `${error.kind}: ${error.message}`
}

// The settings page offers named choices for each merge method's default commit message; the API stores a title and
// message pair. Exported for repo_update, which accepts the names too.
export const MERGE_DEFAULTS = {
  "Default message": ["MERGE_MESSAGE", "PR_TITLE"],
  "Pull request title": ["PR_TITLE", "BLANK"],
  "Pull request title and description": ["PR_TITLE", "PR_BODY"],
} as const

export const SQUASH_DEFAULTS = {
  "Default message": ["COMMIT_OR_PR_TITLE", "COMMIT_MESSAGES"],
  "Pull request title": ["PR_TITLE", "BLANK"],
  "Pull request title and commit details": ["PR_TITLE", "COMMIT_MESSAGES"],
  "Pull request title and description": ["PR_TITLE", "PR_BODY"],
} as const

const commitDefault = (
  choices: Readonly<Record<string, readonly [string, string]>>,
  title: string | undefined,
  message: string | undefined,
) => Object.entries(choices).find(([, pair]) => pair[0] === title && pair[1] === message)?.[0]

const ownerKind = (api: Api, owner: string) =>
  api
    .json<{ type?: string }>("GET", `/users/${encodeURIComponent(owner)}`)
    .pipe(Effect.map((user) => (user.type === "Organization" ? ("org" as const) : ("user" as const))))

// Keeps `/` and the `owner:branch` colon readable; GitHub routes refs with slashes in compare and branch paths.
const encodeRef = (ref: string) =>
  ref
    .split("/")
    .map((part) => encodeURIComponent(part).replaceAll("%3A", ":"))
    .join("/")

// ---------------------------------------------------------------------------------------------------------------
// repo
// ---------------------------------------------------------------------------------------------------------------

const SECTIONS = [
  "general",
  "merging",
  "protection",
  "rulesets",
  "security",
  "actions",
  "environments",
  "codeowners",
] as const
type SectionName = (typeof SECTIONS)[number]

const section = <F extends Schema.Struct.Fields>(fields: F) =>
  Opt(Schema.Struct({ available: Schema.Boolean, reason: Opt(Schema.String), ...fields }))

const RuleSummary = Schema.Struct({
  type: Schema.String,
  ruleset_id: Opt(Schema.Int),
  parameters: Opt(Schema.Record(Schema.String, Schema.Unknown)),
})

const RepoOutput = Schema.Struct({
  repo: Schema.String,
  url: Schema.String,
  general: section({
    description: Opt(Schema.NullOr(Schema.String)),
    visibility: Opt(Schema.String),
    default_branch: Opt(Schema.String),
    topics: Opt(StringList),
    language: Opt(Schema.NullOr(Schema.String)),
    archived: Opt(Schema.Boolean),
    fork: Opt(Schema.Boolean),
    parent: Opt(Schema.String),
    stars: Opt(Schema.Int),
    open_issues: Opt(Schema.Int),
    has_issues: Opt(Schema.Boolean),
    has_wiki: Opt(Schema.Boolean),
    has_projects: Opt(Schema.Boolean),
    has_discussions: Opt(Schema.Boolean),
    has_pull_requests: Opt(Schema.Boolean),
    pull_request_creation: Opt(Schema.String).annotate({ description: "Who may open pull requests, such as all." }),
    has_pages: Opt(Schema.Boolean),
    allow_forking: Opt(Schema.Boolean),
    is_template: Opt(Schema.Boolean),
    commit_signoff_required: Opt(Schema.Boolean),
    release_immutability: Opt(Schema.Boolean).annotate({
      description: "Published releases' assets and tags are locked.",
    }),
    custom_properties: Opt(Schema.Record(Schema.String, Schema.Unknown)),
    permission: Opt(Schema.String).annotate({
      description: "The authenticated account's highest role: admin, maintain, push, triage or pull.",
    }),
    pushed_at: Opt(Schema.String),
  }),
  merging: section({
    allow_merge_commit: Opt(Schema.Boolean),
    allow_squash_merge: Opt(Schema.Boolean),
    allow_rebase_merge: Opt(Schema.Boolean),
    allow_auto_merge: Opt(Schema.Boolean),
    delete_branch_on_merge: Opt(Schema.Boolean),
    allow_update_branch: Opt(Schema.Boolean),
    squash_merge_commit_title: Opt(Schema.String),
    squash_merge_commit_message: Opt(Schema.String),
    merge_commit_title: Opt(Schema.String),
    merge_commit_message: Opt(Schema.String),
    use_squash_pr_title_as_default: Opt(Schema.Boolean),
    merge_commit_default: Opt(Schema.String).annotate({
      description: "The default commit message as the settings page names it.",
    }),
    squash_commit_default: Opt(Schema.String).annotate({
      description: "The default commit message as the settings page names it.",
    }),
  }),
  protection: section({
    branch: Opt(Schema.String),
    classic: Opt(
      Schema.Struct({
        required_checks: StringList,
        strict_checks: Schema.Boolean,
        required_reviews: Opt(Schema.Int),
        code_owner_reviews: Opt(Schema.Boolean),
        dismiss_stale: Opt(Schema.Boolean),
        enforce_admins: Schema.Boolean,
        linear_history: Schema.Boolean,
        signed_commits: Opt(Schema.Boolean),
        conversation_resolution: Schema.Boolean,
        force_pushes: Schema.Boolean,
        deletions: Schema.Boolean,
      }),
    ).annotate({ description: "Classic branch protection on the default branch." }),
    classic_note: Opt(Schema.String),
    rules: Opt(Schema.Array(RuleSummary)).annotate({
      description: "Ruleset rules that apply to the default branch (readable with read access).",
    }),
    rules_note: Opt(Schema.String),
  }),
  rulesets: section({
    rulesets: Opt(
      Schema.Array(
        Schema.Struct({
          id: Schema.Int,
          name: Schema.String,
          target: Opt(Schema.String),
          enforcement: Schema.String,
          source: Opt(Schema.String),
        }),
      ),
    ),
  }),
  security: section({
    security_and_analysis: Opt(Schema.Record(Schema.String, Schema.String)),
    code_scanning_default_setup: Opt(
      Schema.Struct({ state: Schema.String, languages: StringList, query_suite: Opt(Schema.String) }),
    ),
    dependabot_alerts: Opt(Schema.Boolean),
    notes: Opt(StringList),
  }),
  actions: section({
    enabled: Opt(Schema.Boolean),
    allowed_actions: Opt(Schema.String),
    default_workflow_permissions: Opt(Schema.String),
    can_approve_pull_request_reviews: Opt(Schema.Boolean),
    notes: Opt(StringList),
  }),
  environments: section({
    environments: Opt(
      Schema.Array(
        Schema.Struct({ name: Schema.String, protections: StringList, deployment_branches: Opt(Schema.String) }),
      ),
    ),
  }),
  codeowners: section({
    path: Opt(Schema.String),
    rules: Opt(Schema.Int),
    preview: Opt(Schema.String),
    url: Opt(Schema.String),
  }),
})

interface RepoPayload {
  readonly id: number
  readonly full_name: string
  readonly html_url: string
  readonly description: string | null
  readonly visibility?: string
  readonly private: boolean
  readonly default_branch: string
  readonly topics?: ReadonlyArray<string>
  readonly language: string | null
  readonly archived: boolean
  readonly fork: boolean
  readonly parent?: { readonly full_name: string }
  readonly stargazers_count: number
  readonly open_issues_count: number
  readonly has_issues?: boolean
  readonly has_wiki?: boolean
  readonly has_projects?: boolean
  readonly has_discussions?: boolean
  readonly has_pull_requests?: boolean
  readonly pull_request_creation_policy?: string
  readonly has_pages?: boolean
  readonly allow_forking?: boolean
  readonly is_template?: boolean
  readonly web_commit_signoff_required?: boolean
  readonly custom_properties?: Readonly<Record<string, unknown>>
  readonly use_squash_pr_title_as_default?: boolean
  readonly pushed_at?: string | null
  readonly permissions?: Readonly<Record<string, boolean>>
  readonly allow_merge_commit?: boolean
  readonly allow_squash_merge?: boolean
  readonly allow_rebase_merge?: boolean
  readonly allow_auto_merge?: boolean
  readonly delete_branch_on_merge?: boolean
  readonly allow_update_branch?: boolean
  readonly squash_merge_commit_title?: string
  readonly squash_merge_commit_message?: string
  readonly merge_commit_title?: string
  readonly merge_commit_message?: string
  readonly security_and_analysis?: Readonly<Record<string, { readonly status?: string } | null>> | null
}

interface Enabled {
  readonly enabled?: boolean
}

interface ProtectionPayload {
  readonly required_status_checks?: {
    readonly strict?: boolean
    readonly contexts?: ReadonlyArray<string>
    readonly checks?: ReadonlyArray<{ readonly context: string }>
  } | null
  readonly required_pull_request_reviews?: {
    readonly required_approving_review_count?: number
    readonly require_code_owner_reviews?: boolean
    readonly dismiss_stale_reviews?: boolean
  } | null
  readonly enforce_admins?: Enabled | null
  readonly required_linear_history?: Enabled | null
  readonly required_signatures?: Enabled | null
  readonly required_conversation_resolution?: Enabled | null
  readonly allow_force_pushes?: Enabled | null
  readonly allow_deletions?: Enabled | null
}

interface RulePayload {
  readonly type: string
  readonly ruleset_id?: number
  readonly parameters?: Readonly<Record<string, unknown>> | null
}

const ROLES = ["admin", "maintain", "push", "triage", "pull"] as const

function protectionSummary(data: ProtectionPayload) {
  const checks = data.required_status_checks
  const reviews = data.required_pull_request_reviews
  const contexts = [...(checks?.contexts ?? []), ...(checks?.checks ?? []).map((check) => check.context)]
  return {
    required_checks: [...new Set(contexts)],
    strict_checks: checks?.strict === true,
    ...(reviews
      ? {
          required_reviews: reviews.required_approving_review_count ?? 0,
          code_owner_reviews: reviews.require_code_owner_reviews === true,
          dismiss_stale: reviews.dismiss_stale_reviews === true,
        }
      : {}),
    enforce_admins: data.enforce_admins?.enabled === true,
    linear_history: data.required_linear_history?.enabled === true,
    ...(data.required_signatures ? { signed_commits: data.required_signatures.enabled === true } : {}),
    conversation_resolution: data.required_conversation_resolution?.enabled === true,
    force_pushes: data.allow_force_pushes?.enabled === true,
    deletions: data.allow_deletions?.enabled === true,
  }
}

/** Reduces status-check rule parameters to their context names; other rules keep their (small) parameter objects. */
export function ruleSummary(rule: RulePayload) {
  const parameters = rule.parameters ?? undefined
  const checks = rule.type === "required_status_checks" ? parameters?.required_status_checks : undefined
  const reduced = Array.isArray(checks)
    ? {
        contexts: checks.flatMap((check: unknown) =>
          typeof check === "object" && check !== null && "context" in check ? [String(check.context)] : [],
        ),
        strict: parameters?.strict_required_status_checks_policy === true,
      }
    : parameters
  return {
    type: rule.type,
    ...(rule.ruleset_id !== undefined ? { ruleset_id: rule.ruleset_id } : {}),
    ...(reduced && Object.keys(reduced).length ? { parameters: reduced } : {}),
  }
}

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]

// ---------------------------------------------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------------------------------------------

const SEARCH_TYPES = ["code", "commits", "issues", "prs", "repos", "users", "discussions"] as const
type SearchType = (typeof SEARCH_TYPES)[number]
const REPO_SCOPED: ReadonlyArray<SearchType> = ["code", "commits", "issues", "prs", "discussions"]

const CodeItem = Schema.Struct({
  repo: Schema.String,
  path: Schema.String,
  url: Schema.String,
  fragments: Opt(StringList),
})
const CommitItem = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
  message: Schema.String,
  author: Schema.String,
  date: Schema.String,
  url: Schema.String,
})
const IssueItem = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  author: Schema.String,
  url: Schema.String,
  updated_at: Schema.String,
})
const RepoItem = Schema.Struct({
  full_name: Schema.String,
  description: Schema.NullOr(Schema.String),
  stars: Schema.Int,
  language: Schema.NullOr(Schema.String),
  pushed_at: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  url: Schema.String,
})
const UserItem = Schema.Struct({ login: Schema.String, type: Schema.String, url: Schema.String })
const DiscussionItem = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  answered: Schema.Boolean,
  updated_at: Schema.String,
})

interface SearchPage<A> {
  readonly total_count: number
  readonly incomplete_results?: boolean
  readonly items: ReadonlyArray<A>
}

interface CodeHit {
  readonly path: string
  readonly html_url: string
  readonly repository: { readonly full_name: string }
  readonly text_matches?: ReadonlyArray<{ readonly fragment: string }>
}

interface CommitHit {
  readonly sha: string
  readonly html_url: string
  readonly commit: {
    readonly message: string
    readonly author: { readonly name: string; readonly date: string } | null
  }
  readonly author: { readonly login: string } | null
  readonly repository: { readonly full_name: string }
}

interface IssueHit {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly user: { readonly login: string } | null
  readonly html_url: string
  readonly updated_at: string
  readonly repository_url: string
}

interface RepoHit {
  readonly full_name: string
  readonly description: string | null
  readonly stargazers_count: number
  readonly language: string | null
  readonly pushed_at: string | null
  readonly archived: boolean
  readonly html_url: string
}

interface UserHit {
  readonly login: string
  readonly type: string
  readonly html_url: string
}

const DISCUSSION_SEARCH = `query($query: String!, $first: Int!) {
  search(type: DISCUSSION, query: $query, first: $first) {
    discussionCount
    nodes { ... on Discussion { number title url isAnswered updatedAt repository { nameWithOwner } } }
  }
}`

interface DiscussionNode {
  readonly number?: number
  readonly title: string
  readonly url: string
  readonly isAnswered: boolean | null
  readonly updatedAt: string
  readonly repository: { readonly nameWithOwner: string }
}

const REST_SEARCH: Record<Exclude<SearchType, "discussions">, string> = {
  code: "code",
  commits: "commits",
  issues: "issues",
  prs: "issues",
  repos: "repositories",
  users: "users",
}

// ---------------------------------------------------------------------------------------------------------------
// commits / compare
// ---------------------------------------------------------------------------------------------------------------

const CommitSummary = Schema.Struct({
  sha: Schema.String,
  short: Schema.String,
  message: Schema.String,
  author: Schema.Struct({ login: Opt(Schema.String), name: Schema.String, date: Schema.String }),
  committer_login: Opt(Schema.String),
  parents: StringList.annotate({ description: "Short SHAs of the parents; two or more is a merge." }),
  url: Schema.String,
})

interface CommitPayload {
  readonly sha: string
  readonly html_url: string
  readonly commit: {
    readonly message: string
    readonly author: { readonly name?: string; readonly email?: string; readonly date?: string } | null
  }
  readonly author: { readonly login: string } | null
  readonly committer: { readonly login: string } | null
  readonly parents: ReadonlyArray<{ readonly sha: string }>
}

const commitSummary = (commit: CommitPayload) => ({
  sha: commit.sha,
  short: commit.sha.slice(0, 7),
  message: firstLine(commit.commit.message),
  author: {
    ...(commit.author?.login ? { login: commit.author.login } : {}),
    name: commit.commit.author?.name ?? commit.commit.author?.email ?? "unknown",
    date: commit.commit.author?.date ?? "",
  },
  ...(commit.committer?.login ? { committer_login: commit.committer.login } : {}),
  parents: commit.parents.map((parent) => parent.sha.slice(0, 7)),
  url: commit.html_url,
})

const MAX_COMMIT_PAGES = 20

// ---------------------------------------------------------------------------------------------------------------
// repos
// ---------------------------------------------------------------------------------------------------------------

const RepoSummary = Schema.Struct({
  full_name: Schema.String,
  description: Opt(Schema.String),
  private: Schema.Boolean,
  archived: Schema.Boolean,
  fork: Schema.Boolean,
  language: Opt(Schema.String),
  stars: Schema.Int,
  pushed_at: Opt(Schema.String),
  default_branch: Opt(Schema.String),
  url: Schema.String,
  commits_by_contributor: Opt(Schema.Int),
  last_commit_by_contributor: Opt(Schema.String),
})

interface RepoListing {
  readonly full_name: string
  readonly description?: string | null
  readonly private: boolean
  readonly archived?: boolean
  readonly fork: boolean
  readonly language?: string | null
  readonly stargazers_count?: number
  readonly pushed_at?: string | null
  readonly default_branch?: string
  readonly html_url: string
  readonly topics?: ReadonlyArray<string>
}

const repoSummary = (repo: RepoListing) => ({
  full_name: repo.full_name,
  ...(repo.description ? { description: repo.description } : {}),
  private: repo.private,
  archived: repo.archived === true,
  fork: repo.fork,
  ...(repo.language ? { language: repo.language } : {}),
  stars: repo.stargazers_count ?? 0,
  ...(repo.pushed_at ? { pushed_at: repo.pushed_at } : {}),
  ...(repo.default_branch ? { default_branch: repo.default_branch } : {}),
  url: repo.html_url,
})

interface ContributionHit {
  readonly commit: {
    readonly author: { readonly date?: string } | null
    readonly committer: { readonly date?: string } | null
  }
  readonly repository: RepoListing
}

interface YearlyContributions {
  readonly user: {
    readonly contributionsCollection: {
      readonly commitContributionsByRepository: ReadonlyArray<{
        readonly repository: { readonly nameWithOwner: string }
        readonly contributions: {
          readonly totalCount: number
          readonly nodes: ReadonlyArray<{ readonly occurredAt: string }>
        }
      }>
    }
  } | null
}

const YEARLY_QUERY = `query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      commitContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner }
        contributions(first: 1, orderBy: { field: OCCURRED_AT, direction: DESC }) { totalCount nodes { occurredAt } }
      }
    }
  }
}`

function yearlyRepositories(data: YearlyContributions) {
  return (data.user?.contributionsCollection.commitContributionsByRepository ?? []).map((entry) => ({
    full_name: entry.repository.nameWithOwner,
    count: entry.contributions.totalCount,
    latest: entry.contributions.nodes[0]?.occurredAt ?? "",
  }))
}

/** Groups commit-search hits by repository with a commit count and the latest author date, newest first. */
export function contributions(hits: ReadonlyArray<ContributionHit>) {
  const grouped = new Map<string, { repo: RepoListing; count: number; latest: string }>()
  for (const hit of hits) {
    const date = hit.commit.author?.date ?? hit.commit.committer?.date ?? ""
    const current = grouped.get(hit.repository.full_name)
    if (!current) {
      grouped.set(hit.repository.full_name, { repo: hit.repository, count: 1, latest: date })
      continue
    }
    current.count += 1
    if (date > current.latest) current.latest = date
  }
  return [...grouped.values()].toSorted((left, right) => right.latest.localeCompare(left.latest))
}

// ---------------------------------------------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------------------------------------------

const MEDIA: Record<string, { readonly type: string; readonly video: boolean }> = {
  ".png": { type: "image/png", video: false },
  ".jpg": { type: "image/jpeg", video: false },
  ".jpeg": { type: "image/jpeg", video: false },
  ".gif": { type: "image/gif", video: false },
  ".webp": { type: "image/webp", video: false },
  ".svg": { type: "image/svg+xml", video: false },
  ".mp4": { type: "video/mp4", video: true },
  ".mov": { type: "video/quicktime", video: true },
  ".webm": { type: "video/webm", video: true },
}

const IMAGE_MAX = 10 * 1024 * 1024
const VIDEO_MAX = 100 * 1024 * 1024

const readLocal = (file: string) =>
  Effect.tryPromise({
    try: async () => {
      const stat = await fs.stat(file)
      if (!stat.isFile()) throw new globalThis.Error(`${file} is not a file`)
      return stat.size
    },
    catch: (error) =>
      new GitHubClient.Error({
        kind: "validation",
        message: `Cannot read ${file}: ${error instanceof globalThis.Error ? error.message : String(error)}`,
      }),
  })

/**
 * Reads a file for upload, enforcing the size limit during the read itself. The `readLocal` size is only a
 * pre-check: the file can grow or be replaced before this runs, so the opened handle is re-checked and the read
 * stops as soon as the total passes `max`. The bytes read must also match the authorized size exactly, so what
 * gets uploaded is always what was approved.
 */
const readBytes = (file: string, max: number, authorized: number) =>
  Effect.tryPromise({
    try: async () => {
      const handle = await fs.open(file, "r")
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) throw new globalThis.Error(`${file} is not a file`)
        if (stat.size > max)
          throw new globalThis.Error(`${file} grew to ${stat.size} bytes, over the ${max}-byte upload limit`)
        const chunks: Buffer[] = []
        let total = 0
        const scratch = Buffer.allocUnsafe(64 * 1024)
        for (;;) {
          const { bytesRead } = await handle.read(scratch, 0, scratch.byteLength, null)
          if (bytesRead === 0) break
          total += bytesRead
          if (total > max)
            throw new globalThis.Error(`${file} grew past the ${max}-byte upload limit while being read`)
          chunks.push(Buffer.from(scratch.subarray(0, bytesRead)))
        }
        if (total !== authorized)
          throw new globalThis.Error(
            `${file} changed while being read: ${authorized} bytes were authorized but ${total} bytes were read`,
          )
        return new Uint8Array(Buffer.concat(chunks, total))
      } finally {
        await handle.close()
      }
    },
    catch: (error) =>
      new GitHubClient.Error({
        kind: "validation",
        message: `Cannot read ${file}: ${error instanceof globalThis.Error ? error.message : String(error)}`,
      }),
  })

// ---------------------------------------------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------------------------------------------

/** Collects items from a REST list, unwrapping the first array property of wrapped responses such as `workflow_runs`. */
const collect = Effect.fn("GitHubExplore.collect")(function* (
  api: Api,
  first: string,
  query: GitHubClient.Query | undefined,
  limit: number,
) {
  const items: unknown[] = []
  let next: string | undefined = first
  let params = { per_page: Math.min(100, limit), ...query } as GitHubClient.Query | undefined
  while (next && items.length < limit) {
    const response: GitHubClient.Response<unknown> = yield* api.request("GET", next, { query: params })
    const page = Array.isArray(response.data)
      ? response.data
      : typeof response.data === "object" && response.data !== null
        ? Object.values(response.data).find((value) => Array.isArray(value))
        : undefined
    if (!Array.isArray(page)) return { data: response.data, items: undefined }
    items.push(...page)
    next = GitHubClient.nextLink(response.headers.link)
    params = undefined
  }
  return { data: items.slice(0, limit), items: Math.min(items.length, limit) }
})

// ---------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------

export function tools(deps: Deps): Tool.Info[] {
  const repo = GitHubShared.define(deps, {
    name: "repo",
    description: [
      "Repository overview and settings: merging, branch protection and rules, security, Actions, environments, CODEOWNERS.",
      "Sections the account cannot read come back available: false with a reason instead of failing.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      sections: Opt(Schema.Array(Schema.Literals(SECTIONS))).annotate({
        description: "Sections to include. Default all.",
      }),
    }),
    output: RepoOutput,
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const slug = GitHubRepo.slug(resolved.repo)
        const base = `/repos/${slug}`
        const info = yield* api.json<RepoPayload>("GET", base)
        const wanted = new Set<SectionName>(input.sections?.length ? input.sections : SECTIONS)
        const branch = encodeRef(info.default_branch)

        const general = () =>
          attempt(api.json<{ enabled?: boolean }>("GET", `${base}/immutable-releases`)).pipe(
            Effect.map((immutable) => ({
              available: true,
              description: info.description,
              ...(info.visibility
                ? { visibility: info.visibility }
                : { visibility: info.private ? "private" : "public" }),
              default_branch: info.default_branch,
              ...(info.topics ? { topics: [...info.topics] } : {}),
              language: info.language,
              archived: info.archived,
              fork: info.fork,
              ...(info.parent ? { parent: info.parent.full_name } : {}),
              stars: info.stargazers_count,
              open_issues: info.open_issues_count,
              ...(info.has_issues !== undefined ? { has_issues: info.has_issues } : {}),
              ...(info.has_wiki !== undefined ? { has_wiki: info.has_wiki } : {}),
              ...(info.has_projects !== undefined ? { has_projects: info.has_projects } : {}),
              ...(info.has_discussions !== undefined ? { has_discussions: info.has_discussions } : {}),
              ...(info.has_pull_requests !== undefined ? { has_pull_requests: info.has_pull_requests } : {}),
              ...(info.pull_request_creation_policy
                ? { pull_request_creation: info.pull_request_creation_policy }
                : {}),
              ...(info.has_pages !== undefined ? { has_pages: info.has_pages } : {}),
              ...(info.allow_forking !== undefined ? { allow_forking: info.allow_forking } : {}),
              ...(info.is_template !== undefined ? { is_template: info.is_template } : {}),
              ...(info.web_commit_signoff_required !== undefined
                ? { commit_signoff_required: info.web_commit_signoff_required }
                : {}),
              ...(immutable.ok && immutable.data.enabled !== undefined
                ? { release_immutability: immutable.data.enabled }
                : {}),
              ...(info.custom_properties && Object.keys(info.custom_properties).length
                ? { custom_properties: { ...info.custom_properties } }
                : {}),
              ...(info.permissions ? { permission: ROLES.find((role) => info.permissions?.[role]) ?? "none" } : {}),
              ...(info.pushed_at ? { pushed_at: info.pushed_at } : {}),
            })),
          )

        const merging = () => {
          const keys = [
            "allow_merge_commit",
            "allow_squash_merge",
            "allow_rebase_merge",
            "allow_auto_merge",
            "delete_branch_on_merge",
            "allow_update_branch",
            "squash_merge_commit_title",
            "squash_merge_commit_message",
            "merge_commit_title",
            "merge_commit_message",
            "use_squash_pr_title_as_default",
          ] as const
          const data = Object.fromEntries(keys.flatMap((key) => (info[key] === undefined ? [] : [[key, info[key]]])))
          if (Object.keys(data).length === 0)
            return Effect.succeed({ available: false, reason: "merge settings require write access" })
          const merge = commitDefault(MERGE_DEFAULTS, info.merge_commit_title, info.merge_commit_message)
          const squash = commitDefault(
            SQUASH_DEFAULTS,
            info.squash_merge_commit_title,
            info.squash_merge_commit_message,
          )
          return Effect.succeed({
            available: true,
            ...data,
            ...(merge ? { merge_commit_default: merge } : {}),
            ...(squash ? { squash_commit_default: squash } : {}),
          })
        }

        const protection = () =>
          Effect.gen(function* () {
            const [classic, rules] = yield* Effect.all(
              [
                attempt(
                  api.json<ProtectionPayload>("GET", `${base}/branches/${GitHubShared.refPath(branch)}/protection`),
                ),
                attempt(api.json<RulePayload[]>("GET", `${base}/rules/branches/${GitHubShared.refPath(branch)}`)),
              ],
              { concurrency: "unbounded" },
            )
            const classicNote = classic.ok
              ? undefined
              : /not protected/i.test(classic.error.message)
                ? "branch not protected"
                : why(classic.error, "not configured or requires admin access")
            return {
              available: classic.ok || rules.ok,
              ...(classic.ok || rules.ok ? {} : { reason: classicNote }),
              branch: info.default_branch,
              ...(classic.ok ? { classic: protectionSummary(classic.data) } : { classic_note: classicNote }),
              ...(rules.ok
                ? { rules: rules.data.map(ruleSummary) }
                : { rules_note: why(rules.error, "not available", "requires read access") }),
            }
          })

        const rulesets = () =>
          attempt(
            api.json<
              ReadonlyArray<{ id: number; name: string; target?: string; enforcement: string; source?: string }>
            >("GET", `${base}/rulesets`, { query: { includes_parents: true, per_page: 100 } }),
          ).pipe(
            Effect.map((result) =>
              result.ok
                ? {
                    available: true,
                    rulesets: result.data.map((item) => ({
                      id: item.id,
                      name: item.name,
                      ...(item.target ? { target: item.target } : {}),
                      enforcement: item.enforcement,
                      ...(item.source ? { source: item.source } : {}),
                    })),
                  }
                : { available: false, reason: why(result.error, "rulesets not available", "requires read access") },
            ),
          )

        const security = () =>
          Effect.gen(function* () {
            const analysis = info.security_and_analysis
              ? Object.fromEntries(
                  Object.entries(info.security_and_analysis).flatMap(([key, value]) =>
                    value?.status ? [[key, value.status]] : [],
                  ),
                )
              : undefined
            const notes: string[] = []
            const setup = yield* attempt(
              api.json<{ state: string; languages?: ReadonlyArray<string>; query_suite?: string | null }>(
                "GET",
                `${base}/code-scanning/default-setup`,
              ),
            )
            if (!setup.ok)
              notes.push(
                `code scanning default setup: ${why(setup.error, "not available", "requires security_events access")}`,
              )
            // GitHub answers 404 both for "disabled" and for "no admin access"; only trust it when admin data is visible.
            const dependabot = analysis
              ? yield* api.request("GET", `${base}/vulnerability-alerts`, { allow: [404] }).pipe(
                  Effect.map((response) => response.status === 204),
                  Effect.option,
                  Effect.map(Option.getOrUndefined),
                )
              : undefined
            if (!analysis) notes.push("security_and_analysis and Dependabot alert settings require admin access")
            const available = analysis !== undefined || setup.ok
            return {
              available,
              ...(available ? {} : { reason: "requires admin access" }),
              ...(analysis ? { security_and_analysis: analysis } : {}),
              ...(setup.ok
                ? {
                    code_scanning_default_setup: {
                      state: setup.data.state,
                      languages: [...(setup.data.languages ?? [])],
                      ...(setup.data.query_suite ? { query_suite: setup.data.query_suite } : {}),
                    },
                  }
                : {}),
              ...(dependabot !== undefined ? { dependabot_alerts: dependabot } : {}),
              ...(notes.length ? { notes } : {}),
            }
          })

        const actions = () =>
          Effect.gen(function* () {
            const [permissions, workflow] = yield* Effect.all(
              [
                attempt(
                  api.json<{ enabled?: boolean; allowed_actions?: string }>("GET", `${base}/actions/permissions`),
                ),
                attempt(
                  api.json<{ default_workflow_permissions?: string; can_approve_pull_request_reviews?: boolean }>(
                    "GET",
                    `${base}/actions/permissions/workflow`,
                  ),
                ),
              ],
              { concurrency: "unbounded" },
            )
            const notes = [
              ...(permissions.ok ? [] : [`actions permissions: ${why(permissions.error, "not available")}`]),
              ...(workflow.ok ? [] : [`workflow permissions: ${why(workflow.error, "not available")}`]),
            ]
            const available = permissions.ok || workflow.ok
            return {
              available,
              ...(permissions.ok || available ? {} : { reason: why(permissions.error, "not available") }),
              ...(permissions.ok && permissions.data.enabled !== undefined
                ? { enabled: permissions.data.enabled }
                : {}),
              ...(permissions.ok && permissions.data.allowed_actions
                ? { allowed_actions: permissions.data.allowed_actions }
                : {}),
              ...(workflow.ok && workflow.data.default_workflow_permissions
                ? { default_workflow_permissions: workflow.data.default_workflow_permissions }
                : {}),
              ...(workflow.ok && workflow.data.can_approve_pull_request_reviews !== undefined
                ? { can_approve_pull_request_reviews: workflow.data.can_approve_pull_request_reviews }
                : {}),
              ...(available && notes.length ? { notes } : {}),
            }
          })

        const environments = () =>
          attempt(
            api.json<{
              environments?: ReadonlyArray<{
                name: string
                protection_rules?: ReadonlyArray<{ type: string }>
                deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null
              }>
            }>("GET", `${base}/environments`, { query: { per_page: 100 } }),
          ).pipe(
            Effect.map((result) =>
              result.ok
                ? {
                    available: true,
                    environments: (result.data.environments ?? []).map((environment) => ({
                      name: environment.name,
                      protections: (environment.protection_rules ?? []).map((rule) => rule.type),
                      ...(environment.deployment_branch_policy?.protected_branches
                        ? { deployment_branches: "protected branches" }
                        : environment.deployment_branch_policy?.custom_branch_policies
                          ? { deployment_branches: "custom" }
                          : {}),
                    })),
                  }
                : { available: false, reason: why(result.error, "not configured", "requires read access") },
            ),
          )

        const codeowners = () =>
          Effect.gen(function* () {
            for (const file of CODEOWNERS_PATHS) {
              const found = yield* attempt(
                api.json<{ content?: string; html_url?: string }>("GET", `${base}/contents/${file}`),
              )
              if (!found.ok && found.error.kind !== "not_found")
                return { available: false, reason: why(found.error, "not configured") }
              if (!found.ok || !found.data.content) continue
              const text = GitHubShared.decodeBase64(found.data.content).toString("utf8")
              const lines = text.split("\n")
              return {
                available: true,
                path: file,
                rules: lines.filter((line) => line.trim() && !line.trim().startsWith("#")).length,
                preview: GitHubShared.clip(lines.slice(0, 40).join("\n"), 3000),
                ...(found.data.html_url ? { url: found.data.html_url } : {}),
              }
            }
            return { available: false, reason: "not configured" }
          })

        const builders = { general, merging, protection, rulesets, security, actions, environments, codeowners }
        const built = yield* Effect.all(
          SECTIONS.filter((name) => wanted.has(name)).map((name) =>
            (builders[name]() as Effect.Effect<Record<string, unknown>>).pipe(
              Effect.map((value) => [name, value] as const),
            ),
          ),
          { concurrency: 4 },
        )
        return { repo: slug, url: info.html_url, ...Object.fromEntries(built) } as typeof RepoOutput.Type
      }),
  })

  const search = GitHubShared.define(deps, {
    name: "search",
    description: [
      "Search GitHub: code, commits, issues, prs, repos, users or discussions, with GitHub search syntax in query.",
      "Scope defaults to the current repository for code, commits, issues, prs and discussions (global otherwise); owner searches the repository owner's org or user. A repo:, org: or user: qualifier in query overrides scope.",
    ].join("\n"),
    input: Schema.Struct({
      type: Schema.Literals(SEARCH_TYPES),
      query: Schema.String.annotate({
        description: "GitHub search syntax, such as `retry language:go` or `is:open label:bug`.",
      }),
      scope: Opt(Schema.Literals(["repo", "owner", "global"])),
      repo: GitHubShared.RepoField,
      limit: GitHubShared.limit(100, 20),
    }),
    output: Schema.Struct({
      query: Schema.String.annotate({ description: "The query sent, with any scope qualifiers added." }),
      total: Schema.Int,
      incomplete: Opt(Schema.Boolean),
      items: Schema.Array(Schema.Union([CommitItem, IssueItem, DiscussionItem, CodeItem, RepoItem, UserItem])),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const { resolved, api } = yield* optionalTarget(deps, input.repo)
        const limit = input.limit ?? 20
        const scope = input.scope ?? (resolved && REPO_SCOPED.includes(input.type) ? "repo" : "global")
        if (scope !== "global" && !resolved)
          return yield* new GitHubClient.Error({
            kind: "validation",
            message: `scope ${scope} needs a repository.`,
            hint: "Pass `repo`, or use scope global.",
          })
        const qualifier =
          SCOPED.test(input.query) || !resolved || scope === "global"
            ? undefined
            : scope === "repo"
              ? `repo:${GitHubRepo.slug(resolved.repo)}`
              : `${yield* ownerKind(api, resolved.repo.owner)}:${resolved.repo.owner}`
        const kind =
          input.type === "issues" && !/(^|\s)(is|type):(issue|pr|pull-request)\b/i.test(input.query)
            ? "is:issue"
            : input.type === "prs" && !/(^|\s)(is|type):(pr|pull-request)\b/i.test(input.query)
              ? "is:pr"
              : undefined
        const query = [input.query.trim(), qualifier, kind].filter(Boolean).join(" ")

        if (input.type === "discussions") {
          const data = yield* api.graphql<{
            search: { discussionCount: number; nodes: ReadonlyArray<DiscussionNode | null> }
          }>(DISCUSSION_SEARCH, { query, first: limit })
          return {
            query,
            total: data.search.discussionCount,
            items: data.search.nodes.flatMap((node) =>
              node?.number === undefined
                ? []
                : [
                    {
                      repo: node.repository.nameWithOwner,
                      number: node.number,
                      title: node.title,
                      url: node.url,
                      answered: node.isAnswered === true,
                      updated_at: node.updatedAt,
                    },
                  ],
            ),
          }
        }

        const page = yield* api.json<SearchPage<unknown>>("GET", `/search/${REST_SEARCH[input.type]}`, {
          query: { q: query, per_page: limit },
          ...(input.type === "code" ? { accept: "application/vnd.github.text-match+json" } : {}),
        })
        const items = page.items.map((item) => {
          if (input.type === "code") {
            const hit = item as CodeHit
            const fragments = (hit.text_matches ?? []).map((match) => GitHubShared.clip(match.fragment, 500))
            return {
              repo: hit.repository.full_name,
              path: hit.path,
              url: hit.html_url,
              ...(fragments.length ? { fragments } : {}),
            }
          }
          if (input.type === "commits") {
            const hit = item as CommitHit
            return {
              repo: hit.repository.full_name,
              sha: hit.sha,
              message: firstLine(hit.commit.message),
              author: hit.author?.login ?? hit.commit.author?.name ?? "unknown",
              date: hit.commit.author?.date ?? "",
              url: hit.html_url,
            }
          }
          if (input.type === "issues" || input.type === "prs") {
            const hit = item as IssueHit
            return {
              repo: hit.repository_url.split("/").slice(-2).join("/"),
              number: hit.number,
              title: hit.title,
              state: hit.state,
              author: hit.user?.login ?? "ghost",
              url: hit.html_url,
              updated_at: hit.updated_at,
            }
          }
          if (input.type === "repos") {
            const hit = item as RepoHit
            return {
              full_name: hit.full_name,
              description: hit.description,
              stars: hit.stargazers_count,
              language: hit.language,
              pushed_at: hit.pushed_at,
              archived: hit.archived,
              url: hit.html_url,
            }
          }
          const hit = item as UserHit
          return { login: hit.login, type: hit.type, url: hit.html_url }
        })
        return { query, total: page.total_count, ...(page.incomplete_results ? { incomplete: true } : {}), items }
      }),
  })

  const commits = GitHubShared.define(deps, {
    name: "commits",
    description: [
      "List commits on a branch, tag or SHA, newest first, filtered by author, dates, path, message regex or merge commits.",
      "grep and merges filter client-side, scanning up to 2000 commits; scanned reports how many were read.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      ref: Opt(Schema.String).annotate({ description: "Branch, tag or SHA. Default the repository's default branch." }),
      author: Opt(Schema.String).annotate({ description: "Login or email." }),
      committer: Opt(Schema.String).annotate({ description: "Login or email." }),
      since: Opt(Schema.String).annotate({ description: "ISO 8601 timestamp." }),
      until: Opt(Schema.String).annotate({ description: "ISO 8601 timestamp." }),
      path: Opt(Schema.String).annotate({ description: "Only commits touching this file or directory." }),
      grep: Opt(Schema.String).annotate({
        description: "Case-insensitive regular expression matched against the commit message.",
      }),
      merges: Opt(Schema.Literals(["include", "only", "exclude"])).annotate({ description: "Default include." }),
      limit: GitHubShared.limit(500, 30),
    }),
    output: Schema.Struct({ commits: Schema.Array(CommitSummary), scanned: Schema.Int, more: Schema.Boolean }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const limit = input.limit ?? 30
        const pattern =
          input.grep === undefined
            ? undefined
            : yield* Effect.try({
                try: () => new RegExp(input.grep ?? "", "i"),
                catch: (error) =>
                  new GitHubClient.Error({ kind: "validation", message: `Invalid grep pattern: ${String(error)}` }),
              })
        const merges = input.merges ?? "include"
        const filtered = pattern !== undefined || merges !== "include"
        const keep = (commit: CommitPayload) =>
          (!pattern || pattern.test(commit.commit.message)) &&
          (merges === "include" || (merges === "only") === commit.parents.length > 1)
        const perPage = filtered ? 100 : Math.min(100, limit)
        const found: CommitPayload[] = []
        let scanned = 0
        let page = 1
        let more = true
        while (found.length < limit && more && page <= MAX_COMMIT_PAGES) {
          const batch = yield* resolved.api.json<CommitPayload[]>(
            "GET",
            `/repos/${GitHubRepo.slug(resolved.repo)}/commits`,
            {
              query: {
                sha: input.ref,
                author: input.author,
                committer: input.committer,
                since: input.since,
                until: input.until,
                path: input.path,
                per_page: perPage,
                page,
              },
            },
          )
          scanned += batch.length
          found.push(...batch.filter(keep))
          more = batch.length === perPage
          page += 1
        }
        return { commits: found.slice(0, limit).map(commitSummary), scanned, more: more || found.length > limit }
      }),
  })

  const compare = GitHubShared.define(deps, {
    name: "compare",
    description:
      "Compare two refs: ahead/behind counts, merge base, commits in head not in base, and optionally changed files.\nhead may be owner:branch for a fork.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      base: Schema.String,
      head: Schema.String,
      files: Opt(Schema.Boolean).annotate({ description: "Include changed files. Default false." }),
      limit: GitHubShared.limit(250, 100),
    }),
    output: Schema.Struct({
      status: Schema.String,
      ahead_by: Schema.Int,
      behind_by: Schema.Int,
      merge_base: Schema.String,
      url: Schema.String,
      total_commits: Schema.Int,
      commits: Schema.Array(CommitSummary).annotate({
        description: "Oldest first; the newest `limit` when there are more.",
      }),
      files: Opt(
        Schema.Array(
          Schema.Struct({ path: Schema.String, status: Schema.String, additions: Schema.Int, deletions: Schema.Int }),
        ),
      ),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const limit = input.limit ?? 100
        const data = yield* resolved.api.json<{
          status: string
          ahead_by: number
          behind_by: number
          total_commits: number
          html_url: string
          merge_base_commit: { sha: string }
          commits: ReadonlyArray<CommitPayload>
          files?: ReadonlyArray<{ filename: string; status: string; additions: number; deletions: number }>
        }>(
          "GET",
          `/repos/${GitHubRepo.slug(resolved.repo)}/compare/${encodeRef(input.base)}...${encodeRef(input.head)}`,
        )
        return {
          status: data.status,
          ahead_by: data.ahead_by,
          behind_by: data.behind_by,
          merge_base: data.merge_base_commit.sha,
          url: data.html_url,
          total_commits: data.total_commits,
          commits: data.commits.slice(-limit).map(commitSummary),
          ...(input.files
            ? {
                files: (data.files ?? []).map((file) => ({
                  path: file.filename,
                  status: file.status,
                  additions: file.additions,
                  deletions: file.deletions,
                })),
              }
            : {}),
        }
      }),
  })

  const repos = GitHubShared.define(deps, {
    name: "repos",
    description: [
      "List an org's or user's repositories (default: the current repository's owner), filtered by query, language or topic.",
      "Without a repository the owner defaults to you. contributor finds the owner's repositories a login committed to, with commit counts and the latest date.",
    ].join("\n"),
    input: Schema.Struct({
      owner: Opt(Schema.String),
      query: Opt(Schema.String).annotate({
        description: "Repository search syntax, such as `in:name api`. Ignored with contributor.",
      }),
      language: Opt(Schema.String),
      topic: Opt(Schema.String),
      archived: Opt(Schema.Boolean),
      sort: Opt(Schema.Literals(["updated", "pushed", "stars", "name"])).annotate({ description: "Default updated." }),
      limit: GitHubShared.limit(200, 30),
      contributor: Opt(Schema.String).annotate({
        description:
          "Login whose commits to look for: commit search (default branches) plus the login's contribution calendar for the last year. Counts are lower bounds.",
      }),
    }),
    output: Schema.Struct({
      owner: Schema.String,
      owner_type: Schema.Literals(["org", "user"]),
      repositories: Schema.Array(RepoSummary),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const local = input.owner === undefined ? yield* optionalTarget(deps) : undefined
        const api = local?.api ?? deps.client.forHost(defaultHost())
        const viewer = Effect.cached(api.json<{ login: string }>("GET", "/user").pipe(Effect.map((user) => user.login)))
        const loadViewer = yield* viewer
        const owner = input.owner ?? local?.resolved?.repo.owner ?? (yield* loadViewer)
        const kind = yield* ownerKind(api, owner)
        const limit = input.limit ?? 30
        const sort = input.sort ?? "updated"
        const sortLocal = <A extends { full_name: string; pushed_at?: string; stars: number }>(items: A[]) => {
          if (sort === "name") return items.toSorted((left, right) => left.full_name.localeCompare(right.full_name))
          if (sort === "pushed")
            return items.toSorted((left, right) => (right.pushed_at ?? "").localeCompare(left.pushed_at ?? ""))
          return items
        }
        const matches = (repo: RepoListing) =>
          (input.language === undefined || repo.language?.toLowerCase() === input.language.toLowerCase()) &&
          (input.topic === undefined || (repo.topics ?? []).includes(input.topic.toLowerCase())) &&
          (input.archived === undefined || (repo.archived === true) === input.archived)

        if (input.contributor !== undefined) {
          const hits = yield* api.paginate<ContributionHit>("/search/commits", {
            query: { q: `author:${input.contributor} ${kind}:${owner}`, sort: "author-date", order: "desc" },
            limit: 300,
            key: "items",
          })
          // Commit search returns newest first and caps results, so one busy repository can hide the rest. The
          // contribution calendar lists every repository the login committed to in the last year.
          const yearly = yield* api.graphql<YearlyContributions>(YEARLY_QUERY, { login: input.contributor }).pipe(
            Effect.map(yearlyRepositories),
            Effect.orElseSucceed(() => []),
          )
          const yearlyCounts = new Map(yearly.map((entry) => [entry.full_name.toLowerCase(), entry.count]))
          const searched = contributions(hits).map((entry) => ({
            ...entry,
            count: Math.max(entry.count, yearlyCounts.get(entry.repo.full_name.toLowerCase()) ?? 0),
          }))
          const known = new Set(searched.map((entry) => entry.repo.full_name.toLowerCase()))
          const grouped = [
            ...searched,
            ...yearly
              .filter(
                (entry) =>
                  entry.full_name.toLowerCase().startsWith(`${owner.toLowerCase()}/`) &&
                  !known.has(entry.full_name.toLowerCase()),
              )
              .map((entry) => ({
                // Placeholder until the detail request below fills in the real repository.
                repo: {
                  full_name: entry.full_name,
                  private: false,
                  fork: false,
                  html_url: `${api.web}/${entry.full_name}`,
                },
                count: entry.count,
                latest: entry.latest,
              })),
          ]
            .toSorted((left, right) => right.latest.localeCompare(left.latest))
            .slice(0, 100)
          const detailed = yield* Effect.all(
            grouped.map((entry) =>
              api.json<RepoListing>("GET", `/repos/${entry.repo.full_name}`).pipe(
                Effect.orElseSucceed(() => entry.repo),
                Effect.map((repo) => ({ repo, entry })),
              ),
            ),
            { concurrency: 8 },
          )
          const repositories = detailed
            .filter((item) => matches(item.repo))
            .map((item) => ({
              ...repoSummary(item.repo),
              commits_by_contributor: item.entry.count,
              ...(item.entry.latest ? { last_commit_by_contributor: item.entry.latest } : {}),
            }))
          const sorted =
            sort === "stars"
              ? repositories.toSorted((left, right) => right.stars - left.stars)
              : sortLocal(repositories)
          return { owner, owner_type: kind, repositories: sorted.slice(0, limit) }
        }

        const searching =
          input.query !== undefined ||
          input.language !== undefined ||
          input.topic !== undefined ||
          input.archived !== undefined ||
          sort === "stars"
        if (searching) {
          const query = input.query?.trim() ?? ""
          const q = [
            query,
            `${kind}:${owner}`,
            input.language === undefined ? undefined : `language:"${input.language}"`,
            input.topic === undefined ? undefined : `topic:${input.topic}`,
            input.archived === undefined ? undefined : `archived:${input.archived}`,
            // Repository search hides forks unless asked.
            /(^|\s)fork:/i.test(query) ? undefined : "fork:true",
          ]
            .filter(Boolean)
            .join(" ")
          const found = yield* api.paginate<RepoListing>("/search/repositories", {
            query: { q, ...(sort === "stars" || sort === "updated" ? { sort, order: "desc" } : {}) },
            limit,
            key: "items",
          })
          return { owner, owner_type: kind, repositories: sortLocal(found.map(repoSummary)) }
        }

        const listSort = sort === "name" ? "full_name" : sort
        const query = { sort: listSort, direction: sort === "name" ? "asc" : "desc" }
        const self =
          kind === "user"
            ? yield* loadViewer.pipe(
                Effect.map((login) => login.toLowerCase() === owner.toLowerCase()),
                Effect.orElseSucceed(() => false),
              )
            : false
        const listed = yield* api.paginate<RepoListing>(
          kind === "org" ? `/orgs/${owner}/repos` : self ? "/user/repos" : `/users/${owner}/repos`,
          {
            query:
              kind === "org"
                ? { ...query, type: "all" }
                : self
                  ? { ...query, affiliation: "owner", visibility: "all" }
                  : { ...query, type: "owner" },
            limit,
          },
        )
        return { owner, owner_type: kind, repositories: listed.map(repoSummary) }
      }),
  })

  const upload = GitHubShared.define(deps, {
    name: "upload",
    description: [
      "Upload a local image or video and get Markdown to embed in an issue, pull request or comment (like drag-and-drop).",
      "png, jpg, gif, webp, svg up to 10 MB; mp4, mov, webm up to 100 MB. Uploads are public to anyone with the link and cannot be deleted.",
    ].join("\n"),
    input: Schema.Struct({
      path: Schema.String.annotate({ description: "File path, absolute or relative to the working directory." }),
      repo: GitHubShared.RepoField,
      alt: Opt(Schema.String).annotate({ description: "Alt text for images. Default the file name." }),
    }),
    output: Schema.Struct({
      url: Schema.String,
      markdown: Schema.String.annotate({
        description: "Paste as-is; videos are a bare URL that must sit on its own line.",
      }),
      name: Schema.String,
      bytes: Schema.Int,
      content_type: Schema.String,
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        if (!api.uploads)
          return yield* new GitHubClient.Error({
            kind: "unsupported",
            message: `${api.host} does not support user attachment uploads.`,
            hint: "Attach the file to a release as an asset, or commit it to a branch and link to it.",
          })
        // Uploads publish the file, so reading it needs the same approval as the read tool.
        const file = yield* GitHubShared.readable(deps, context, input.path)
        const name = path.basename(file)
        const media = MEDIA[path.extname(file).toLowerCase()]
        if (!media)
          return yield* new GitHubClient.Error({
            kind: "validation",
            message: `Unsupported file type: ${name}. Supported: ${Object.keys(MEDIA).join(", ")}.`,
          })
        const size = yield* readLocal(file)
        const max = media.video ? VIDEO_MAX : IMAGE_MAX
        if (size > max)
          return yield* new GitHubClient.Error({
            kind: "validation",
            message: `${name} is ${size} bytes; ${media.video ? "videos" : "images"} may be at most ${max / 1024 / 1024} MB.`,
          })
        if (size === 0) return yield* new GitHubClient.Error({ kind: "validation", message: `${name} is empty.` })
        yield* GitHubShared.authorize(deps, context, "upload", resolved.repo, { path: file, bytes: size })
        const info = yield* api.json<{ id: number }>("GET", `/repos/${GitHubRepo.slug(resolved.repo)}`)
        const bytes = yield* readBytes(file, max, size)
        const params = new URLSearchParams({ name, content_type: media.type, repository_id: String(info.id) })
        const result = yield* api
          .upload({
            url: `${api.uploads}/user-attachments/assets?${params.toString()}`,
            bytes,
            contentType: "application/octet-stream",
            // The attachments endpoint answers 404 to the Bearer scheme.
            scheme: "token",
          })
          .pipe(
            Effect.catchIf(
              (error) => error.kind === "not_found",
              (error) =>
                Effect.fail(
                  new GitHubClient.Error({
                    kind: "not_found",
                    status: error.status,
                    message: error.message,
                    hint: `The upload endpoint rejects GitHub App installation tokens and accounts without write access to ${GitHubRepo.slug(resolved.repo)}. Fallback: \`gh issue comment <number> --attach ${file}\`.`,
                  }),
                ),
            ),
          )
        const url = typeof result === "object" && result !== null && "url" in result ? result.url : undefined
        if (typeof url !== "string")
          return yield* new GitHubClient.Error({
            kind: "server",
            message: "GitHub accepted the upload but returned no URL.",
          })
        const alt = (input.alt ?? name).replace(/[[\]]/g, "")
        return { url, markdown: media.video ? url : `![${alt}](${url})`, name, bytes: bytes.byteLength, content_type: media.type }
      }),
  })

  const api = GitHubShared.define(deps, {
    name: "api",
    description: [
      "Call any GitHub REST endpoint or GraphQL query the other tools do not cover.",
      "REST: method and path (relative, e.g. /repos/{owner}/{repo}/topics; {owner} and {repo} are filled from the repository). GraphQL: graphql and variables. Writes and mutations ask for permission.",
    ].join("\n"),
    input: Schema.Struct({
      method: Opt(Schema.Literals(["GET", "POST", "PATCH", "PUT", "DELETE"])).annotate({ description: "Default GET." }),
      path: Opt(Schema.String),
      query: Opt(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
      body: Opt(Schema.Unknown).annotate({ description: "JSON request body." }),
      graphql: Opt(Schema.String).annotate({ description: "GraphQL document. Mutually exclusive with path." }),
      variables: Opt(Schema.Record(Schema.String, Schema.Unknown)),
      paginate: Opt(Schema.Boolean).annotate({
        description: "GET only: follow Link headers and return the combined list.",
      }),
      limit: GitHubShared.limit(1000, 100),
      repo: GitHubShared.RepoField,
    }),
    output: Schema.Struct({
      status: Opt(Schema.Int),
      data: Schema.Unknown,
      items: Opt(Schema.Int).annotate({ description: "Number of items collected when paginating." }),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        if ((input.path === undefined) === (input.graphql === undefined))
          return yield* new GitHubClient.Error({ kind: "validation", message: "Pass exactly one of path or graphql." })
        const placeholders = input.path !== undefined && /\{(owner|repo)\}/.test(input.path)
        const { resolved, api } = placeholders
          ? yield* GitHubShared.target(deps, input.repo).pipe(
              Effect.map((resolved) => ({ resolved, api: resolved.api })),
            )
          : yield* optionalTarget(deps, input.repo)
        const writeTarget = (filled?: string) => {
          const match = filled ? /^\/?repos\/([^/]+)\/([^/?]+)/.exec(filled) : null
          if (match) return { host: api.host, owner: match[1], name: match[2] }
          return resolved?.repo ?? { host: api.host, owner: "*", name: "*" }
        }

        if (input.graphql !== undefined) {
          if (GitHubClient.isMutation(input.graphql))
            yield* GitHubShared.authorize(deps, context, "api", writeTarget(), {
              graphql: GitHubShared.clip(input.graphql, 500),
            })
          const data = yield* api.graphql<unknown>(input.graphql, input.variables ?? {})
          return { data }
        }

        const raw = input.path ?? ""
        // Absolute URLs would carry the token to whatever host they name.
        if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith("//"))
          return yield* new GitHubClient.Error({
            kind: "validation",
            message: "path must be relative to the API root, such as /repos/{owner}/{repo}.",
          })
        const filled = resolved
          ? raw.replaceAll("{owner}", resolved.repo.owner).replaceAll("{repo}", resolved.repo.name)
          : raw
        const target = filled.startsWith("/") ? filled : `/${filled}`
        const method = input.method ?? "GET"
        if (method !== "GET")
          yield* GitHubShared.authorize(deps, context, "api", writeTarget(target), { method, path: target })
        if (input.paginate && method === "GET") {
          const collected = yield* collect(api, target, input.query, input.limit ?? 100)
          return collected.items === undefined
            ? { data: collected.data }
            : { data: collected.data, items: collected.items }
        }
        const response = yield* api.request<unknown>(method, target, {
          ...(input.query ? { query: input.query } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
        })
        return { status: response.status, data: response.data ?? null }
      }),
  })

  return [repo, search, commits, compare, repos, upload, api]
}
