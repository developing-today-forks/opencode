export * as MessagingTools from "./messaging.js"

import { SystemPart, ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Ref, Schema, Stream } from "effect"
import type { ConfigMessaging } from "@opencode/schema/config/messaging"
import { Config, reloadsSections } from "../../config.js"
import { Messaging } from "../../messaging.js"
import { MessagingEmbedding } from "../../messaging/embedding.js"
import { MessagingTemplate } from "../../messaging/template.js"
import { MessagingVars } from "../../messaging/vars.js"
import { Model } from "../../model.js"
import { SessionSchema } from "../../session/schema.js"

const TOPIC =
  "Topic: a preset (private, readonly, readwrite, tasks, family, children, tree, root, user, global, roots, workdir, project, git, dm@<session>, child_link@<child>, parent_link), preset@<session> for another session's, a {var} template, or any raw name (=name forces raw). topics({ mode: 'presets' }) lists presets and variables."
const SESSIONS =
  "Session-set expressions: a session ID, self, parent, root or user, optionally suffixed +children, +descendants, +ancestors or +parent."

const Strings = Schema.Union([Schema.String, Schema.Array(Schema.String)])
const Count = Schema.Int.check(Schema.isGreaterThan(0))
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Seqs = Schema.Union([Count, Schema.Array(Count)])
const Order = Schema.Literals(["asc", "desc"])
const Match = Schema.Literals(["exact", "regex", "fuzzy", "semantic", "hybrid", "advanced"])

export const MsgInput = Schema.Struct({
  mode: Schema.optionalKey(
    Schema.Literals(["send", "user", "read", "unread", "search", "inspect", "hide", "restore", "model"]),
  ).annotate({
    description:
      "send (default with text), user (message the user), read (default), unread (new messages for you; wait blocks for one), search (default with query), inspect (a message and its delete/restore history), hide, restore, model (semantic search model status)",
  }),
  topic: Schema.optionalKey(Strings).annotate({ description: TOPIC }),
  to: Schema.optionalKey(Schema.String).annotate({
    description: "Session to message directly (session ID, parent or root), or user",
  }),
  text: Schema.optionalKey(Schema.String).annotate({ description: "Message body" }),
  query: Schema.optionalKey(Schema.String).annotate({ description: "Search text; matches meaning, not only words" }),
  match: Schema.optionalKey(Match).annotate({ description: "Search mode (default hybrid: fuzzy + semantic)" }),
  type: Schema.optionalKey(Schema.String).annotate({
    description: "Your label for the message (default message); filters reads",
  }),
  seq: Schema.optionalKey(Seqs).annotate({
    description: "Message number(s): to inspect, hide or restore, or the message a send replies to",
  }),
  from: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: `Writers to include. ${SESSIONS}` }),
  since: Schema.optionalKey(Schema.String).annotate({ description: "ISO time or age such as 30m, 2h, 3d" }),
  until: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.Int).annotate({ description: "Only message numbers above this" }),
  before: Schema.optionalKey(Schema.Int).annotate({ description: "Only message numbers below this" }),
  kinds: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "System kinds to read: message, delete, restore, settings",
  }),
  hidden: Schema.optionalKey(Schema.Literals(["exclude", "include", "only"])).annotate({
    description: "Hidden (deleted) messages: excluded by default; include or only them",
  }),
  hiddenBy: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Only re-include messages hidden by these sessions",
  }),
  hiddenFrom: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Only re-include hidden messages written by these sessions",
  }),
  hiddenSince: Schema.optionalKey(Schema.String),
  hiddenUntil: Schema.optionalKey(Schema.String),
  for: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: `hide/restore: viewers affected (default you; * for everyone). ${SESSIONS} Without seq, sets the topic default.`,
  }),
  reason: Schema.optionalKey(Schema.String),
  deliver: Schema.optionalKey(Schema.Literals(["none", "inbox", "wake"])).annotate({
    description:
      "How recipients get it: none (they read it later), inbox (queued into their conversation), wake (queued and run). Default: their subscription, wake for direct messages",
  }),
  root: Schema.optionalKey(Schema.Literals(["hidden", "visible", "wake"])).annotate({
    description: "user mode: whether your root session sees the message too (default visible)",
  }),
  force: Schema.optionalKey(Schema.Boolean).annotate({ description: "Write past a topic's soft write limit" }),
  limit: Schema.optionalKey(Count),
  order: Schema.optionalKey(Order),
  wait: Schema.optionalKey(Schema.Int).annotate({ description: "unread: seconds to wait for the first new message" }),
  tier: Schema.optionalKey(Schema.String).annotate({
    description: "model: switch the local model (tiny, default, step-up, top, off) and start it",
  }),
})

export const TopicsInput = Schema.Struct({
  mode: Schema.optionalKey(
    Schema.Literals(["list", "info", "settings", "subscribe", "unsubscribe", "presets", "set_var"]),
  ).annotate({
    description:
      "list (default), info, settings (write mode, writers, description), subscribe/unsubscribe (get new messages delivered), presets (every preset and variable), set_var",
  }),
  topic: Schema.optionalKey(Strings).annotate({ description: TOPIC }),
  sessions: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: `list: topics these sessions read or wrote. ${SESSIONS}`,
  }),
  role: Schema.optionalKey(Schema.Literals(["any", "reader", "writer", "subscriber"])),
  kinds: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Topic kinds: private, readonly, readwrite, tasks, family, root, user, global, roots, workdir, project, git, dm, custom",
  }),
  search: Schema.optionalKey(Schema.String).annotate({ description: "Text the topic name contains" }),
  standard: Schema.optionalKey(Schema.Boolean).annotate({
    description: "list: include your standard topics even before first use (default true without filters)",
  }),
  sort: Schema.optionalKey(Schema.Literals(["created", "last"])).annotate({
    description: "created or last message (default last)",
  }),
  order: Schema.optionalKey(Order),
  limit: Schema.optionalKey(Count),
  offset: Schema.optionalKey(Offset),
  expand: Schema.optionalKey(Schema.Int).annotate({
    description: "Show the first and latest N writers, readers and allowed writers",
  }),
  write: Schema.optionalKey(Schema.Literals(["open", "readonly", "limited"])).annotate({
    description: "settings: open, readonly (owner and ancestors write), or limited to writers",
  }),
  writers: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "settings: allowed writers such as ses_x, ses_x+children, ses_x+ancestors",
  }),
  description: Schema.optionalKey(Schema.String),
  deliver: Schema.optionalKey(Schema.Literals(["none", "inbox", "wake"])).annotate({
    description: "subscribe: none (unread only), inbox (queue into your conversation, default), wake (queue and run)",
  }),
  values: Schema.optionalKey(Schema.Boolean).annotate({ description: "presets: include current values" }),
  render: Schema.optionalKey(Schema.String).annotate({ description: "presets: render this template" }),
  name: Schema.optionalKey(Schema.String).annotate({ description: "set_var: variable name" }),
  value: Schema.optionalKey(Schema.String).annotate({ description: "set_var: value or template; omit to remove" }),
  scope: Schema.optionalKey(Schema.String).annotate({
    description: "set_var: self (default, inherited by your subsessions), a session ID, or global",
  }),
})

export const SessionsInput = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literals(["chain", "list", "log"])).annotate({
    description: "chain (default: you and your parent), list (all sessions), log (read or search a session's log)",
  }),
  session: Schema.optionalKey(Strings).annotate({ description: `Subject session(s), default self. ${SESSIONS}` }),
  depth: Schema.optionalKey(Schema.Literals(["self", "parent", "all"])).annotate({
    description: "chain: self, parent (default), or all ancestors up to the root",
  }),
  detail: Schema.optionalKey(Schema.Literals(["brief", "full"])),
  expand: Schema.optionalKey(Schema.Int).annotate({ description: "Show the first and latest N children" }),
  parent: Schema.optionalKey(Schema.String).annotate({
    description: "list: children of this session, or none for roots",
  }),
  ancestor: Schema.optionalKey(Schema.String).annotate({ description: "list: all descendants of this session" }),
  project: Schema.optionalKey(Schema.String),
  directory: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  search: Schema.optionalKey(Schema.String).annotate({ description: "list: text the title contains" }),
  active: Schema.optionalKey(Schema.Boolean).annotate({ description: "list: only running (true) or idle (false)" }),
  since: Schema.optionalKey(Schema.String),
  until: Schema.optionalKey(Schema.String),
  sort: Schema.optionalKey(Schema.Literals(["created", "updated"])),
  order: Schema.optionalKey(Order),
  limit: Schema.optionalKey(Count),
  offset: Schema.optionalKey(Offset),
  op: Schema.optionalKey(Schema.Literals(["head", "tail", "grep", "search", "pull"])).annotate({
    description:
      "log: tail (default), head, grep (regex with context), search (ranked, default with query), pull (full text)",
  }),
  include: Schema.optionalKey(
    Schema.Array(
      Schema.Literals([
        "user",
        "output",
        "thinking",
        "tools",
        "results",
        "system",
        "synthetic",
        "shell",
        "events",
        "compaction",
      ]),
    ),
  ).annotate({ description: "log parts (default user, output, tools, synthetic)" }),
  query: Schema.optionalKey(Schema.String),
  match: Schema.optionalKey(Match),
  context: Schema.optionalKey(NonNegativeCount).annotate({ description: "grep: entries of context around each match" }),
  scope: Schema.optionalKey(Schema.Literals(["all", "context"])).annotate({
    description: "log: all (full transcript, default) or context (what the model currently sees)",
  }),
  chars: Schema.optionalKey(Count).annotate({ description: "log: maximum characters per entry" }),
})

export const Plugin = {
  id: "opencode.tools.messaging",
  effect: Effect.fn("MessagingTools.Plugin")(function* (ctx: Context) {
    const messaging = yield* Messaging.Service
    const embedding = yield* MessagingEmbedding.Service
    const vars = yield* MessagingVars.Service
    const config = yield* Config.Service
    const models = yield* Model.Service
    const applied = yield* Ref.make<{ readonly all?: string; readonly embedding?: string }>({})

    // Settings apply when the location's config changes, so a tier picked through
    // msg({ mode: "model" }) sticks until the config itself changes.
    const settings = Effect.fnUntraced(function* () {
      const value = Config.latest(yield* config.entries(), "messaging")
      const next = { all: JSON.stringify(value ?? null), embedding: JSON.stringify(value?.embedding ?? null) }
      const previous = yield* Ref.getAndSet(applied, next)
      if (previous.all !== next.all) yield* vars.configure(value, ctx.location.directory)
      if (previous.embedding !== next.embedding) yield* embedding.configure(value?.embedding)
      return value
    })
    // An edited messaging section applies at once, also to HTTP clients that never call a tool.
    // Subscribed before the first read so an edit racing activation is not missed.
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => reloadsSections(event, ["messaging"])),
      Stream.runForEach(() => settings()),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* settings()

    // Every session starts with the session-start line (by default its creation date, time and
    // timezone). It is rendered from facts fixed at creation, so the system prompt stays cacheable,
    // and it is added to every request kind so warm-up requests share the same prefix.
    const sessionStart = (event: SessionHooks["context"]) =>
      vars.sessionStart(event.sessionID).pipe(
        Effect.map((text) => {
          if (text && text.trim() !== "") event.system.push(SystemPart.make(text))
        }),
        Effect.catchTag("Messaging.TemplateError", () => Effect.void),
      )
    yield* ctx.session.hook("context", sessionStart)
    yield* ctx.session.hook("compaction", sessionStart)
    yield* ctx.session.hook("generate", sessionStart)

    const rerank =
      (viewer: string, configured: ConfigMessaging.Info | undefined): Messaging.Rerank =>
      (query, candidates) =>
        Effect.gen(function* () {
          const model = yield* rerankModel(viewer, configured)
          const prompt = [
            "Rank the items by how well they answer or match the search query, by meaning.",
            "Reply with only a JSON array of the ids of relevant items, most relevant first. Omit irrelevant items.",
            `Query: ${query}`,
            "Items:",
            ...candidates.map((item) => `[${item.key}] ${item.text.replace(/\s+/g, " ")}`),
          ].join("\n")
          const response = yield* ctx.generate.text({ prompt, ...(model ? { model } : {}) })
          const parsed = Schema.decodeUnknownOption(
            Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
          )(/\[[\s\S]*\]/.exec(response.text)?.[0] ?? "[]")
          if (parsed._tag === "None") return candidates.map((item) => item.key)
          return parsed.value.map(String)
        }).pipe(Effect.orElseSucceed(() => candidates.map((item) => item.key)))

    // The configured model, else the small model of the viewer's provider: the session's own, or the default
    // model's when the person searches.
    const rerankModel = Effect.fnUntraced(function* (viewer: string, configured: ConfigMessaging.Info | undefined) {
      const named = configured?.search?.model
      if (named) return yield* Effect.try(() => Model.Ref.parse(named)).pipe(Effect.orElseSucceed(() => undefined))
      const base = viewer.startsWith("ses")
        ? (yield* ctx.session.get({ sessionID: SessionSchema.ID.make(viewer) })).model
        : yield* models
            .default()
            .pipe(
              Effect.map((info) => (info ? Model.Ref.make({ providerID: info.providerID, id: info.id }) : undefined)),
            )
      if (!base) return undefined
      const small = yield* models.small(base.providerID)
      return small ? Model.Ref.make({ providerID: small.providerID, id: small.id }) : base
    })

    // Searches from HTTP, plugins and the CLI pass no reranker; sessions in this location get this one.
    yield* messaging.reranker.register(
      (viewer) => (query, candidates) =>
        settings().pipe(Effect.flatMap((configured) => rerank(viewer, configured)(query, candidates))),
      ctx.location.directory,
    )

    const options = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const configured = yield* settings()
      return { ...(configured ? { config: configured } : {}), rerank: rerank(sessionID, configured) }
    })

    const aliasOf = Effect.fnUntraced(function* (value: "parent" | "root", self: string) {
      const chain = yield* messaging.chain({ session: self, depth: "all" })
      const target = value === "parent" ? chain.chain[1]?.id : chain.root
      if (!target) return yield* new Messaging.NotFoundError({ message: `${self} has no ${value}` })
      return target
    })

    yield* ctx.tool
      .transform((draft) => {
        draft.namespace({
          name: "comms",
          description:
            "Inter-session communication: message other sessions, topics or the user; read, await and search messages; see your session chain; read any session's log. You act as your own session.",
        })
        draft.add({
          name: "msg",
          description: [
            "Message other sessions, topics or the user; read, await, search, inspect, hide or restore messages.",
            "Examples: msg({ to: 'parent', text }) direct message (wakes the recipient); msg({ topic: 'family', text }) post to your family; msg({ mode: 'unread', wait: 60 }) wait for new messages; msg({ query: 'deploy failure' }) search by meaning; msg({ mode: 'user', text }) tell the user; msg({ mode: 'hide', topic, seq }) hide for yourself (nothing is ever deleted).",
            "Direct messages and the root topic are delivered into the recipient's conversation; other topics are read on demand unless subscribed.",
            "A delivered message wakes its recipient, so reply only when an answer is needed, never with a bare acknowledgement.",
          ].join("\n"),
          input: MsgInput,
          output: Schema.Unknown,
          options: { namespace: "comms", codemode: true, pinned: true },
          execute: (input, context) =>
            Effect.gen(function* () {
              const self = context.sessionID
              const current = yield* options(self)
              const mode =
                input.mode ??
                (input.query !== undefined
                  ? "search"
                  : input.text !== undefined
                    ? input.to === "user"
                      ? "user"
                      : "send"
                    : "read")
              const topics = list(input.topic)
              const seqs = list(input.seq)
              const filters = {
                as: self,
                ...(topics ? { topics } : input.to && input.to !== "user" ? { topics: [`dm@${input.to}`] } : {}),
                ...pick(input, [
                  "from",
                  "since",
                  "until",
                  "after",
                  "before",
                  "kinds",
                  "hidden",
                  "hiddenBy",
                  "hiddenFrom",
                  "hiddenSince",
                  "hiddenUntil",
                  "limit",
                  "order",
                ]),
                ...(input.type ? { types: [input.type] } : {}),
              }
              switch (mode) {
                case "send": {
                  if (input.text === undefined) return yield* fail("send needs text")
                  const result = yield* messaging.send(
                    {
                      as: self,
                      ...(topics?.[0] ? { topic: topics[0] } : {}),
                      ...(input.to ? { to: input.to } : {}),
                      text: input.text,
                      ...(input.type ? { type: input.type } : {}),
                      ...(seqs?.[0] ? { reply: seqs[0] } : {}),
                      ...(input.force ? { force: true } : {}),
                      ...(input.deliver ? { deliver: input.deliver } : {}),
                    },
                    current,
                  )
                  return done(
                    result,
                    `Sent ${result.topic}#${result.seq}${result.delivered.length > 0 ? ` to ${result.delivered.map((item) => `${item.session} (${item.delivery})`).join(", ")}` : ""}.`,
                  )
                }
                case "user": {
                  if (input.text === undefined) return yield* fail("user needs text")
                  const result = yield* messaging.user(
                    { as: self, text: input.text, ...(input.root ? { root: input.root } : {}) },
                    current,
                  )
                  return done(result, `Sent to the user (${result.topic}#${result.seq}).`)
                }
                case "read":
                case "unread":
                case "search": {
                  const result = yield* messaging.query(
                    {
                      ...filters,
                      ...(mode === "unread" ? { unread: true, ...(input.wait ? { wait: input.wait } : {}) } : {}),
                      ...(mode === "search"
                        ? { query: input.query ?? input.text ?? "", ...(input.match ? { match: input.match } : {}) }
                        : {}),
                    },
                    current,
                  )
                  const messages = result.messages.map(compactMessage)
                  return done(
                    {
                      messages,
                      more: result.more,
                      ...(result.match ? { match: result.match } : {}),
                      ...(result.note ? { note: result.note } : {}),
                    },
                    messages.length === 0 ? (result.note ?? "No messages.") : undefined,
                  )
                }
                case "inspect": {
                  const topic = topics?.[0]
                  if (!topic || !seqs?.[0]) return yield* fail("inspect needs topic and seq")
                  const message = yield* messaging.inspect({ as: self, topic, seq: seqs[0] }, current)
                  return done({ ...compactMessage(message), ops: message.ops ?? [] })
                }
                case "hide":
                case "restore": {
                  const topic = topics?.[0]
                  if (!topic) return yield* fail(`${mode} needs a topic`)
                  const result = yield* messaging.visibility(
                    {
                      as: self,
                      topic,
                      action: mode,
                      ...(seqs ? { seqs } : {}),
                      ...(input.for ? { for: input.for } : {}),
                      ...(input.reason ? { reason: input.reason } : {}),
                    },
                    current,
                  )
                  return done(
                    result,
                    `${mode === "hide" ? "Hid" : "Restored"} ${result.default ? "the default" : result.targets.map((seq) => `#${seq}`).join(", ")} in ${result.topic} for ${result.viewers.join(", ")} (recorded as #${result.seq}).`,
                  )
                }
                case "model": {
                  if (input.tier) {
                    yield* embedding.configure(input.tier)
                    if (input.tier !== "off") yield* embedding.start()
                  }
                  return done(yield* embedding.status())
                }
              }
            }).pipe(Effect.mapError(toFailure)),
        })
        draft.add({
          name: "topics",
          description: [
            "List, inspect and configure message topics; list every topic preset and template variable; set variables.",
            "Standard topics exist lazily: list shows yours before first use. Write limits are soft (force overrides) and anyone may change settings.",
            "set_var stores {name} for templates; a session's variables are inherited by its subsessions, which is how variables pass between sessions.",
          ].join("\n"),
          input: TopicsInput,
          output: Schema.Unknown,
          options: { namespace: "comms", codemode: true, pinned: true },
          execute: (input, context) =>
            Effect.gen(function* () {
              const self = context.sessionID
              const current = yield* options(self)
              const topics = list(input.topic)
              switch (input.mode ?? "list") {
                case "list": {
                  const filtered = Boolean(topics || input.sessions || input.kinds || input.search)
                  const result = yield* messaging.topics(
                    {
                      as: self,
                      ...(topics ? { topics } : {}),
                      ...pick(input, [
                        "sessions",
                        "role",
                        "kinds",
                        "search",
                        "sort",
                        "order",
                        "limit",
                        "offset",
                        "expand",
                      ]),
                      standard: input.standard ?? !filtered,
                    },
                    current,
                  )
                  return done({ topics: result.topics.map(compactTopic), total: result.total })
                }
                case "info": {
                  const topic = topics?.[0]
                  if (!topic) return yield* fail("info needs a topic")
                  return done(
                    compactTopic(
                      yield* messaging.topic(
                        { as: self, topic, ...(input.expand ? { expand: input.expand } : {}) },
                        current,
                      ),
                    ),
                  )
                }
                case "settings": {
                  const topic = topics?.[0]
                  if (!topic) return yield* fail("settings needs a topic")
                  const result = yield* messaging.settings(
                    {
                      as: self,
                      topic,
                      ...(input.write ? { mode: input.write } : {}),
                      ...(input.writers ? { writers: input.writers.map(writer) } : {}),
                      ...(input.description !== undefined ? { description: input.description } : {}),
                    },
                    current,
                  )
                  return done(compactTopic(result))
                }
                case "subscribe":
                case "unsubscribe": {
                  const topic = topics?.[0]
                  if (!topic) return yield* fail(`${input.mode} needs a topic`)
                  const result = yield* messaging.subscribe(
                    {
                      as: self,
                      topic,
                      ...(input.deliver ? { delivery: input.deliver } : {}),
                      ...(input.mode === "unsubscribe" ? { remove: true } : {}),
                    },
                    current,
                  )
                  return done(compactTopic(result))
                }
                case "presets": {
                  const result = yield* messaging.vars(
                    {
                      as: self,
                      ...(input.values ? { values: true } : {}),
                      ...(input.render ? { render: input.render } : {}),
                    },
                    current,
                  )
                  return done(result)
                }
                case "set_var": {
                  if (!input.name) return yield* fail("set_var needs a name")
                  yield* messaging.setVar(
                    {
                      as: self,
                      name: input.name,
                      ...(input.value !== undefined ? { value: input.value } : {}),
                      ...(input.scope ? { scope: input.scope } : {}),
                    },
                    current,
                  )
                  return done({
                    name: input.name,
                    scope: input.scope ?? "self",
                    ...(input.value !== undefined ? { value: input.value } : { removed: true }),
                  })
                }
              }
            }).pipe(Effect.mapError(toFailure)),
        })
        draft.add({
          name: "sessions",
          description: [
            "Show your session chain (parents up to the root), list all sessions, and read or search any session's log.",
            "chain defaults to you and your parent; depth all walks to the root; detail full adds counts and costs. log reads any session (or session+descendants) with op head, tail, grep, search or pull and include to pick parts such as thinking or tools.",
          ].join("\n"),
          input: SessionsInput,
          output: Schema.Unknown,
          options: { namespace: "comms", codemode: true, pinned: true },
          execute: (input, context) =>
            Effect.gen(function* () {
              const self = context.sessionID
              const subjects = list(input.session) ?? ["self"]
              switch (input.mode ?? "chain") {
                case "chain": {
                  const session = subjects[0] === "self" ? self : (subjects[0] ?? self)
                  const result = yield* messaging.chain({
                    session: session === "parent" || session === "root" ? yield* aliasOf(session, self) : session,
                    ...pick(input, ["depth", "detail", "expand"]),
                  })
                  return done({ ...result, chain: result.chain.map(compactSession) })
                }
                case "list": {
                  const result = yield* messaging.sessions({
                    as: self,
                    ...(input.session ? { ids: subjects } : {}),
                    ...pick(input, [
                      "parent",
                      "ancestor",
                      "project",
                      "directory",
                      "agent",
                      "search",
                      "active",
                      "since",
                      "until",
                      "sort",
                      "order",
                      "limit",
                      "offset",
                      "detail",
                      "expand",
                    ]),
                  })
                  return done({ sessions: result.sessions.map(compactSession), total: result.total })
                }
                case "log": {
                  const current = yield* options(self)
                  const result = yield* messaging.log(
                    {
                      as: self,
                      sessions: subjects,
                      ...pick(input, [
                        "op",
                        "include",
                        "query",
                        "match",
                        "context",
                        "scope",
                        "since",
                        "until",
                        "limit",
                        "offset",
                        "chars",
                      ]),
                    },
                    current,
                  )
                  return done({
                    entries: result.entries.map((entry) => ({
                      ref: `${entry.session}/${entry.message}:${entry.index}`,
                      part: entry.part,
                      time: clock(entry.time),
                      ...(entry.tool ? { tool: entry.tool } : {}),
                      ...(entry.match === false ? { context: true } : {}),
                      ...(entry.score !== undefined ? { score: entry.score } : {}),
                      text: entry.text,
                    })),
                    total: result.total,
                    more: result.more,
                    ...(result.match ? { match: result.match } : {}),
                    ...(result.note ? { note: result.note } : {}),
                  })
                }
              }
            }).pipe(Effect.mapError(toFailure)),
        })
      })
      .pipe(Effect.orDie)
  }),
}

function list<A>(value: A | ReadonlyArray<A> | undefined): ReadonlyArray<A> | undefined {
  if (value === undefined) return undefined
  return isList(value) ? value : [value]
}

function isList<A>(value: A | ReadonlyArray<A>): value is ReadonlyArray<A> {
  return Array.isArray(value)
}

function pick<T extends object, K extends keyof T>(value: T, keys: ReadonlyArray<K>) {
  const result: Partial<Pick<T, K>> = {}
  for (const key of keys) if (value[key] !== undefined) result[key] = value[key]
  return result
}

function writer(expression: string) {
  const [session, ...modifiers] = expression.split("+")
  return {
    session: session.trim(),
    ...(modifiers.includes("children") || modifiers.includes("descendants") ? { children: true } : {}),
    ...(modifiers.includes("ancestors") ? { ancestors: true } : {}),
  }
}

function clock(time: number) {
  return MessagingTemplate.rfc3339(new Date(time)).slice(0, 19).replace("T", " ")
}

function compactMessage(message: Messaging.Message) {
  return {
    ref: `${message.topic}#${message.seq}`,
    from: message.writer,
    time: clock(message.time),
    ...(message.kind !== "message" ? { kind: message.kind } : {}),
    ...(message.type !== "message" ? { type: message.type } : {}),
    ...(message.reply ? { reply: message.reply } : {}),
    ...(message.hidden ? { hidden: true } : {}),
    ...(message.score !== undefined ? { score: message.score } : {}),
    text: message.data,
    ...(message.meta ? { meta: message.meta } : {}),
  }
}

function compactTopic(topic: Messaging.Topic) {
  return {
    name: topic.name,
    kind: topic.kind,
    ...(topic.exists ? {} : { exists: false }),
    ...(topic.owner ? { owner: topic.owner } : {}),
    ...(topic.description ? { description: topic.description } : {}),
    write: topic.policy,
    messages: topic.messages,
    ...(topic.last ? { last: clock(topic.last) } : {}),
    ...(topic.unread ? { unread: topic.unread } : {}),
    ...(topic.subscribed ? { subscribed: topic.subscribed } : {}),
    ...(topic.writersWindow ? { writers: topic.writersWindow } : {}),
    ...(topic.readersWindow ? { readers: topic.readersWindow } : {}),
    ...(topic.allowedWindow ? { allowed: topic.allowedWindow } : {}),
  }
}

function compactSession(session: Messaging.SessionNode) {
  return {
    ...session,
    ...(session.created ? { created: clock(session.created) } : {}),
    ...(session.updated ? { updated: clock(session.updated) } : {}),
  }
}

/** Machine output for Code Mode plus a short model-facing summary when one reads better than JSON. */
function done(output: unknown, summary?: string) {
  return { output, ...(summary ? { content: summary } : { content: JSON.stringify(output, null, 1) }) }
}

function fail(message: string) {
  return Effect.fail(new ToolFailure({ message }))
}

function toFailure(error: unknown) {
  if (error instanceof ToolFailure) return error
  if (
    error instanceof Messaging.NotFoundError ||
    error instanceof Messaging.DeniedError ||
    error instanceof Messaging.InvalidError
  )
    return new ToolFailure({ message: error.message })
  return new ToolFailure({ message: "Messaging failed", error })
}
