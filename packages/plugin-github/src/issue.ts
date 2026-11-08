export * as GitHubIssues from "./issue.js"

import type { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema } from "effect"
import { GitHubClient } from "./client.js"
import { GitHubCopilot } from "./copilot.js"
import { GitHubRepo } from "./repo.js"
import { GitHubShared } from "./shared.js"

type Deps = GitHubShared.Deps

const BODY_MAX = 8000
const COMMENT_MAX = 2000

const Author = GitHubShared.Author

const IssueRef = GitHubShared.NumberRef.annotate({ description: "Issue number, #number, owner/repo#number or URL." })

const StringList = Schema.Array(Schema.String)

interface GqlAuthor {
  readonly login: string
  readonly __typename?: string
}

const authorOf = (author: GqlAuthor | null | undefined) => ({
  login: author?.login ?? "ghost",
  kind: GitHubCopilot.authorKind(author?.login, author?.__typename),
})

const lower = (value: string | null | undefined) => (value ? value.toLowerCase() : undefined)

const quote = (value: string) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, "")}"` : value)

const defaultHost = () => process.env.GH_HOST || "github.com"

// ---------------------------------------------------------------------------------------------------------------
// Search query
// ---------------------------------------------------------------------------------------------------------------

export interface SearchInput {
  readonly state?: "open" | "closed" | "all"
  readonly author?: string
  readonly assignee?: string
  readonly mentions?: string
  readonly label?: string | ReadonlyArray<string>
  readonly milestone?: string
  readonly query?: string
  readonly sort?: "created" | "updated" | "comments"
}

const SCOPED = /(^|\s)-?(repo|org|user):/i

/** Builds a GitHub issue search string. The repository qualifier is skipped when the query already scopes itself. */
export function searchQuery(input: SearchInput, repo: string | undefined) {
  const labels = input.label === undefined ? [] : typeof input.label === "string" ? [input.label] : input.label
  const state = input.state ?? "open"
  return [
    "is:issue",
    ...(repo && !SCOPED.test(input.query ?? "") ? [`repo:${repo}`] : []),
    ...(state === "all" ? [] : [`is:${state}`]),
    ...(input.author ? [`author:${input.author}`] : []),
    ...(input.assignee ? [`assignee:${input.assignee}`] : []),
    ...(input.mentions ? [`mentions:${input.mentions}`] : []),
    ...labels.map((label) => `label:${quote(label)}`),
    ...(input.milestone ? [`milestone:${quote(input.milestone)}`] : []),
    `sort:${input.sort ?? "updated"}-desc`,
    ...(input.query?.trim() ? [input.query.trim()] : []),
  ].join(" ")
}

interface SearchIssue {
  readonly number?: number
  readonly title: string
  readonly url: string
  readonly state: string
  readonly stateReason: string | null
  readonly author: GqlAuthor | null
  readonly labels: { readonly nodes: ReadonlyArray<{ readonly name: string }> }
  readonly assignees: { readonly nodes: ReadonlyArray<{ readonly login: string }> }
  readonly comments: { readonly totalCount: number }
  readonly createdAt: string
  readonly updatedAt: string
  readonly repository: { readonly nameWithOwner: string }
}

const SEARCH_QUERY = `query($query: String!, $first: Int!) {
  search(type: ISSUE, query: $query, first: $first) {
    issueCount
    nodes {
      ... on Issue {
        number title url state stateReason createdAt updatedAt
        author { login __typename }
        labels(first: 20) { nodes { name } }
        assignees(first: 10) { nodes { login } }
        comments { totalCount }
        repository { nameWithOwner }
      }
    }
  }
}`

// ---------------------------------------------------------------------------------------------------------------
// One issue
// ---------------------------------------------------------------------------------------------------------------

interface PullNode {
  readonly __typename: string
  readonly number?: number
  readonly title?: string
  readonly url?: string
  readonly state?: string
  readonly repository?: { readonly nameWithOwner: string }
}

interface IssueData {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly state: string
  readonly stateReason: string | null
  readonly locked: boolean
  readonly author: GqlAuthor | null
  readonly labels: { readonly nodes: ReadonlyArray<{ readonly name: string }> }
  readonly assignees: { readonly nodes: ReadonlyArray<{ readonly login: string }> }
  readonly milestone: { readonly number: number; readonly title: string } | null
  readonly createdAt: string
  readonly closedAt: string | null
  readonly comments?: {
    readonly totalCount: number
    readonly nodes: ReadonlyArray<{
      readonly id: string
      readonly databaseId: number | null
      readonly author: GqlAuthor | null
      readonly body: string
      readonly createdAt: string
      readonly url: string
      readonly isMinimized: boolean
      readonly minimizedReason: string | null
    }>
  }
  readonly timelineItems: {
    readonly nodes: ReadonlyArray<{
      readonly __typename: string
      readonly willCloseTarget?: boolean
      readonly source?: PullNode | null
      readonly subject?: PullNode | null
    } | null>
  }
}

const PULL_FIELDS = `__typename ... on PullRequest { number title url state repository { nameWithOwner } }`

const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $comments: Boolean!, $commentLimit: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number title body url state stateReason locked createdAt closedAt
      author { login __typename }
      labels(first: 50) { nodes { name } }
      assignees(first: 20) { nodes { login } }
      milestone { number title }
      comments(last: $commentLimit) @include(if: $comments) {
        totalCount
        nodes { id databaseId body createdAt url isMinimized minimizedReason author { login __typename } }
      }
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 20) {
        nodes {
          __typename
          ... on CrossReferencedEvent { willCloseTarget source { ${PULL_FIELDS} } }
          ... on ConnectedEvent { subject { ${PULL_FIELDS} } }
        }
      }
    }
  }
}`

function linkedPulls(data: IssueData) {
  const seen = new Set<string>()
  return data.timelineItems.nodes.flatMap((node) => {
    const pull = node?.source ?? node?.subject
    if (!pull || pull.__typename !== "PullRequest" || !pull.url || pull.number === undefined) return []
    if (seen.has(pull.url)) return []
    seen.add(pull.url)
    return [
      {
        repo: pull.repository?.nameWithOwner ?? "",
        number: pull.number,
        title: pull.title ?? "",
        url: pull.url,
        state: lower(pull.state) ?? "open",
        ...(node?.willCloseTarget ? { closes: true } : {}),
      },
    ]
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------------------------

const DISCUSSION_ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { discussion(number: $number) { id } }
}`

// Node IDs are global, so a comment's own repository decides which repository the change is authorized against.
const NODE_TYPE_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on IssueComment { url repository { nameWithOwner } }
    ... on DiscussionComment { url discussion { repository { nameWithOwner } } }
    ... on PullRequestReviewComment { url repository { nameWithOwner } }
  }
}`

interface CommentNode {
  readonly __typename: string
  readonly url?: string
  readonly repository?: { readonly nameWithOwner: string }
  readonly discussion?: { readonly repository: { readonly nameWithOwner: string } }
}

/** Looks up a comment by node ID and the repository it belongs to. */
const commentNode = Effect.fn("GitHubIssues.commentNode")(function* (api: GitHubClient.Api, id: string, host: string) {
  const node = (yield* api.graphql<{ node: CommentNode | null }>(NODE_TYPE_QUERY, { id })).node
  if (!node) return yield* new GitHubClient.Error({ kind: "not_found", message: `No comment ${id}` })
  const owner = node.repository?.nameWithOwner ?? node.discussion?.repository.nameWithOwner
  const repo = owner ? GitHubRepo.parse(owner, host) : undefined
  if (!repo)
    return yield* new GitHubClient.Error({
      kind: "validation",
      message: `${id} is a ${node.__typename}, not a comment this tool can change.`,
    })
  return { node, repo }
})

// Aliased to `result { comment { url } }` so every edit mutation reads the same way.
const EDIT_MUTATIONS: Record<string, string> = {
  IssueComment: `mutation($id: ID!, $body: String!) { result: updateIssueComment(input: { id: $id, body: $body }) { comment: issueComment { url } } }`,
  DiscussionComment: `mutation($id: ID!, $body: String!) { result: updateDiscussionComment(input: { commentId: $id, body: $body }) { comment { url } } }`,
  PullRequestReviewComment: `mutation($id: ID!, $body: String!) { result: updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) { comment: pullRequestReviewComment { url } } }`,
}

const DELETE_MUTATIONS: Record<string, string> = {
  IssueComment: `mutation($id: ID!) { deleteIssueComment(input: { id: $id }) { clientMutationId } }`,
  DiscussionComment: `mutation($id: ID!) { deleteDiscussionComment(input: { id: $id }) { clientMutationId } }`,
  PullRequestReviewComment: `mutation($id: ID!) { deletePullRequestReviewComment(input: { id: $id }) { clientMutationId } }`,
}

const MINIMIZE = `mutation($id: ID!, $classifier: ReportedContentClassifiers!) { minimizeComment(input: { subjectId: $id, classifier: $classifier }) { minimizedComment { isMinimized } } }`
const UNMINIMIZE = `mutation($id: ID!) { unminimizeComment(input: { subjectId: $id }) { unminimizedComment { isMinimized } } }`

// ---------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------

const IssueSummary = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  state_reason: Schema.optionalKey(Schema.String),
  author: Author,
  labels: StringList,
  assignees: StringList,
  comments: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
})

const Comment = Schema.Struct({
  id: Schema.String.annotate({ description: "Node id; pass to comment_update." }),
  database_id: Schema.optionalKey(Schema.Int),
  author: Author,
  body: Schema.String,
  created_at: Schema.String,
  url: Schema.String,
  hidden: Schema.optionalKey(Schema.String).annotate({ description: "Why the comment is minimized, when it is." }),
})

const LinkedPull = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  closes: Schema.optionalKey(Schema.Boolean),
})

export function tools(deps: Deps): Tool.Info[] {
  const issues = GitHubShared.define(deps, {
    name: "issues",
    description: [
      "List or search issues in a repository (pull requests excluded), most recently updated first.",
      "query takes extra GitHub search qualifiers or free text; a repo:, org: or user: qualifier in it replaces the default repository scope.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      state: Schema.optionalKey(Schema.Literals(["open", "closed", "all"])).annotate({ description: "Default open." }),
      author: Schema.optionalKey(Schema.String),
      assignee: Schema.optionalKey(Schema.String).annotate({ description: "Login, @me, or none." }),
      mentions: Schema.optionalKey(Schema.String),
      label: Schema.optionalKey(Schema.Union([Schema.String, StringList])).annotate({
        description: "One label or several; all must match.",
      }),
      milestone: Schema.optionalKey(Schema.String).annotate({ description: "Milestone title." }),
      query: Schema.optionalKey(Schema.String),
      sort: Schema.optionalKey(Schema.Literals(["created", "updated", "comments"])).annotate({
        description: "Default updated.",
      }),
      limit: GitHubShared.limit(100, 30),
    }),
    output: Schema.Struct({ total: Schema.Int, query: Schema.String, items: Schema.Array(IssueSummary) }),
    execute: (input) =>
      Effect.gen(function* () {
        const scoped = SCOPED.test(input.query ?? "")
        const resolved =
          scoped && input.repo === undefined
            ? Option.getOrUndefined(yield* GitHubShared.target(deps, input.repo).pipe(Effect.option))
            : yield* GitHubShared.target(deps, input.repo)
        const api = resolved?.api ?? deps.client.forHost(defaultHost())
        const query = searchQuery(input, resolved ? GitHubRepo.slug(resolved.repo) : undefined)
        const data = yield* api.graphql<{ search: { issueCount: number; nodes: ReadonlyArray<SearchIssue | null> } }>(
          SEARCH_QUERY,
          {
            query,
            first: input.limit ?? 30,
          },
        )
        return {
          total: data.search.issueCount,
          query,
          items: data.search.nodes.flatMap((node) =>
            node?.number === undefined
              ? []
              : [
                  {
                    repo: node.repository.nameWithOwner,
                    number: node.number,
                    title: node.title,
                    url: node.url,
                    state: node.state.toLowerCase(),
                    ...(node.stateReason ? { state_reason: node.stateReason.toLowerCase() } : {}),
                    author: authorOf(node.author),
                    labels: node.labels.nodes.map((label) => label.name),
                    assignees: node.assignees.nodes.map((user) => user.login),
                    comments: node.comments.totalCount,
                    created_at: node.createdAt,
                    updated_at: node.updatedAt,
                  },
                ],
          ),
        }
      }),
  })

  const issue = GitHubShared.define(deps, {
    name: "issue",
    description:
      "Read one issue with its body, labels, linked pull requests and most recent comments (comment ids feed comment_update).",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      issue: IssueRef,
      comments: Schema.optionalKey(Schema.Boolean).annotate({ description: "Include comments. Default true." }),
      comment_limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))).annotate({
        description: "Most recent comments to include. Default 50, maximum 100.",
      }),
    }),
    output: Schema.Struct({
      repo: Schema.String,
      number: Schema.Int,
      title: Schema.String,
      url: Schema.String,
      state: Schema.String,
      state_reason: Schema.optionalKey(Schema.String),
      locked: Schema.Boolean,
      author: Author,
      body: Schema.String,
      labels: StringList,
      assignees: StringList,
      milestone: Schema.optionalKey(Schema.Struct({ number: Schema.Int, title: Schema.String })),
      created_at: Schema.String,
      closed_at: Schema.optionalKey(Schema.String),
      linked_pull_requests: Schema.Array(LinkedPull),
      comments_total: Schema.optionalKey(Schema.Int),
      comments: Schema.optionalKey(Schema.Array(Comment)),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.numbered(deps, { repo: input.repo, ref: input.issue })
        const slug = GitHubRepo.slug(resolved.repo)
        const data = yield* resolved.api.graphql<{ repository: { issue: IssueData | null } | null }>(ISSUE_QUERY, {
          owner: resolved.repo.owner,
          name: resolved.repo.name,
          number: resolved.number,
          comments: input.comments !== false,
          commentLimit: input.comment_limit ?? 50,
        })
        const found = data.repository?.issue
        if (!found)
          return yield* new GitHubClient.Error({
            kind: "not_found",
            message: `Issue ${slug}#${resolved.number} not found`,
            hint: "If it is a pull request, use the pull request tools.",
          })
        return {
          repo: slug,
          number: found.number,
          title: found.title,
          url: found.url,
          state: found.state.toLowerCase(),
          ...(found.stateReason ? { state_reason: found.stateReason.toLowerCase() } : {}),
          locked: found.locked,
          author: authorOf(found.author),
          body: GitHubShared.clip(GitHubCopilot.plain(found.body), BODY_MAX),
          labels: found.labels.nodes.map((label) => label.name),
          assignees: found.assignees.nodes.map((user) => user.login),
          ...(found.milestone ? { milestone: { number: found.milestone.number, title: found.milestone.title } } : {}),
          created_at: found.createdAt,
          ...(found.closedAt ? { closed_at: found.closedAt } : {}),
          linked_pull_requests: linkedPulls(found),
          ...(found.comments
            ? {
                comments_total: found.comments.totalCount,
                comments: found.comments.nodes.map((comment) => ({
                  id: comment.id,
                  ...(comment.databaseId !== null ? { database_id: comment.databaseId } : {}),
                  author: authorOf(comment.author),
                  body: GitHubShared.clip(GitHubCopilot.plain(comment.body), COMMENT_MAX),
                  created_at: comment.createdAt,
                  url: comment.url,
                  ...(comment.isMinimized ? { hidden: lower(comment.minimizedReason) ?? "hidden" } : {}),
                })),
              }
            : {}),
        }
      }),
  })

  const issueCreate = GitHubShared.define(deps, {
    name: "issue_create",
    description: "Open a new issue.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      title: Schema.String,
      body: Schema.optionalKey(Schema.String),
      labels: Schema.optionalKey(StringList),
      assignees: Schema.optionalKey(StringList),
      milestone: Schema.optionalKey(Schema.Int).annotate({ description: "Milestone number." }),
    }),
    output: Schema.Struct({ number: Schema.Int, url: Schema.String }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        yield* GitHubShared.authorize(deps, context, "issue_create", resolved.repo)
        const created = yield* resolved.api.json<{ number: number; html_url: string }>(
          "POST",
          `/repos/${GitHubRepo.slug(resolved.repo)}/issues`,
          {
            body: {
              title: input.title,
              ...(input.body !== undefined ? { body: input.body } : {}),
              ...(input.labels?.length ? { labels: input.labels } : {}),
              ...(input.assignees?.length ? { assignees: input.assignees } : {}),
              ...(input.milestone !== undefined ? { milestone: input.milestone } : {}),
            },
          },
        )
        return { number: created.number, url: created.html_url }
      }),
  })

  const issueUpdate = GitHubShared.define(deps, {
    name: "issue_update",
    description: [
      "Edit an issue: title, body, open/close with a reason, labels, assignees, milestone, lock.",
      "Labels and assignees are added or removed individually; existing ones are kept.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      issue: IssueRef,
      title: Schema.optionalKey(Schema.String),
      body: Schema.optionalKey(Schema.String),
      state: Schema.optionalKey(Schema.Literals(["open", "closed"])),
      state_reason: Schema.optionalKey(Schema.Literals(["completed", "not_planned", "duplicate", "reopened"])),
      add_labels: Schema.optionalKey(StringList),
      remove_labels: Schema.optionalKey(StringList),
      add_assignees: Schema.optionalKey(StringList),
      remove_assignees: Schema.optionalKey(StringList),
      milestone: Schema.optionalKey(Schema.NullOr(Schema.Int)).annotate({
        description: "Milestone number, or null to clear.",
      }),
      lock: Schema.optionalKey(Schema.Boolean),
    }),
    output: Schema.Struct({ number: Schema.Int, url: Schema.String, state: Schema.String, changed: StringList }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.numbered(deps, { repo: input.repo, ref: input.issue })
        const api = resolved.api
        const path = `/repos/${GitHubRepo.slug(resolved.repo)}/issues/${resolved.number}`
        const patch = {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.state !== undefined ? { state: input.state } : {}),
          ...(input.state_reason !== undefined ? { state_reason: input.state_reason } : {}),
          ...(input.milestone !== undefined ? { milestone: input.milestone } : {}),
        }
        const addLabels = input.add_labels ?? []
        const removeLabels = input.remove_labels ?? []
        const addAssignees = input.add_assignees ?? []
        const removeAssignees = input.remove_assignees ?? []
        const patching = Object.keys(patch).length > 0
        if (
          !patching &&
          !addLabels.length &&
          !removeLabels.length &&
          !addAssignees.length &&
          !removeAssignees.length &&
          input.lock === undefined
        )
          return yield* new GitHubClient.Error({ kind: "validation", message: "Nothing to change." })
        yield* GitHubShared.authorize(deps, context, "issue_update", resolved.repo)

        const changed: string[] = []
        const patched = patching
          ? yield* api.json<{ html_url: string; state: string }>("PATCH", path, { body: patch })
          : undefined
        if (input.title !== undefined) changed.push("title")
        if (input.body !== undefined) changed.push("body")
        if (input.state !== undefined || input.state_reason !== undefined)
          changed.push(`state: ${patched?.state ?? input.state}${input.state_reason ? ` (${input.state_reason})` : ""}`)
        if (input.milestone !== undefined)
          changed.push(input.milestone === null ? "milestone cleared" : `milestone: ${input.milestone}`)
        if (addLabels.length) {
          yield* api.json("POST", `${path}/labels`, { body: { labels: addLabels } })
          changed.push(`added labels: ${addLabels.join(", ")}`)
        }
        for (const label of removeLabels)
          yield* api.request("DELETE", `${path}/labels/${encodeURIComponent(label)}`, { allow: [404] })
        if (removeLabels.length) changed.push(`removed labels: ${removeLabels.join(", ")}`)
        if (addAssignees.length) {
          yield* api.json("POST", `${path}/assignees`, { body: { assignees: addAssignees } })
          changed.push(`added assignees: ${addAssignees.join(", ")}`)
        }
        if (removeAssignees.length) {
          yield* api.json("DELETE", `${path}/assignees`, { body: { assignees: removeAssignees } })
          changed.push(`removed assignees: ${removeAssignees.join(", ")}`)
        }
        if (input.lock !== undefined) {
          yield* api.request(input.lock ? "PUT" : "DELETE", `${path}/lock`)
          changed.push(input.lock ? "locked" : "unlocked")
        }
        const final = patched ?? (yield* api.json<{ html_url: string; state: string }>("GET", path))
        return { number: resolved.number, url: final.html_url, state: final.state, changed }
      }),
  })

  const comment = GitHubShared.define(deps, {
    name: "comment",
    description: [
      "Post a comment on an issue or pull request (on), or on a discussion (discussion, optionally reply_to a discussion comment).",
      "For pull request review threads use respond instead.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      on: Schema.optionalKey(GitHubShared.NumberRef).annotate({
        description: "Issue or pull request number, #number, owner/repo#number or URL.",
      }),
      discussion: Schema.optionalKey(GitHubShared.NumberRef).annotate({ description: "Discussion number or URL." }),
      reply_to: Schema.optionalKey(Schema.String).annotate({
        description: "Discussion comment node id (DC_...) to reply under. Discussion replies are one level deep.",
      }),
      body: Schema.String,
    }),
    output: Schema.Struct({ id: Schema.String, url: Schema.String }),
    execute: (input, context) =>
      Effect.gen(function* () {
        if ((input.on === undefined) === (input.discussion === undefined))
          return yield* new GitHubClient.Error({ kind: "validation", message: "Pass exactly one of on or discussion." })
        if (input.discussion === undefined && input.reply_to !== undefined)
          return yield* new GitHubClient.Error({
            kind: "validation",
            message: "reply_to only applies to discussion comments.",
          })
        if (input.on !== undefined) {
          const resolved = yield* GitHubShared.numbered(deps, { repo: input.repo, ref: input.on })
          yield* GitHubShared.authorize(deps, context, "comment", resolved.repo)
          const posted = yield* resolved.api.json<{ node_id: string; html_url: string }>(
            "POST",
            `/repos/${GitHubRepo.slug(resolved.repo)}/issues/${resolved.number}/comments`,
            { body: { body: input.body } },
          )
          return { id: posted.node_id, url: posted.html_url }
        }
        const resolved = yield* GitHubShared.numbered(deps, { repo: input.repo, ref: input.discussion ?? 0 })
        const found = yield* resolved.api.graphql<{ repository: { discussion: { id: string } | null } | null }>(
          DISCUSSION_ID_QUERY,
          {
            owner: resolved.repo.owner,
            name: resolved.repo.name,
            number: resolved.number,
          },
        )
        const discussionId = found.repository?.discussion?.id
        if (!discussionId)
          return yield* new GitHubClient.Error({
            kind: "not_found",
            message: `Discussion ${GitHubRepo.slug(resolved.repo)}#${resolved.number} not found`,
          })
        yield* GitHubShared.authorize(deps, context, "comment", resolved.repo)
        const posted = yield* resolved.api.graphql<{ addDiscussionComment: { comment: { id: string; url: string } } }>(
          `mutation($discussionId: ID!, $body: String!, $replyToId: ID) { addDiscussionComment(input: { discussionId: $discussionId, body: $body, replyToId: $replyToId }) { comment { id url } } }`,
          { discussionId, body: input.body, ...(input.reply_to !== undefined ? { replyToId: input.reply_to } : {}) },
        )
        return { id: posted.addDiscussionComment.comment.id, url: posted.addDiscussionComment.comment.url }
      }),
  })

  const commentUpdate = GitHubShared.define(deps, {
    name: "comment_update",
    description: [
      "Edit, delete, hide (minimize) or unhide a comment on an issue, pull request, review thread or discussion.",
      "id is a node id (IC_..., DC_..., PRRC_...) or a numeric REST issue-comment id. Pass exactly one of body, delete, hide, unhide.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      id: Schema.String,
      body: Schema.optionalKey(Schema.String).annotate({ description: "Replace the comment text." }),
      delete: Schema.optionalKey(Schema.Boolean),
      hide: Schema.optionalKey(Schema.Literals(["resolved", "outdated", "duplicate", "off_topic", "spam", "abuse"])),
      unhide: Schema.optionalKey(Schema.Boolean),
    }),
    output: Schema.Struct({
      id: Schema.String,
      action: Schema.Literals(["edited", "deleted", "hidden", "unhidden"]),
      url: Schema.optionalKey(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const actions = [
          input.body !== undefined,
          input.delete === true,
          input.hide !== undefined,
          input.unhide === true,
        ].filter(Boolean)
        if (actions.length !== 1)
          return yield* new GitHubClient.Error({
            kind: "validation",
            message: "Pass exactly one of body, delete, hide or unhide.",
          })
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const numeric = /^\d+$/.test(input.id)
        const restPath = `/repos/${GitHubRepo.slug(resolved.repo)}/issues/comments/${input.id}`

        if (input.hide !== undefined || input.unhide === true) {
          const nodeId = numeric ? (yield* api.json<{ node_id: string }>("GET", restPath)).node_id : input.id
          const owner = numeric ? resolved.repo : (yield* commentNode(api, nodeId, resolved.repo.host)).repo
          yield* GitHubShared.authorize(deps, context, "comment_update", owner)
          if (input.hide !== undefined)
            yield* api.graphql(MINIMIZE, { id: nodeId, classifier: input.hide.toUpperCase() })
          if (input.hide === undefined) yield* api.graphql(UNMINIMIZE, { id: nodeId })
          return { id: nodeId, action: input.hide !== undefined ? ("hidden" as const) : ("unhidden" as const) }
        }

        if (numeric) {
          yield* GitHubShared.authorize(deps, context, "comment_update", resolved.repo)
          if (input.delete) {
            yield* api.request("DELETE", restPath)
            return { id: input.id, action: "deleted" as const }
          }
          const edited = yield* api.json<{ node_id: string; html_url: string }>("PATCH", restPath, {
            body: { body: input.body },
          })
          return { id: edited.node_id, action: "edited" as const, url: edited.html_url }
        }

        const found = yield* commentNode(api, input.id, resolved.repo.host)
        const node = found.node
        const edit = Object.hasOwn(EDIT_MUTATIONS, node.__typename) ? EDIT_MUTATIONS[node.__typename] : undefined
        const remove = Object.hasOwn(DELETE_MUTATIONS, node.__typename) ? DELETE_MUTATIONS[node.__typename] : undefined
        if (!edit || !remove)
          return yield* new GitHubClient.Error({
            kind: "validation",
            message: `${input.id} is a ${node.__typename}, not a comment this tool can change.`,
          })
        yield* GitHubShared.authorize(deps, context, "comment_update", found.repo)
        if (input.delete) {
          yield* api.graphql(remove, { id: input.id })
          return { id: input.id, action: "deleted" as const }
        }
        const data = yield* api.graphql<{ result: { comment: { url: string } | null } | null }>(edit, {
          id: input.id,
          body: input.body,
        })
        const url = data.result?.comment?.url ?? node.url
        return { id: input.id, action: "edited" as const, ...(url ? { url } : {}) }
      }),
  })

  return [issues, issue, issueCreate, issueUpdate, comment, commentUpdate]
}
