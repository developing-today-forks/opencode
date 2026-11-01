export * as Messaging from "./messaging.js"
export * from "@opencode/schema/messaging"

import path from "path"
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm"
import { Context, Duration, Effect, Layer, PubSub, Schema, Scope } from "effect"
import type { ConfigMessaging } from "@opencode/schema/config/messaging"
import { Messaging as Contract } from "@opencode/schema/messaging"
import { TuiEvent } from "@opencode/schema/tui-event"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "./bus.js"
import { Database } from "./database/database.js"
import { MessagingEmbedding } from "./messaging/embedding.js"
import { MessagingGraph } from "./messaging/graph.js"
import { MessagingLog } from "./messaging/log.js"
import { MessagingSearch } from "./messaging/search.js"
import {
  MessagingMessageTable,
  MessagingParticipantTable,
  MessagingSubscriptionTable,
  MessagingTopicTable,
  MessagingVectorTable,
  MessagingVisibilityTable,
} from "./messaging/sql.js"
import { MessagingTemplate } from "./messaging/template.js"
import { MessagingVars } from "./messaging/vars.js"
import { AbsolutePath } from "./schema.js"
import { Session } from "./session.js"
import { SessionEvent } from "./session/event.js"
import { SessionHistory } from "./session/history.js"
import { SessionSchema } from "./session/schema.js"
import { SessionMessageTable, SessionTable } from "./session/sql.js"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Messaging.NotFoundError", {
  message: Schema.String,
}) {}

/** A soft write limit refused the write; `force` overrides it. */
export class DeniedError extends Schema.TaggedError<DeniedError>()("Messaging.DeniedError", {
  message: Schema.String,
}) {}

export class InvalidError extends Schema.TaggedError<InvalidError>()("Messaging.InvalidError", {
  message: Schema.String,
}) {}

export type Error = NotFoundError | DeniedError | InvalidError

/** Reorders search candidates by meaning; supplied by callers that can reach a language model. */
export type Rerank = (
  query: string,
  candidates: ReadonlyArray<{ readonly key: string; readonly text: string }>,
) => Effect.Effect<ReadonlyArray<string>>

export interface Options {
  readonly config?: ConfigMessaging.Info
  readonly rerank?: Rerank
  /** System kind for trusted callers such as plugins; sessions always write plain messages. */
  readonly kind?: string
}

export interface KindDefinition {
  readonly name: string
  readonly description: string
  /** Hidden kinds are excluded from reads unless requested, like delete and restore operations. */
  readonly hidden?: boolean
}

export interface Interface {
  readonly send: (input: Contract.SendInput, options?: Options) => Effect.Effect<Contract.SendResult, Error>
  readonly user: (input: Contract.UserInput, options?: Options) => Effect.Effect<Contract.SendResult, Error>
  readonly query: (input: Contract.Query, options?: Options) => Effect.Effect<Contract.QueryResult, Error>
  readonly inspect: (input: Contract.InspectInput, options?: Options) => Effect.Effect<Contract.Message, Error>
  readonly visibility: (
    input: Contract.VisibilityInput,
    options?: Options,
  ) => Effect.Effect<Contract.VisibilityResult, Error>
  readonly settings: (input: Contract.SettingsInput, options?: Options) => Effect.Effect<Contract.Topic, Error>
  readonly subscribe: (input: Contract.SubscribeInput, options?: Options) => Effect.Effect<Contract.Topic, Error>
  readonly topic: (input: Contract.TopicInput, options?: Options) => Effect.Effect<Contract.Topic, Error>
  readonly topics: (input: Contract.TopicsInput, options?: Options) => Effect.Effect<Contract.TopicList, Error>
  readonly chain: (input: Contract.ChainInput) => Effect.Effect<Contract.Chain, Error>
  readonly sessions: (input: Contract.SessionsInput) => Effect.Effect<Contract.SessionList, Error>
  readonly log: (input: Contract.LogInput, options?: Options) => Effect.Effect<Contract.Log, Error>
  readonly vars: (input: Contract.VarsInput, options?: Options) => Effect.Effect<Contract.Vars, Error>
  readonly setVar: (input: Contract.SetVarInput, options?: Options) => Effect.Effect<void, Error>
  readonly kinds: {
    readonly register: (definition: KindDefinition) => Effect.Effect<void, InvalidError, Scope.Scope>
    readonly list: () => Effect.Effect<ReadonlyArray<KindDefinition>>
  }
  /**
   * The reranker advanced searches use when the caller passes none (HTTP, plugins, the CLI). Each location that can
   * reach a language model registers one for its directory and the scope of its activation; a search uses the one
   * for the searching session's directory. Calls without a session use the latest registration.
   */
  readonly reranker: {
    readonly register: (
      rerank: (viewer: string) => Rerank,
      directory?: string,
    ) => Effect.Effect<void, never, Scope.Scope>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Messaging") {}

const BUILTIN_KINDS: ReadonlyArray<KindDefinition> = [
  { name: "message", description: "A message written by a session or the user" },
  { name: "delete", description: "Hides messages for some viewers", hidden: true },
  { name: "restore", description: "Shows previously hidden messages again", hidden: true },
  { name: "settings", description: "Records a change to the topic's write settings", hidden: true },
]

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 500

const SCAN_LIMIT = 5000
const SEMANTIC_EMBED_LIMIT = 512
const MAX_WAIT_SECONDS = 600
/** Delivered notices carry at most this much of a message; the full text stays readable in its topic. */
const DELIVERED_CHARS = 8000
/** The largest per-entry character budget log() honours; larger requests clamp to it. */
const MAX_CHARS = 8000

/**
 * Normalises a log chars budget at the service boundary. HTTP payload decode already enforces
 * the contract PositiveInt, but plugin and tool callers reach the service directly with plain
 * numbers, so a negative chars would make clip() return the wrong end of an entry and NaN would
 * replace the entry text with a garbage marker. Fractional chars are floored, negative and
 * sub-1 values clamp to 1, values above MAX_CHARS clamp to MAX_CHARS, and NaN is treated as
 * absent (the caller's default). Valid budgets pass through unchanged. Context normalisation
 * for grep is normalizeContext below; limit (#948) and offset (#953) are out of scope.
 */
function normalizeChars(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback
  return Math.min(Math.max(Math.floor(value), 1), MAX_CHARS)
}

/**
 * Normalises a grep context count at the service boundary: fractional counts are floored and
 * negative, NaN and non-finite counts clamp to 0, so the selection loop only ever indexes the
 * entry list with integers. Valid counts (including 0) pass through unchanged.
 */
function normalizeContext(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

/**
 * Page size at the service boundary. Callers reach the service directly (plugins, the CLI), so a limit may arrive
 * unvalidated: NaN and negative values mean "absent" and take the default, anything else is floored to an integer and
 * clamped to [1, MAX_LIMIT].
 */
function pageLimit(value: number | undefined, fallback: number) {
  if (value === undefined || Number.isNaN(value) || value < 0) return fallback
  return Math.min(Math.max(Math.floor(value), 1), MAX_LIMIT)
}

/**
 * Normalises a paging offset at the service boundary. HTTP payload decode already enforces the
 * contract NonNegativeInt, but plugin and tool callers reach the service directly with plain
 * numbers, so a negative offset would wrap JS slice() pages to the wrong end of the transcript
 * and a negative SQL .offset() would escape the intended page. Fractional offsets are floored and
 * negative, NaN and non-finite offsets clamp to 0, so an invalid offset never reaches SQL .offset()
 * or a JS slice(). Valid offsets (including 0 and past-the-end) pass through unchanged. Limit
 * normalisation is out of scope (#948).
 */
function normalizeOffset(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

type TopicRow = typeof MessagingTopicTable.$inferSelect
type MessageRow = typeof MessagingMessageTable.$inferSelect

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service
    const vars = yield* MessagingVars.Service
    const embedding = yield* MessagingEmbedding.Service
    const written = yield* PubSub.unbounded<{ readonly topicID: number; readonly seq: number }>()
    const kinds = new Map<string, KindDefinition>(BUILTIN_KINDS.map((kind) => [kind.name, kind]))
    const fts = yield* setupFts(db)

    const invalid = (error: MessagingTemplate.TemplateError) => new InvalidError({ message: error.message })
    const rerankers: Array<{ readonly directory?: string; readonly rerank: (viewer: string) => Rerank }> = []

    /**
     * Fills what a caller (HTTP, plugins, skills) leaves out from the actor's location: the messaging config and
     * the reranker registered there. Calls without a session use the latest applied.
     */
    const resolveOptions = Effect.fnUntraced(function* (requested: Options | undefined, actor: string) {
      if (requested?.config && requested.rerank) return requested
      const directory = actor === "user" ? undefined : (yield* MessagingGraph.row(db, actor))?.directory
      const registered =
        directory === undefined
          ? rerankers.at(-1)
          : (rerankers.findLast((entry) => entry.directory === directory) ??
            rerankers.findLast((entry) => entry.directory === undefined))
      const rerank = requested?.rerank ?? registered?.rerank(actor)
      const config = requested?.config ?? (yield* vars.config(directory))
      return { ...requested, ...(config ? { config } : {}), ...(rerank ? { rerank } : {}) }
    })

    const scopeFor = (actor: string, options?: Options, args?: Record<string, string>) =>
      vars.scope({ session: actor, config: options?.config, ...(args ? { args } : {}) }).pipe(Effect.mapError(invalid))

    const resolveTopic = Effect.fnUntraced(function* (
      argument: string,
      actor: string,
      options?: Options,
      args?: Record<string, string>,
    ) {
      const scope = yield* scopeFor(actor, options, args)
      return yield* vars.topic(argument, scope).pipe(Effect.mapError(invalid))
    })

    const topicByName = (name: string) =>
      db.select().from(MessagingTopicTable).where(eq(MessagingTopicTable.name, name)).get().pipe(Effect.orDie)

    const ensureTopic = Effect.fnUntraced(function* (resolved: MessagingVars.ResolvedTopic, creator: string) {
      const now = Date.now()
      const inserted = yield* db
        .insert(MessagingTopicTable)
        .values({
          name: resolved.name,
          kind: resolved.kind,
          preset: resolved.preset ?? null,
          owner: resolved.owner ?? null,
          creator,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .returning({ id: MessagingTopicTable.id })
        .get()
        .pipe(Effect.orDie)
      const row = yield* topicByName(resolved.name)
      if (!row) return yield* Effect.die(new globalThis.Error(`Topic was not created: ${resolved.name}`))
      return { row, created: inserted !== undefined }
    })

    const ancestorIDs = (memo: Map<string, ReadonlyArray<string>>) =>
      Effect.fnUntraced(function* (id: string) {
        const known = memo.get(id)
        if (known) return known
        const value = (yield* MessagingGraph.ancestors(db, id)).map((row): string => row.id)
        memo.set(id, value)
        return value
      })

    /** Evaluates the soft write rule of a topic for a writer. */
    const writeRule = Effect.fnUntraced(function* (
      topic: { readonly name: string; readonly row?: TopicRow; readonly config?: ConfigMessaging.Info },
      writer: string,
    ) {
      const classified = MessagingTemplate.classify(topic.name, topic.config)
      const owner = topic.row?.owner ?? classified.owner ?? topic.row?.creator
      const lineage = ancestorIDs(new Map())
      const isOwnerOrAncestor = Effect.fnUntraced(function* () {
        if (!owner || writer === owner) return true
        return (yield* lineage(owner)).includes(writer)
      })
      if (writer === "user") return { ok: true, rule: "the user writes anywhere" }
      const mode = topic.row?.mode
      if (mode === "open") return { ok: true, rule: "anyone writes" }
      if (mode === "readonly")
        return {
          ok: yield* isOwnerOrAncestor(),
          rule: `read-only: only ${owner ?? "its creator"} and its ancestors write`,
        }
      if (mode === "limited") {
        if (owner && writer === owner) return { ok: true, rule: "limited writers" }
        for (const entry of topic.row?.writers ?? []) {
          if (entry.session === writer) return { ok: true, rule: "limited writers" }
          if (entry.children && (yield* lineage(writer)).includes(entry.session))
            return { ok: true, rule: "limited writers" }
          if (entry.ancestors && (yield* lineage(entry.session)).includes(writer))
            return { ok: true, rule: "limited writers" }
        }
        return {
          ok: false,
          rule: `limited to ${(topic.row?.writers ?? []).map(describeWriter).join(", ") || owner || "its creator"}`,
        }
      }
      const rule = MessagingVars.policyText[classified.policy]
      switch (classified.policy) {
        case "open":
          return { ok: true, rule }
        case "owner":
          return { ok: yield* isOwnerOrAncestor(), rule }
        case "family": {
          if (!owner || writer === owner) return { ok: true, rule }
          const ok = (yield* lineage(writer)).includes(owner) || (yield* lineage(owner)).includes(writer)
          return { ok, rule }
        }
        case "tree":
          return { ok: !owner || writer === owner || (yield* lineage(writer)).includes(owner), rule }
        case "roots":
          return { ok: (yield* lineage(writer)).length === 0, rule }
        case "pair":
          return { ok: writer === classified.owner || writer === classified.peer, rule }
      }
    })

    /** Appends a message inside a transaction, returning its id and sequence number. */
    const append = Effect.fnUntraced(function* (
      topic: TopicRow,
      input: {
        readonly kind: string
        readonly type: string
        readonly writer: string
        readonly data: string
        readonly meta?: Record<string, unknown>
        readonly reply?: number
      },
    ) {
      const now = Date.now()
      // Hidden operations (delete, restore, settings) do not count as the topic's latest message.
      const visible = !kinds.get(input.kind)?.hidden
      return yield* db
        .transaction(() =>
          Effect.gen(function* () {
            const next = yield* db
              .update(MessagingTopicTable)
              .set({ last_seq: sql`${MessagingTopicTable.last_seq} + 1`, ...(visible ? { time_last: now } : {}) })
              .where(eq(MessagingTopicTable.id, topic.id))
              .returning({ seq: MessagingTopicTable.last_seq })
              .get()
            const seq = next?.seq ?? topic.last_seq + 1
            const inserted = yield* db
              .insert(MessagingMessageTable)
              .values({
                topic_id: topic.id,
                seq,
                kind: input.kind,
                type: input.type,
                writer: input.writer,
                data: input.data,
                meta: input.meta ?? null,
                reply: input.reply ?? null,
                time_created: now,
              })
              .returning({ id: MessagingMessageTable.id })
              .get()
            yield* db
              .insert(MessagingParticipantTable)
              .values({
                topic_id: topic.id,
                session_id: input.writer,
                writes: 1,
                last_read_seq: seq,
                time_first_write: now,
                time_last_write: now,
              })
              .onConflictDoUpdate({
                target: [MessagingParticipantTable.topic_id, MessagingParticipantTable.session_id],
                set: {
                  writes: sql`${MessagingParticipantTable.writes} + 1`,
                  last_read_seq: sql`max(${MessagingParticipantTable.last_read_seq}, ${seq})`,
                  time_first_write: sql`coalesce(${MessagingParticipantTable.time_first_write}, ${now})`,
                  time_last_write: now,
                },
              })
              .run()
            return { id: inserted?.id ?? 0, seq, time: now }
          }),
        )
        .pipe(Effect.orDie)
    })

    const subscribeRow = (topicID: number, session: string, delivery: Contract.Delivery, by: string) =>
      db
        .insert(MessagingSubscriptionTable)
        .values({ topic_id: topicID, session_id: session, delivery, by, time_created: Date.now() })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie, Effect.asVoid)

    /** Sessions that receive pushes for a new message, with how. An explicit addressee is always included. */
    const recipients = Effect.fnUntraced(function* (
      topic: TopicRow,
      writer: string,
      seq: number,
      override: Contract.Delivery | undefined,
      config: ConfigMessaging.Info | undefined,
      to?: string,
    ) {
      const subscribed = yield* db
        .select()
        .from(MessagingSubscriptionTable)
        .where(eq(MessagingSubscriptionTable.topic_id, topic.id))
        .all()
        .pipe(Effect.orDie)
      const result = new Map<string, Contract.Delivery>(subscribed.map((row) => [row.session_id, row.delivery]))
      const classified = MessagingTemplate.classify(topic.name, config)
      if (classified.kind === "root" && classified.owner && !result.has(classified.owner))
        result.set(classified.owner, config?.delivery?.root ?? "wake")
      if (classified.kind === "dm")
        for (const member of [classified.owner, classified.peer])
          if (member && !result.has(member)) result.set(member, config?.delivery?.direct ?? "wake")
      if (to) result.set(to, config?.delivery?.direct ?? "wake")
      result.delete(writer)
      result.delete("user")
      const hidden = yield* hiddenFor(topic.id, seq, Array.from(result.keys()))
      return Array.from(result)
        .map(([session, delivery]) => ({ session, delivery: override ?? delivery }))
        .filter((item) => item.delivery !== "none" && !hidden.has(item.session))
    })

    /** Viewers among the candidates for whom one message is effectively hidden. */
    const hiddenFor = Effect.fnUntraced(function* (topicID: number, seq: number, viewers: ReadonlyArray<string>) {
      if (viewers.length === 0) return new Set<string>()
      const rows = yield* db
        .select()
        .from(MessagingVisibilityTable)
        .where(
          and(
            eq(MessagingVisibilityTable.topic_id, topicID),
            inArray(MessagingVisibilityTable.seq, [seq, 0]),
            inArray(MessagingVisibilityTable.viewer, [...viewers, "*"]),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const state = (target: number, viewer: string) =>
        rows.find((row) => row.seq === target && row.viewer === viewer)?.hidden
      return new Set(
        viewers.filter(
          (viewer) => (state(seq, viewer) ?? state(seq, "*") ?? state(0, viewer) ?? state(0, "*") ?? false) === true,
        ),
      )
    })

    const titles = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
      const unique = Array.from(new Set(ids.filter((id) => id.startsWith("ses"))))
      if (unique.length === 0) return new Map<string, string>()
      const rows = yield* db
        .select({ id: SessionTable.id, title: SessionTable.title })
        .from(SessionTable)
        .where(
          sql`${SessionTable.id} IN (${sql.join(
            unique.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        )
        .all()
        .pipe(Effect.orDie)
      return new Map(rows.map((row): [string, string] => [row.id, row.title ?? ""]))
    })

    const push = Effect.fnUntraced(function* (
      topic: TopicRow,
      message: { readonly seq: number; readonly time: number },
      input: { readonly writer: string; readonly type: string; readonly data: string },
      targets: ReadonlyArray<{ readonly session: string; readonly delivery: Contract.Delivery }>,
    ) {
      if (targets.length === 0) return []
      const title = (yield* titles([input.writer])).get(input.writer)
      const notice = render(topic.name, { ...message, ...input, title })
      return yield* Effect.forEach(
        targets,
        (target) =>
          sessions
            .synthetic({
              sessionID: SessionSchema.ID.make(target.session),
              text: notice.text,
              description: notice.description,
              metadata: {
                source: "messaging",
                topic: topic.name,
                seq: message.seq,
                from: input.writer,
                type: input.type,
              },
              ...(target.delivery === "inbox" ? { resume: false } : {}),
            })
            .pipe(
              Effect.as([target]),
              // Delivery is best effort: the message is already stored and readable on demand.
              Effect.catch((error) =>
                Effect.logWarning("messaging delivery failed", { session: target.session, error }).pipe(Effect.as([])),
              ),
              Effect.catchDefect((defect) =>
                Effect.logWarning("messaging delivery failed", { session: target.session, defect }).pipe(Effect.as([])),
              ),
            ),
        { concurrency: 4 },
      ).pipe(Effect.map((items) => items.flat()))
    })

    const send: Interface["send"] = Effect.fn("Messaging.send")(function* (input, requested) {
      const options = yield* resolveOptions(requested, input.as ?? "user")
      const writer = input.as ?? "user"
      const kind = options?.kind ?? "message"
      if (!kinds.has(kind)) return yield* new InvalidError({ message: `Unknown message kind: ${kind}` })
      if (input.to === "user") return yield* user({ as: writer, text: input.text }, options)
      const to = input.to ? yield* MessagingGraph.alias(db, input.to, writer) : undefined
      if (input.to && !to) return yield* new NotFoundError({ message: `Unknown session: ${input.to}` })
      if (to && !(yield* MessagingGraph.row(db, to)))
        return yield* new NotFoundError({ message: `Session not found: ${to}` })
      // The user has no session of its own, so its direct line to a session is that session's user topic.
      const argument = input.topic ?? (to ? (writer === "user" ? "{to}{separator}{user}" : "dm") : undefined)
      if (!argument) return yield* new InvalidError({ message: "Give a topic or a session to send to (to)" })
      const resolved = yield* resolveTopic(argument, writer, options, to ? { to, from: writer } : { from: writer })
      const existing = yield* topicByName(resolved.name)
      const rule = yield* writeRule({ name: resolved.name, row: existing, config: options?.config }, writer)
      if (!rule.ok && !input.force)
        return yield* new DeniedError({
          message: `${resolved.name}: ${rule.rule}. ${writer} may not write here; pass force: true to write anyway.`,
        })
      const ensured = existing ? { row: existing, created: false } : yield* ensureTopic(resolved, writer)
      const message = yield* append(ensured.row, {
        kind,
        type: input.type ?? "message",
        writer,
        data: input.text,
        ...(input.meta ? { meta: input.meta } : {}),
        ...(input.reply ? { reply: input.reply } : {}),
      })
      if (to && resolved.kind === "dm") {
        const delivery = options?.config?.delivery?.direct ?? "wake"
        yield* subscribeRow(ensured.row.id, to, delivery, writer)
        if (writer !== "user") yield* subscribeRow(ensured.row.id, writer, delivery, writer)
      }
      yield* announce(ensured.row, message, { kind, type: input.type ?? "message", writer, data: input.text })
      const targets = yield* recipients(ensured.row, writer, message.seq, input.deliver, options?.config, to)
      const delivered = yield* push(
        ensured.row,
        message,
        { writer, type: input.type ?? "message", data: input.text },
        targets,
      )
      return {
        topic: resolved.name,
        seq: message.seq,
        created: ensured.created,
        ...(rule.ok ? {} : { forced: true }),
        delivered,
      }
    })

    const announce = Effect.fnUntraced(function* (
      topic: TopicRow,
      message: { readonly id: number; readonly seq: number; readonly time: number },
      input: { readonly kind: string; readonly type: string; readonly writer: string; readonly data: string },
    ) {
      yield* PubSub.publish(written, { topicID: topic.id, seq: message.seq })
      yield* bus.publish(
        Contract.Event.Created,
        {
          topic: topic.name,
          seq: message.seq,
          kind: input.kind,
          type: input.type,
          writer: input.writer,
          time: message.time,
          preview: input.data.length > 200 ? `${input.data.slice(0, 197)}...` : input.data,
          ...(topic.kind === "user" ? { inbox: true } : {}),
        },
        { global: true },
      )
    })

    const user: Interface["user"] = Effect.fn("Messaging.user")(function* (input, requested) {
      const options = yield* resolveOptions(requested, input.as)
      const writer = input.as
      const session = writer === "user" ? undefined : yield* MessagingGraph.row(db, writer)
      if (writer !== "user" && !session) return yield* new NotFoundError({ message: `Session not found: ${writer}` })
      const root = session ? ((yield* MessagingGraph.ancestors(db, session.id)).at(-1) ?? session) : undefined
      const resolved = yield* resolveTopic("user", writer, options)
      const existing = yield* topicByName(resolved.name)
      const ensured = existing ? { row: existing, created: false } : yield* ensureTopic(resolved, writer)
      const message = yield* append(ensured.row, { kind: "message", type: "user", writer, data: input.text })
      yield* announce(ensured.row, message, { kind: "message", type: "user", writer, data: input.text })
      if (!root) return { topic: resolved.name, seq: message.seq, created: ensured.created, delivered: [] }
      const mode = input.root ?? options?.config?.delivery?.user ?? "visible"
      const title = input.title ?? (session?.title ? `From ${session.title}` : "Message from a session")
      const location = {
        directory: AbsolutePath.make(root.directory),
        ...(root.workspace_id ? { workspaceID: root.workspace_id } : {}),
      }
      const metadata = {
        source: "messaging",
        audience: mode === "hidden" ? "user" : "all",
        topic: resolved.name,
        seq: message.seq,
        from: writer,
        type: "user",
      }
      const description = `✉ ${title}: ${firstLine(input.text)}`
      const attributes = [
        `to="user"`,
        `from="${escapeAttribute(writer)}"`,
        ...(session?.title ? [`from_title="${escapeAttribute(session.title)}"`] : []),
        `topic="${escapeAttribute(resolved.name)}"`,
        `seq="${message.seq}"`,
      ]
      const text = `<message ${attributes.join(" ")}>\n${MessagingLog.escapeBody(input.text)}\n</message>`
      if (mode === "wake") {
        yield* sessions.synthetic({ sessionID: SessionSchema.ID.make(root.id), text, description, metadata }).pipe(
          Effect.catch((error) => Effect.logWarning("messaging user delivery failed", { error })),
          Effect.catchDefect((defect) => Effect.logWarning("messaging user delivery failed", { defect })),
        )
      }
      if (mode !== "wake")
        yield* bus.publish(
          SessionEvent.Synthetic,
          { sessionID: SessionSchema.ID.make(root.id), text, description, metadata },
          { location },
        )
      yield* bus.publish(
        TuiEvent.ToastShow,
        {
          title,
          message: input.text.length > 400 ? `${input.text.slice(0, 397)}...` : input.text,
          variant: "info",
          duration: 15_000,
        },
        { location },
      )
      return {
        topic: resolved.name,
        seq: message.seq,
        created: ensured.created,
        delivered: [{ session: root.id, delivery: mode === "wake" ? "wake" : "inbox" }],
      }
    })

    /** Topic ids a viewer follows for unread messages: subscriptions, participation and its standard topics. */
    const followed = Effect.fnUntraced(function* (viewer: string, options?: Options) {
      const ids = new Set<number>()
      const subscriptions = yield* db
        .select({ id: MessagingSubscriptionTable.topic_id })
        .from(MessagingSubscriptionTable)
        .where(eq(MessagingSubscriptionTable.session_id, viewer))
        .all()
        .pipe(Effect.orDie)
      const participation = yield* db
        .select({ id: MessagingParticipantTable.topic_id })
        .from(MessagingParticipantTable)
        .where(eq(MessagingParticipantTable.session_id, viewer))
        .all()
        .pipe(Effect.orDie)
      for (const row of [...subscriptions, ...participation]) ids.add(row.id)
      if (viewer === "user") return ids
      const session = yield* MessagingGraph.row(db, viewer)
      if (!session) return ids
      const names = yield* standardNames(viewer, options)
      const rows =
        names.length === 0
          ? []
          : yield* db
              .select({ id: MessagingTopicTable.id })
              .from(MessagingTopicTable)
              .where(
                inArray(
                  MessagingTopicTable.name,
                  names.map((item) => item.name),
                ),
              )
              .all()
              .pipe(Effect.orDie)
      for (const row of rows) ids.add(row.id)
      const direct = yield* db
        .select({ id: MessagingTopicTable.id })
        .from(MessagingTopicTable)
        .where(and(eq(MessagingTopicTable.kind, "dm"), sql`instr(${MessagingTopicTable.name}, ${viewer}) > 0`))
        .all()
        .pipe(Effect.orDie)
      for (const row of direct) ids.add(row.id)
      return ids
    })

    /** The standard topic names of a session, resolved lazily: they need not exist yet. */
    const standardNames = Effect.fnUntraced(function* (viewer: string, options?: Options) {
      const scope = yield* scopeFor(viewer, options).pipe(Effect.orElseSucceed(() => undefined))
      if (!scope?.session) return []
      const isRoot = !scope.session.parent_id
      const names = ["private", "readonly", "readwrite", "tasks", "children", "family", "tree", "root", "user"].filter(
        (preset) => isRoot || preset !== "root",
      )
      const resolved = yield* Effect.forEach(names, (preset) =>
        vars.topic(preset, scope).pipe(
          Effect.map((topic) => [topic]),
          Effect.orElseSucceed(() => []),
        ),
      )
      const unique = new Map(resolved.flat().map((topic) => [topic.name, topic]))
      return Array.from(unique.values())
    })

    const query: Interface["query"] = Effect.fn("Messaging.query")(function* (input, requested) {
      const options = yield* resolveOptions(requested, input.as ?? "user")
      if (!input.unread || !input.wait || input.wait <= 0) return yield* read(input, options)
      const seconds = Math.min(input.wait, MAX_WAIT_SECONDS)
      const viewer = input.as ?? "user"
      return yield* Effect.scoped(
        Effect.gen(function* () {
          // Subscribe before the first read so a message written in between still wakes the wait.
          const subscription = yield* PubSub.subscribe(written)
          const first = yield* read(input, options)
          if (first.messages.length > 0) return first
          // Membership can change while waiting (a first message creates its topic), so the
          // watched topics are resolved again for each new message.
          const relevant = (topicID: number) =>
            input.topics && input.topics.length > 0
              ? topicIDsFor(input.topics, viewer, options).pipe(Effect.map((found) => found.ids.includes(topicID)))
              : followed(viewer, options).pipe(Effect.map((ids) => ids.has(topicID)))
          const next: Effect.Effect<void, Error> = PubSub.take(subscription).pipe(
            Effect.flatMap((event) => relevant(event.topicID)),
            Effect.flatMap((matched) => (matched ? Effect.void : next)),
          )
          const woke = yield* next.pipe(Effect.timeoutOption(Duration.seconds(seconds)))
          if (woke._tag === "None")
            return { messages: [], more: false, note: `No unread messages after waiting ${seconds}s` }
          return yield* read(input, options)
        }),
      )
    })

    const topicIDsFor = Effect.fnUntraced(function* (
      topics: ReadonlyArray<string>,
      viewer: string,
      options: Options | undefined,
    ) {
      const names = yield* Effect.forEach(topics, (topic) =>
        resolveTopic(topic, viewer, options).pipe(Effect.map((item) => item.name)),
      )
      const rows = yield* db
        .select({ id: MessagingTopicTable.id, name: MessagingTopicTable.name })
        .from(MessagingTopicTable)
        .where(inArray(MessagingTopicTable.name, names))
        .all()
        .pipe(Effect.orDie)
      return { ids: rows.map((row) => row.id), missing: names.filter((name) => !rows.some((row) => row.name === name)) }
    })

    const read = Effect.fnUntraced(function* (input: Contract.Query, options: Options | undefined) {
      const viewer = input.as ?? "user"
      const now = Date.now()
      const limit = pageLimit(input.limit, DEFAULT_LIMIT)
      const topicIDs = yield* Effect.gen(function* () {
        if (input.topics && input.topics.length > 0) return yield* topicIDsFor(input.topics, viewer, options)
        if (input.unread) return { ids: Array.from(yield* followed(viewer, options)), missing: [] }
        return undefined
      })
      if (topicIDs && topicIDs.ids.length === 0)
        return {
          messages: [],
          more: false,
          ...(topicIDs.missing.length > 0
            ? { note: `No messages yet: ${topicIDs.missing.join(", ")} is not created until first use` }
            : {}),
        }
      const conditions = yield* filters(input, viewer, now, topicIDs?.ids)
      const match = input.query?.trim() ? (input.match ?? options?.config?.search?.match ?? "hybrid") : undefined
      const ranked = match
        ? yield* search(input.query ?? "", match, conditions, limit, options)
        : yield* chronological(conditions, input, limit)
      const names = yield* topicNames(ranked.rows.map((row) => row.topic_id))
      const hidden = yield* effectiveHidden(ranked.rows, viewer, input.kinds)
      const messages = ranked.rows.map((row) =>
        toMessage(row, names.get(row.topic_id) ?? "", {
          hidden: hidden.has(row.id),
          ...(ranked.scores.has(row.id) ? { score: round(ranked.scores.get(row.id) ?? 0) } : {}),
        }),
      )
      // Only plain reads advance the read pointer: a search or filtered read may skip unread messages.
      const filtered = Boolean(
        match ||
          input.from?.length ||
          input.types?.length ||
          input.kinds?.length ||
          input.since ||
          input.until ||
          (input.hidden && input.hidden !== "exclude"),
      )
      // The pointer is a high-water mark, so it moves only when the page holds every message up to its newest:
      // an oldest-first read (unread reads are) or a page with nothing left over. A read across all topics
      // follows none of them.
      const ascending = input.order === "asc" || (input.order === undefined && input.unread === true)
      const complete = topicIDs !== undefined && input.after === undefined && (ascending || !ranked.more)
      if ((input.markRead ?? (viewer !== "user" && !filtered && complete)) && messages.length > 0)
        yield* markRead(viewer, ranked.rows)
      return {
        messages,
        more: ranked.more,
        ...(match ? { match: ranked.match } : {}),
        ...(ranked.note ? { note: ranked.note } : {}),
      }
    })

    const topicNames = Effect.fnUntraced(function* (ids: ReadonlyArray<number>) {
      const unique = Array.from(new Set(ids))
      if (unique.length === 0) return new Map<number, string>()
      const rows = yield* db
        .select({ id: MessagingTopicTable.id, name: MessagingTopicTable.name })
        .from(MessagingTopicTable)
        .where(inArray(MessagingTopicTable.id, unique))
        .all()
        .pipe(Effect.orDie)
      return new Map(rows.map((row): [number, string] => [row.id, row.name]))
    })

    /** SQL conditions for every non-text filter, including effective visibility for the viewer. */
    const filters = Effect.fnUntraced(function* (
      input: Contract.Query,
      viewer: string,
      now: number,
      topicIDs: ReadonlyArray<number> | undefined,
    ) {
      const m = MessagingMessageTable
      const conditions: SQL[] = []
      if (topicIDs) conditions.push(inArray(m.topic_id, Array.from(topicIDs)))
      if (input.after !== undefined) conditions.push(sql`${m.seq} > ${input.after}`)
      if (input.before !== undefined) conditions.push(sql`${m.seq} < ${input.before}`)
      const since = input.since ? MessagingTemplate.parseTime(input.since, now) : undefined
      const until = input.until ? MessagingTemplate.parseTime(input.until, now) : undefined
      if (input.since && since === undefined)
        return yield* new InvalidError({ message: `Invalid time: ${input.since}` })
      if (input.until && until === undefined)
        return yield* new InvalidError({ message: `Invalid time: ${input.until}` })
      if (since !== undefined) conditions.push(sql`${m.time_created} >= ${since}`)
      if (until !== undefined) conditions.push(sql`${m.time_created} <= ${until}`)
      if (input.from && input.from.length > 0) {
        const writers = Array.from(yield* MessagingGraph.expand(db, input.from, viewer))
        conditions.push(writers.length === 0 ? sql`0` : inArray(m.writer, writers))
      }
      if (input.types && input.types.length > 0) conditions.push(inArray(m.type, Array.from(input.types)))
      if (input.kinds && input.kinds.length > 0) conditions.push(inArray(m.kind, Array.from(input.kinds)))
      // The type is a free label any writer sets; a message reaches the person through a user topic.
      if (input.inbox) conditions.push(sql`${m.topic_id} IN (SELECT t.id FROM messaging_topic t WHERE t.kind = 'user')`)
      if (input.unread) {
        conditions.push(sql`${m.writer} <> ${viewer}`)
        conditions.push(
          sql`${m.seq} > coalesce((SELECT p.last_read_seq FROM messaging_participant p WHERE p.topic_id = ${m.topic_id} AND p.session_id = ${viewer}), 0)`,
        )
      }
      const hiddenExpression = hiddenSql(viewer, hiddenKinds(input.kinds))
      const mode = input.hidden ?? "exclude"
      if (mode === "exclude") conditions.push(sql`${hiddenExpression} = 0`)
      if (mode !== "exclude") {
        const hiddenFilter = yield* hiddenMatch(input, viewer, now)
        conditions.push(
          mode === "only"
            ? sql`(${hiddenExpression} = 1 AND ${hiddenFilter})`
            : sql`(${hiddenExpression} = 0 OR ${hiddenFilter})`,
        )
      }
      return conditions
    })

    /** Kinds hidden by default, except those the caller asked for explicitly. */
    const hiddenKinds = (requested: ReadonlyArray<string> | undefined) =>
      Array.from(kinds.values())
        .filter((kind) => kind.hidden && !(requested ?? []).includes(kind.name))
        .map((kind) => kind.name)

    /** Filters which hidden messages are re-included: hidden by, written by, and when they were hidden. */
    const hiddenMatch = Effect.fnUntraced(function* (input: Contract.Query, viewer: string, now: number) {
      const m = MessagingMessageTable
      const parts: SQL[] = []
      if (input.hiddenFrom && input.hiddenFrom.length > 0) {
        const writers = Array.from(yield* MessagingGraph.expand(db, input.hiddenFrom, viewer))
        parts.push(writers.length === 0 ? sql`0` : inArray(m.writer, writers))
      }
      const by =
        input.hiddenBy && input.hiddenBy.length > 0
          ? Array.from(yield* MessagingGraph.expand(db, input.hiddenBy, viewer))
          : undefined
      const since = input.hiddenSince ? MessagingTemplate.parseTime(input.hiddenSince, now) : undefined
      const until = input.hiddenUntil ? MessagingTemplate.parseTime(input.hiddenUntil, now) : undefined
      if (by || since !== undefined || until !== undefined) {
        const clauses = [
          sql`v.topic_id = ${m.topic_id}`,
          sql`v.seq IN (${m.seq}, 0)`,
          sql`v.viewer IN (${viewer}, '*')`,
          sql`v.hidden = 1`,
          ...(by
            ? [
                by.length === 0
                  ? sql`0`
                  : sql`v.by IN (${sql.join(
                      by.map((id) => sql`${id}`),
                      sql`, `,
                    )})`,
              ]
            : []),
          ...(since !== undefined ? [sql`v.time_updated >= ${since}`] : []),
          ...(until !== undefined ? [sql`v.time_updated <= ${until}`] : []),
        ]
        parts.push(sql`EXISTS (SELECT 1 FROM messaging_visibility v WHERE ${sql.join(clauses, sql` AND `)})`)
      }
      return parts.length === 0 ? sql`1` : sql.join(parts, sql` AND `)
    })

    const chronological = Effect.fnUntraced(function* (
      conditions: ReadonlyArray<SQL>,
      input: Contract.Query,
      limit: number,
    ) {
      const m = MessagingMessageTable
      // Unread and explicit ascending reads start from the oldest; otherwise show the latest page oldest-first.
      const ascending = input.order === "asc" || (input.order === undefined && input.unread === true)
      const rows = yield* db
        .select()
        .from(m)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(ascending ? asc(m.time_created) : desc(m.time_created), ascending ? asc(m.id) : desc(m.id))
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)
      const page = rows.slice(0, limit)
      return {
        rows: input.order === "desc" || ascending ? page : page.toReversed(),
        more: rows.length > limit,
        scores: new Map<number, number>(),
        match: undefined,
        note: undefined,
      }
    })

    const candidates = (conditions: ReadonlyArray<SQL>, extra?: SQL) =>
      db
        .select()
        .from(MessagingMessageTable)
        .where(and(...conditions, ...(extra ? [extra] : [])))
        .orderBy(desc(MessagingMessageTable.id))
        .limit(SCAN_LIMIT)
        .all()
        .pipe(Effect.orDie)

    const search = Effect.fnUntraced(function* (
      text: string,
      match: Contract.MatchMode,
      conditions: ReadonlyArray<SQL>,
      limit: number,
      options: Options | undefined,
    ) {
      const result = yield* rank(
        text,
        match,
        {
          exact: () => {
            const phrase = fts ? MessagingSearch.ftsPhrase(text) : undefined
            return candidates(
              conditions,
              phrase
                ? sql`${MessagingMessageTable.id} IN (SELECT rowid FROM messaging_message_fts WHERE messaging_message_fts MATCH ${phrase})`
                : sql`instr(lower(${MessagingMessageTable.data}), lower(${text})) > 0`,
            )
          },
          fuzzy: () => {
            const query = fts ? MessagingSearch.ftsQuery(text) : undefined
            return candidates(
              conditions,
              query
                ? sql`${MessagingMessageTable.id} IN (SELECT rowid FROM messaging_message_fts WHERE messaging_message_fts MATCH ${query})`
                : undefined,
            )
          },
          all: () => candidates(conditions),
        },
        (row) => row.data,
        (row) => String(row.id),
        "message",
        limit,
        options,
      )
      return {
        ...result,
        rows: result.rows,
        scores: new Map(Array.from(result.scores, ([key, score]) => [Number(key), score])),
      }
    })

    /**
     * Ranks rows for a text query. Fuzzy and exact narrow candidates in SQL; semantic compares cached
     * embeddings (embedding missing rows on demand); hybrid fuses both rankings; advanced reranks the
     * fused top candidates with a language model when the caller provides one.
     */
    const rank = <A>(
      text: string,
      match: Contract.MatchMode,
      sources: {
        readonly exact: () => Effect.Effect<ReadonlyArray<A>>
        readonly fuzzy: () => Effect.Effect<ReadonlyArray<A>>
        readonly all: () => Effect.Effect<ReadonlyArray<A>>
      },
      content: (row: A) => string,
      keyOf: (row: A) => string,
      source: "message" | "log",
      limit: number,
      options: Options | undefined,
    ) =>
      Effect.gen(function* () {
        const notes: string[] = []
        const take = (
          ordered: ReadonlyArray<{ readonly row: A; readonly score: number }>,
          used: Contract.MatchMode,
        ) => ({
          rows: ordered.slice(0, limit).map((item) => item.row),
          scores: new Map(ordered.slice(0, limit).map((item) => [keyOf(item.row), item.score])),
          total: ordered.length,
          more: ordered.length > limit,
          match: used,
          note: notes.length > 0 ? notes.join(" ") : undefined,
        })
        if (match === "exact") {
          const rows = yield* sources.exact()
          return take(
            rows.map((row) => ({ row, score: 1 })),
            "exact",
          )
        }
        if (match === "regex") {
          if (text.length > MessagingSearch.MAX_PATTERN)
            return yield* new InvalidError({
              message: `Regular expressions are limited to ${MessagingSearch.MAX_PATTERN} characters`,
            })
          const result = yield* MessagingSearch.regexFilter(text, yield* sources.all(), content)
          if (result.unchecked > 0)
            notes.push(
              `The pattern took too long to match; ${result.unchecked} older entries were not checked. Simplify it or narrow the search.`,
            )
          return take(
            result.matched.map((row) => ({ row, score: 1 })),
            "regex",
          )
        }
        const fuzzy = Effect.gen(function* () {
          const rows = yield* sources.fuzzy()
          return rows
            .map((row) => ({ row, score: MessagingSearch.fuzzy(text, content(row)) }))
            .filter((item) => item.score >= MessagingSearch.FUZZY_THRESHOLD)
            .sort((left, right) => right.score - left.score)
        })
        if (match === "fuzzy") return take(yield* fuzzy, "fuzzy")
        const semantic = yield* similar(text, yield* sources.all(), content, keyOf, source).pipe(
          Effect.map((result) => {
            if (result.pending > 0)
              notes.push(
                `Embedded the newest entries first; ${result.pending} older entries are not embedded yet and are ranked by text only.`,
              )
            return result.scored
          }),
          Effect.catchTag("Messaging.EmbeddingUnavailableError", (error) =>
            Effect.sync(() => {
              notes.push(`Semantic search unavailable (${error.message}); used fuzzy matching.`)
              return undefined
            }),
          ),
        )
        if (match === "semantic" && semantic) return take(semantic, "semantic")
        const lexical = yield* fuzzy
        const ranked = semantic ? fuseRankings(lexical, semantic, keyOf) : lexical
        const base = semantic ? "hybrid" : "fuzzy"
        if (match !== "advanced") return take(ranked, base)
        if (!options?.rerank) {
          notes.push(`Advanced reranking needs a language model; returned ${base} results.`)
          return take(ranked, base)
        }
        const top = ranked.slice(0, Math.max(limit * 2, 30))
        if (top.length === 0) return take(top, "advanced")
        const order = yield* options.rerank(
          text,
          top.map((item) => ({ key: keyOf(item.row), text: content(item.row).slice(0, 600) })),
        )
        const position = new Map(order.map((key, index) => [key, index]))
        const reranked = top
          .filter((item) => position.has(keyOf(item.row)))
          .sort((left, right) => (position.get(keyOf(left.row)) ?? 0) - (position.get(keyOf(right.row)) ?? 0))
          .map((item, index) => ({ row: item.row, score: 1 / (index + 1) }))
        return take(reranked, "advanced")
      })

    /** Cosine similarity against cached vectors, embedding up to a bounded number of missing rows. */
    const similar = <A>(
      text: string,
      rows: ReadonlyArray<A>,
      content: (row: A) => string,
      keyOf: (row: A) => string,
      source: "message" | "log",
    ) =>
      Effect.gen(function* () {
        const query = yield* embedding.embed([text], "query")
        const model = query.model
        const vector = query.vectors[0]
        if (!vector || rows.length === 0) return { scored: [], pending: 0 }
        const keys = rows.map(keyOf)
        const hashes = new Map(rows.map((row) => [keyOf(row), MessagingSearch.hash(content(row))]))
        const cached = yield* Effect.forEach(MessagingGraph.chunks(keys, 500), (chunk) =>
          db
            .select()
            .from(MessagingVectorTable)
            .where(
              and(
                eq(MessagingVectorTable.source, source),
                eq(MessagingVectorTable.model, model),
                inArray(MessagingVectorTable.key, chunk),
              ),
            )
            .all()
            .pipe(Effect.orDie),
        )
        // A vector of other dimensions came from the same model under other settings; it is embedded again.
        const vectors = new Map<string, Float32Array>(
          cached
            .flat()
            .filter((row) => hashes.get(row.key) === row.hash && row.dimensions === vector.length)
            .map((row) => [row.key, MessagingSearch.fromBytes(row.vector)]),
        )
        const missing = rows.filter((row) => !vectors.has(keyOf(row))).slice(0, SEMANTIC_EMBED_LIMIT)
        if (missing.length > 0) {
          const embedded = yield* embedding.embed(missing.map(content), "document")
          const now = Date.now()
          yield* Effect.forEach(
            missing,
            (row, index) => {
              const value = embedded.vectors[index]
              if (!value) return Effect.void
              vectors.set(keyOf(row), value)
              return db
                .insert(MessagingVectorTable)
                .values({
                  source,
                  key: keyOf(row),
                  model: embedded.model,
                  hash: hashes.get(keyOf(row)) ?? "",
                  dimensions: value.length,
                  vector: MessagingSearch.toBytes(value),
                  time_created: now,
                })
                .onConflictDoUpdate({
                  target: [MessagingVectorTable.source, MessagingVectorTable.key, MessagingVectorTable.model],
                  set: {
                    hash: hashes.get(keyOf(row)) ?? "",
                    dimensions: value.length,
                    vector: MessagingSearch.toBytes(value),
                    time_created: now,
                  },
                })
                .run()
                .pipe(Effect.orDie, Effect.asVoid)
            },
            { discard: true },
          )
        }
        const scored = rows
          .flatMap((row) => {
            const value = vectors.get(keyOf(row))
            return value ? [{ row, score: MessagingSearch.cosine(vector, value) }] : []
          })
          .sort((left, right) => right.score - left.score)
        // Nearest neighbours always exist; keep only those reasonably close to the best match.
        const floor = Math.max(
          MessagingSearch.SEMANTIC_FLOOR,
          (scored[0]?.score ?? 0) * MessagingSearch.SEMANTIC_RELATIVE,
        )
        return { scored: scored.filter((item) => item.score >= floor), pending: rows.length - vectors.size }
      })

    /** Effective hidden flags for the viewer, matching the SQL visibility rules. */
    const effectiveHidden = Effect.fnUntraced(function* (
      rows: ReadonlyArray<MessageRow>,
      viewer: string,
      requested: ReadonlyArray<string> | undefined,
    ) {
      if (rows.length === 0) return new Set<number>()
      const flagged = yield* db
        .select({ id: MessagingMessageTable.id, hidden: hiddenSql(viewer, hiddenKinds(requested)) })
        .from(MessagingMessageTable)
        .where(
          inArray(
            MessagingMessageTable.id,
            rows.map((row) => row.id),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return new Set(flagged.filter((row) => Number(row.hidden) === 1).map((row) => row.id))
    })

    const markRead = Effect.fnUntraced(function* (viewer: string, rows: ReadonlyArray<MessageRow>) {
      const now = Date.now()
      const latest = new Map<number, number>()
      for (const row of rows) latest.set(row.topic_id, Math.max(latest.get(row.topic_id) ?? 0, row.seq))
      yield* Effect.forEach(
        latest,
        ([topicID, seq]) =>
          db
            .insert(MessagingParticipantTable)
            .values({
              topic_id: topicID,
              session_id: viewer,
              reads: 1,
              last_read_seq: seq,
              time_first_read: now,
              time_last_read: now,
            })
            .onConflictDoUpdate({
              target: [MessagingParticipantTable.topic_id, MessagingParticipantTable.session_id],
              set: {
                reads: sql`${MessagingParticipantTable.reads} + 1`,
                last_read_seq: sql`max(${MessagingParticipantTable.last_read_seq}, ${seq})`,
                time_first_read: sql`coalesce(${MessagingParticipantTable.time_first_read}, ${now})`,
                time_last_read: now,
              },
            })
            .run()
            .pipe(Effect.orDie),
        { discard: true },
      )
    })

    const requireTopic = Effect.fnUntraced(function* (argument: string, actor: string, options?: Options) {
      const resolved = yield* resolveTopic(argument, actor, options)
      const row = yield* topicByName(resolved.name)
      if (!row) return yield* new NotFoundError({ message: `Topic ${resolved.name} does not exist yet` })
      return { resolved, row }
    })

    const opsFor = Effect.fnUntraced(function* (topicID: number, seq?: number) {
      const rows = yield* db
        .select()
        .from(MessagingMessageTable)
        .where(
          and(eq(MessagingMessageTable.topic_id, topicID), inArray(MessagingMessageTable.kind, ["delete", "restore"])),
        )
        .orderBy(asc(MessagingMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      return rows.flatMap((row): Contract.Op[] => {
        const meta = opMeta(row.meta)
        if (seq !== undefined && !meta.default && !meta.targets.includes(seq)) return []
        return [
          {
            seq: row.seq,
            kind: row.kind,
            writer: row.writer,
            time: row.time_created,
            viewers: meta.viewers,
            ...(meta.reason ? { reason: meta.reason } : {}),
          },
        ]
      })
    })

    const inspect: Interface["inspect"] = Effect.fn("Messaging.inspect")(function* (input, requested) {
      const options = yield* resolveOptions(requested, input.as ?? "user")
      const viewer = input.as ?? "user"
      const topic = yield* requireTopic(input.topic, viewer, options)
      const row = yield* db
        .select()
        .from(MessagingMessageTable)
        .where(and(eq(MessagingMessageTable.topic_id, topic.row.id), eq(MessagingMessageTable.seq, input.seq)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ message: `${topic.row.name} has no message ${input.seq}` })
      const hidden = yield* effectiveHidden([row], viewer, [row.kind])
      return toMessage(row, topic.row.name, { hidden: hidden.has(row.id), ops: yield* opsFor(topic.row.id, row.seq) })
    })

    const visibility: Interface["visibility"] = Effect.fn("Messaging.visibility")(function* (input, requested) {
      const options = yield* resolveOptions(requested, input.as ?? "user")
      const actor = input.as ?? "user"
      const topic = yield* requireTopic(input.topic, actor, options)
      const targets = Array.from(new Set(input.seqs ?? [])).sort((left, right) => left - right)
      const invalidTargets = targets.filter((seq) => seq > topic.row.last_seq)
      if (invalidTargets.length > 0)
        return yield* new NotFoundError({ message: `${topic.row.name} has no message ${invalidTargets.join(", ")}` })
      const viewers =
        input.for && input.for.length > 0 ? Array.from(yield* MessagingGraph.expand(db, input.for, actor)) : [actor]
      if (viewers.length === 0) return yield* new InvalidError({ message: "No viewers matched" })
      const hide = input.action === "hide"
      const kind = hide ? "delete" : "restore"
      const scope = targets.length === 0 ? `default for ${topic.row.name}` : targets.map((seq) => `#${seq}`).join(", ")
      const data = `${hide ? "Hid" : "Restored"} ${scope} for ${viewers.map((viewer) => (viewer === "*" ? "everyone" : viewer)).join(", ")}${input.reason ? `: ${input.reason}` : ""}`
      const message = yield* append(topic.row, {
        kind,
        type: kind,
        writer: actor,
        data,
        meta: { targets, viewers, default: targets.length === 0, ...(input.reason ? { reason: input.reason } : {}) },
      })
      const now = Date.now()
      yield* Effect.forEach(
        (targets.length === 0 ? [0] : targets).flatMap((seq) => viewers.map((viewer) => ({ seq, viewer }))),
        (item) =>
          db
            .insert(MessagingVisibilityTable)
            .values({
              topic_id: topic.row.id,
              seq: item.seq,
              viewer: item.viewer,
              hidden: hide,
              by: actor,
              op_seq: message.seq,
              time_updated: now,
            })
            .onConflictDoUpdate({
              target: [
                MessagingVisibilityTable.topic_id,
                MessagingVisibilityTable.seq,
                MessagingVisibilityTable.viewer,
              ],
              set: { hidden: hide, by: actor, op_seq: message.seq, time_updated: now },
            })
            .run()
            .pipe(Effect.orDie),
        { discard: true },
      )
      yield* announce(topic.row, message, { kind, type: kind, writer: actor, data })
      return { topic: topic.row.name, seq: message.seq, targets, viewers, default: targets.length === 0 }
    })

    const describe = Effect.fnUntraced(function* (
      name: string,
      row: TopicRow | undefined,
      viewer: string,
      expand: number | undefined,
      options: Options | undefined,
    ) {
      const classified = MessagingTemplate.classify(name, options?.config)
      const policy = row?.mode
        ? row.mode === "open"
          ? "anyone writes"
          : row.mode === "readonly"
            ? `read-only: only ${row.owner ?? row.creator} and its ancestors write`
            : `limited to ${(row.writers ?? []).map(describeWriter).join(", ") || row.owner || row.creator}`
        : MessagingVars.policyText[classified.policy]
      const mode = row?.mode ?? defaultMode(classified.policy)
      const participant =
        row && viewer !== "user"
          ? yield* db
              .select()
              .from(MessagingParticipantTable)
              .where(
                and(eq(MessagingParticipantTable.topic_id, row.id), eq(MessagingParticipantTable.session_id, viewer)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
      const subscription =
        row && viewer !== "user"
          ? yield* db
              .select()
              .from(MessagingSubscriptionTable)
              .where(
                and(eq(MessagingSubscriptionTable.topic_id, row.id), eq(MessagingSubscriptionTable.session_id, viewer)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
      const unread =
        row && viewer !== "user"
          ? yield* db
              .select({ count: sql<number>`count(*)` })
              .from(MessagingMessageTable)
              .where(
                and(
                  eq(MessagingMessageTable.topic_id, row.id),
                  sql`${MessagingMessageTable.seq} > ${participant?.last_read_seq ?? 0}`,
                  sql`${MessagingMessageTable.writer} <> ${viewer}`,
                  sql`${hiddenSql(viewer, hiddenKinds(undefined))} = 0`,
                ),
              )
              .get()
              .pipe(
                Effect.orDie,
                Effect.map((result) => Number(result?.count ?? 0)),
              )
          : undefined
      const windows = row && expand && expand > 0 ? yield* participantWindows(row, expand) : undefined
      const owner = row?.owner ?? classified.owner
      const preset = row?.preset ?? classified.preset
      const topic: Contract.Topic = {
        name,
        exists: row !== undefined,
        kind: row?.kind ?? classified.kind,
        ...(preset ? { preset } : {}),
        ...(owner ? { owner } : {}),
        ...(row?.creator ? { creator: row.creator } : {}),
        ...(row?.description ? { description: row.description } : {}),
        mode,
        writers: row?.writers ?? [],
        policy,
        messages: row?.last_seq ?? 0,
        ...(row ? { created: row.time_created } : {}),
        ...(row?.time_last ? { last: row.time_last } : {}),
        ...(unread !== undefined ? { unread } : {}),
        ...(subscription ? { subscribed: subscription.delivery } : {}),
        ...(windows ?? {}),
      }
      return topic
    })

    const participantWindows = Effect.fnUntraced(function* (row: TopicRow, size: number) {
      const p = MessagingParticipantTable
      const all = yield* db.select().from(p).where(eq(p.topic_id, row.id)).all().pipe(Effect.orDie)
      const names = yield* titles(all.map((item) => item.session_id))
      const toParticipant = (item: typeof p.$inferSelect, first: number | null, last: number | null) => ({
        session: item.session_id,
        ...(names.get(item.session_id) ? { title: names.get(item.session_id) } : {}),
        reads: item.reads,
        writes: item.writes,
        ...(first ? { first } : {}),
        ...(last ? { last } : {}),
      })
      const window = (
        items: ReadonlyArray<typeof p.$inferSelect>,
        first: (item: typeof p.$inferSelect) => number | null,
        last: (item: typeof p.$inferSelect) => number | null,
      ): Contract.Window => ({
        total: items.length,
        first: items
          .toSorted((left, right) => (first(left) ?? 0) - (first(right) ?? 0))
          .slice(0, size)
          .map((item) => toParticipant(item, first(item), last(item))),
        latest: items
          .toSorted((left, right) => (last(right) ?? 0) - (last(left) ?? 0))
          .slice(0, size)
          .map((item) => toParticipant(item, first(item), last(item))),
      })
      const writers = all.filter((item) => item.writes > 0)
      const readers = all.filter((item) => item.writes === 0 && item.reads > 0)
      const allowed = row.mode === "limited" ? yield* allowedSessions(row) : undefined
      return {
        writersWindow: window(
          writers,
          (item) => item.time_first_write,
          (item) => item.time_last_write,
        ),
        readersWindow: window(
          readers,
          (item) => item.time_first_read,
          (item) => item.time_last_read,
        ),
        ...(allowed
          ? {
              allowedWindow: {
                total: allowed.length,
                first: allowed.slice(0, size).map((item) => ({
                  session: item.id,
                  ...(item.title ? { title: item.title } : {}),
                  reads: 0,
                  writes: 0,
                  first: item.time_created,
                })),
                latest: allowed
                  .toReversed()
                  .slice(0, size)
                  .map((item) => ({
                    session: item.id,
                    ...(item.title ? { title: item.title } : {}),
                    reads: 0,
                    writes: 0,
                    first: item.time_created,
                  })),
              },
            }
          : {}),
      }
    })

    /** Sessions a limited-writer topic allows, oldest first. */
    const allowedSessions = Effect.fnUntraced(function* (row: TopicRow) {
      const ids = new Set<string>()
      if (row.owner) ids.add(row.owner)
      for (const entry of row.writers ?? []) {
        ids.add(entry.session)
        if (entry.children) for (const child of yield* MessagingGraph.descendants(db, entry.session)) ids.add(child.id)
        if (entry.ancestors) for (const parent of yield* MessagingGraph.ancestors(db, entry.session)) ids.add(parent.id)
      }
      const rows = yield* Effect.forEach(Array.from(ids), (id) => MessagingGraph.row(db, id))
      return rows
        .filter((item): item is MessagingGraph.Row => item !== undefined)
        .toSorted((left, right) => left.time_created - right.time_created)
    })

    const settings: Interface["settings"] = Effect.fn("Messaging.settings")(function* (input, requested) {
      const options = yield* resolveOptions(requested, input.as ?? "user")
      const actor = input.as ?? "user"
      const resolved = yield* resolveTopic(input.topic, actor, options)
      const existing = yield* topicByName(resolved.name)
      const ensured = existing ? { row: existing } : yield* ensureTopic(resolved, actor)
      const writers = input.writers
        ? yield* Effect.forEach(input.writers, (entry) =>
            MessagingGraph.alias(db, entry.session, actor).pipe(
              Effect.map((session) => ({ ...entry, session: session ?? entry.session })),
            ),
          )
        : undefined
      yield* db
        .update(MessagingTopicTable)
        .set({
          ...(input.mode ? { mode: input.mode } : {}),
          ...(writers ? { writers } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          time_updated: Date.now(),
        })
        .where(eq(MessagingTopicTable.id, ensured.row.id))
        .run()
        .pipe(Effect.orDie)
      const changes = [
        input.mode ? `mode ${input.mode}` : undefined,
        writers ? `writers ${writers.map(describeWriter).join(", ") || "none"}` : undefined,
        input.description !== undefined ? "description" : undefined,
      ].filter((item) => item !== undefined)
      if (changes.length > 0) {
        const data = `Changed ${changes.join(", ")}`
        const message = yield* append(ensured.row, {
          kind: "settings",
          type: "settings",
          writer: actor,
          data,
          meta: {
            ...(input.mode ? { mode: input.mode } : {}),
            ...(writers ? { writers } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          },
        })
        yield* announce(ensured.row, message, { kind: "settings", type: "settings", writer: actor, data })
      }
      return yield* describe(resolved.name, yield* topicByName(resolved.name), actor, undefined, options)
    })

    const subscribe: Interface["subscribe"] = Effect.fn("Messaging.subscribe")(function* (input, requested) {
      const options = yield* resolveOptions(requested, input.as)
      const resolved = yield* resolveTopic(input.topic, input.as, options)
      const existing = yield* topicByName(resolved.name)
      if (input.remove) {
        if (existing)
          yield* db
            .delete(MessagingSubscriptionTable)
            .where(
              and(
                eq(MessagingSubscriptionTable.topic_id, existing.id),
                eq(MessagingSubscriptionTable.session_id, input.as),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        return yield* describe(resolved.name, existing, input.as, undefined, options)
      }
      const ensured = existing ? { row: existing } : yield* ensureTopic(resolved, input.as)
      yield* db
        .insert(MessagingSubscriptionTable)
        .values({
          topic_id: ensured.row.id,
          session_id: input.as,
          delivery: input.delivery ?? "inbox",
          by: input.as,
          time_created: Date.now(),
        })
        .onConflictDoUpdate({
          target: [MessagingSubscriptionTable.topic_id, MessagingSubscriptionTable.session_id],
          set: { delivery: input.delivery ?? "inbox" },
        })
        .run()
        .pipe(Effect.orDie)
      return yield* describe(resolved.name, ensured.row, input.as, undefined, options)
    })

    const topic: Interface["topic"] = Effect.fn("Messaging.topic")(function* (input, requested) {
      const options = yield* resolveOptions(requested, input.as ?? "user")
      const viewer = input.as ?? "user"
      const resolved = yield* resolveTopic(input.topic, viewer, options)
      return yield* describe(resolved.name, yield* topicByName(resolved.name), viewer, input.expand, options)
    })

    const topics: Interface["topics"] = Effect.fn("Messaging.topics")(function* (input, requested) {
      const options = yield* resolveOptions(requested, input.as ?? "user")
      const viewer = input.as ?? "user"
      const t = MessagingTopicTable
      const conditions: SQL[] = []
      if (input.topics && input.topics.length > 0) {
        const names = yield* Effect.forEach(input.topics, (item) =>
          resolveTopic(item, viewer, options).pipe(Effect.map((resolved) => resolved.name)),
        )
        conditions.push(inArray(t.name, names))
      }
      if (input.kinds && input.kinds.length > 0) conditions.push(inArray(t.kind, Array.from(input.kinds)))
      if (input.search) conditions.push(sql`instr(lower(${t.name}), lower(${input.search})) > 0`)
      if (input.sessions && input.sessions.length > 0) {
        const ids = Array.from(yield* MessagingGraph.expand(db, input.sessions, viewer))
        const role = input.role ?? "any"
        const participant =
          role === "writer" ? sql`p.writes > 0` : role === "reader" ? sql`p.writes = 0 AND p.reads > 0` : sql`1`
        const inIDs =
          ids.length === 0
            ? sql`0`
            : sql`IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})`
        conditions.push(
          role === "subscriber"
            ? sql`${t.id} IN (SELECT s.topic_id FROM messaging_subscription s WHERE s.session_id ${inIDs})`
            : role === "any"
              ? (or(
                  sql`${t.id} IN (SELECT p.topic_id FROM messaging_participant p WHERE p.session_id ${inIDs})`,
                  sql`${t.id} IN (SELECT s.topic_id FROM messaging_subscription s WHERE s.session_id ${inIDs})`,
                ) ?? sql`1`)
              : sql`${t.id} IN (SELECT p.topic_id FROM messaging_participant p WHERE p.session_id ${inIDs} AND ${participant})`,
        )
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined
      const sort = input.sort === "created" ? t.time_created : t.time_last
      const order = input.order ?? "desc"
      const limit = pageLimit(input.limit, 50)
      const offset = normalizeOffset(input.offset)
      const rows = yield* db
        .select()
        .from(t)
        .where(where)
        .orderBy(
          order === "asc" ? sql`${sort} ASC NULLS FIRST` : sql`${sort} DESC NULLS LAST`,
          order === "asc" ? asc(t.id) : desc(t.id),
        )
        .limit(limit)
        .offset(offset)
        .all()
        .pipe(Effect.orDie)
      const total = yield* db
        .select({ count: sql<number>`count(*)` })
        .from(t)
        .where(where)
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((result) => Number(result?.count ?? 0)),
        )
      const described = yield* Effect.forEach(rows, (row) => describe(row.name, row, viewer, input.expand, options))
      const standard =
        input.standard && viewer !== "user"
          ? yield* Effect.gen(function* () {
              const known = new Set(described.map((item) => item.name))
              const names = (yield* standardNames(viewer, options)).filter((item) => !known.has(item.name))
              return yield* Effect.forEach(names, (item) =>
                Effect.gen(function* () {
                  return yield* describe(item.name, yield* topicByName(item.name), viewer, input.expand, options)
                }),
              )
            })
          : []
      return { topics: [...described, ...standard], total: total + standard.filter((item) => !item.exists).length }
    })

    const nodeOf = Effect.fnUntraced(function* (
      row: MessagingGraph.Row,
      depth: number,
      detail: "brief" | "full",
      expand: number | undefined,
      active: ReadonlySet<string>,
    ) {
      const base: Contract.SessionNode = {
        id: row.id,
        ...(row.title ? { title: row.title } : {}),
        ...(row.parent_id ? { parentID: row.parent_id } : {}),
        depth,
        ...(row.agent ? { agent: row.agent } : {}),
        directory: row.directory,
        status: active.has(row.id) ? "running" : "idle",
      }
      const full =
        detail === "full"
          ? yield* Effect.gen(function* () {
              const children = yield* db
                .select({ count: sql<number>`count(*)` })
                .from(SessionTable)
                .where(sql`${SessionTable.parent_id} = ${row.id}`)
                .get()
                .pipe(Effect.orDie)
              const messages = yield* db
                .select({ count: sql<number>`count(*)` })
                .from(SessionMessageTable)
                .where(sql`${SessionMessageTable.session_id} = ${row.id}`)
                .get()
                .pipe(Effect.orDie)
              const topicCount = yield* db
                .select({ count: sql<number>`count(*)` })
                .from(MessagingParticipantTable)
                .where(eq(MessagingParticipantTable.session_id, row.id))
                .get()
                .pipe(Effect.orDie)
              const original = yield* MessagingGraph.originalDirectory(db, row.id)
              return {
                ...(row.model ? { model: `${row.model.providerID}/${row.model.id}` } : {}),
                project: row.project_id,
                ...(original && original !== row.directory ? { original } : {}),
                created: row.time_created,
                updated: row.time_updated,
                ...(row.idle_outcome ? { outcome: row.idle_outcome } : {}),
                children: Number(children?.count ?? 0),
                descendants: (yield* MessagingGraph.descendants(db, row.id)).length,
                messages: Number(messages?.count ?? 0),
                cost: row.cost,
                tokens:
                  row.tokens_input +
                  row.tokens_output +
                  row.tokens_reasoning +
                  row.tokens_cache_read +
                  row.tokens_cache_write,
                topics: Number(topicCount?.count ?? 0),
              }
            })
          : {}
      const window = expand && expand > 0 ? yield* childWindow(row.id, expand, active) : undefined
      return { ...base, ...full, ...(window ? { childWindow: window } : {}) }
    })

    const childWindow = Effect.fnUntraced(function* (id: string, size: number, active: ReadonlySet<string>) {
      const all = yield* MessagingGraph.children(db, id)
      const brief = (row: MessagingGraph.Row): Contract.SessionBrief => ({
        id: row.id,
        ...(row.title ? { title: row.title } : {}),
        ...(row.agent ? { agent: row.agent } : {}),
        status: active.has(row.id) ? "running" : "idle",
        created: row.time_created,
        updated: row.time_updated,
      })
      return {
        total: all.length,
        first: all.slice(0, size).map(brief),
        latest: all.toReversed().slice(0, size).map(brief),
      }
    })

    const chain: Interface["chain"] = Effect.fn("Messaging.chain")(function* (input) {
      const self = yield* MessagingGraph.row(db, input.session)
      if (!self) return yield* new NotFoundError({ message: `Session not found: ${input.session}` })
      const lineage = yield* MessagingGraph.ancestors(db, self.id)
      const full = [self, ...lineage]
      const depth = input.depth ?? "parent"
      const selected = depth === "self" ? full.slice(0, 1) : depth === "parent" ? full.slice(0, 2) : full
      const active = new Set<string>(yield* sessions.active)
      const nodes = yield* Effect.forEach(selected, (row, index) =>
        nodeOf(row, lineage.length - index, input.detail ?? "brief", input.expand, active),
      )
      return { chain: nodes, root: full.at(-1)?.id ?? self.id, depth: lineage.length }
    })

    const sessionsList: Interface["sessions"] = Effect.fn("Messaging.sessions")(function* (input) {
      const s = SessionTable
      const viewer = input.as ?? "user"
      const now = Date.now()
      const conditions: SQL[] = []
      if (input.ids && input.ids.length > 0) {
        const ids = Array.from(yield* MessagingGraph.expand(db, input.ids, viewer))
        conditions.push(
          ids.length === 0
            ? sql`0`
            : sql`${s.id} IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})`,
        )
      }
      if (input.parent === "none" || input.parent === "null") conditions.push(isNull(s.parent_id))
      if (input.parent && input.parent !== "none" && input.parent !== "null") {
        const parent = yield* MessagingGraph.alias(db, input.parent, viewer)
        conditions.push(parent ? sql`${s.parent_id} = ${parent}` : sql`0`)
      }
      if (input.ancestor) {
        const ancestor = yield* MessagingGraph.alias(db, input.ancestor, viewer)
        const ids = ancestor ? (yield* MessagingGraph.descendants(db, ancestor)).map((row): string => row.id) : []
        conditions.push(
          ids.length === 0
            ? sql`0`
            : sql`${s.id} IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})`,
        )
      }
      if (input.project) conditions.push(sql`${s.project_id} = ${input.project}`)
      if (input.directory) conditions.push(sql`${s.directory} = ${path.resolve(input.directory)}`)
      if (input.agent) conditions.push(sql`${s.agent} = ${input.agent}`)
      if (input.search) conditions.push(sql`instr(lower(coalesce(${s.title}, '')), lower(${input.search})) > 0`)
      const active = new Set<string>(yield* sessions.active)
      if (input.active !== undefined) {
        const ids = Array.from(active)
        conditions.push(
          input.active
            ? ids.length === 0
              ? sql`0`
              : sql`${s.id} IN (${sql.join(
                  ids.map((id) => sql`${id}`),
                  sql`, `,
                )})`
            : ids.length === 0
              ? sql`1`
              : sql`${s.id} NOT IN (${sql.join(
                  ids.map((id) => sql`${id}`),
                  sql`, `,
                )})`,
        )
      }
      const sortColumn = input.sort === "created" ? s.time_created : s.time_updated
      const since = input.since ? MessagingTemplate.parseTime(input.since, now) : undefined
      const until = input.until ? MessagingTemplate.parseTime(input.until, now) : undefined
      if (since !== undefined) conditions.push(sql`${sortColumn} >= ${since}`)
      if (until !== undefined) conditions.push(sql`${sortColumn} <= ${until}`)
      const where = conditions.length > 0 ? and(...conditions) : undefined
      const order = input.order ?? "desc"
      const offset = normalizeOffset(input.offset)
      const rows = yield* db
        .select()
        .from(s)
        .where(where)
        // Session IDs sort newest first, so ties on time break toward creation order with the opposite ID order.
        .orderBy(order === "asc" ? asc(sortColumn) : desc(sortColumn), order === "asc" ? desc(s.id) : asc(s.id))
        .limit(pageLimit(input.limit, 50))
        .offset(offset)
        .all()
        .pipe(Effect.orDie)
      const total = yield* db
        .select({ count: sql<number>`count(*)` })
        .from(s)
        .where(where)
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((result) => Number(result?.count ?? 0)),
        )
      const nodes = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const depth = (yield* MessagingGraph.ancestors(db, row.id)).length
          return yield* nodeOf(row, depth, input.detail ?? "brief", input.expand, active)
        }),
      )
      return { sessions: nodes, total }
    })

    const log: Interface["log"] = Effect.fn("Messaging.log")(function* (input, requested) {
      const options = yield* resolveOptions(requested, input.as ?? "user")
      const viewer = input.as ?? "user"
      const now = Date.now()
      const ids = Array.from(yield* MessagingGraph.expand(db, input.sessions, viewer)).filter((id) =>
        id.startsWith("ses"),
      )
      if (ids.length === 0) return yield* new InvalidError({ message: "No sessions matched" })
      const parts = new Set(input.include && input.include.length > 0 ? input.include : MessagingLog.defaultParts)
      const loaded = yield* Effect.forEach(ids, (id) =>
        Effect.gen(function* () {
          if (!(yield* MessagingGraph.row(db, id)))
            return yield* new NotFoundError({ message: `Session not found: ${id}` })
          const messages =
            input.scope === "context"
              ? // What the model sees: user-only notices never reach it.
                (yield* SessionHistory.load(db, SessionSchema.ID.make(id), "latest").pipe(Effect.orDie)).filter(
                  (message) => !(message.type === "synthetic" && message.metadata?.audience === "user"),
                )
              : yield* db
                  .select()
                  .from(SessionMessageTable)
                  .where(sql`${SessionMessageTable.session_id} = ${id}`)
                  .orderBy(asc(SessionMessageTable.seq))
                  .all()
                  .pipe(
                    Effect.orDie,
                    Effect.flatMap((rows) =>
                      Effect.forEach(rows, (row) =>
                        SessionHistory.decodeMessageRow(row).pipe(
                          Effect.map((message) => [message]),
                          Effect.orElseSucceed(() => []),
                        ),
                      ),
                    ),
                    Effect.map((items) => items.flat()),
                  )
          return MessagingLog.entries(id, messages, parts)
        }),
      )
      const since = input.since ? MessagingTemplate.parseTime(input.since, now) : undefined
      const until = input.until ? MessagingTemplate.parseTime(input.until, now) : undefined
      const all = loaded
        .flat()
        .filter((entry) => (since === undefined || entry.time >= since) && (until === undefined || entry.time <= until))
        .sort((left, right) => left.time - right.time)
      const op = input.op ?? (input.query ? "search" : "tail")
      const limit = pageLimit(input.limit, op === "pull" ? 50 : DEFAULT_LIMIT)
      const offset = normalizeOffset(input.offset)
      const chars = normalizeChars(input.chars, op === "pull" ? 4000 : 500)
      const keyOf = (entry: MessagingLog.Entry) => `${entry.message}:${entry.index}:${entry.part}`
      const output = (
        entries: ReadonlyArray<MessagingLog.Entry & { readonly match?: boolean; readonly score?: number }>,
      ) =>
        entries.map(
          (entry): Contract.LogEntry => ({
            session: entry.session,
            message: entry.message,
            index: entry.index,
            part: entry.part,
            time: entry.time,
            text: MessagingLog.clip(entry.label ? `${entry.label}: ${entry.text}` : entry.text, chars),
            ...(entry.tool ? { tool: entry.tool } : {}),
            ...(entry.match !== undefined ? { match: entry.match } : {}),
            ...(entry.score !== undefined ? { score: round(entry.score) } : {}),
          }),
        )
      if (op === "head" || op === "pull") {
        const page = all.slice(offset, offset + limit)
        return { entries: output(page), total: all.length, more: offset + limit < all.length }
      }
      if (op === "tail") {
        const end = Math.max(0, all.length - offset)
        const page = all.slice(Math.max(0, end - limit), end)
        return { entries: output(page), total: all.length, more: end - limit > 0 }
      }
      if (!input.query) return yield* new InvalidError({ message: `${op} needs a query` })
      if (op === "grep") {
        if (input.query.length > MessagingSearch.MAX_PATTERN)
          return yield* new InvalidError({
            message: `Regular expressions are limited to ${MessagingSearch.MAX_PATTERN} characters`,
          })
        const result = yield* MessagingSearch.regexFilter(
          input.query,
          all.map((entry, index) => ({ entry, index })),
          (item) => item.entry.text,
        )
        const hits = result.matched.map((item) => item.index)
        const context = normalizeContext(input.context)
        const selected = new Map<number, boolean>()
        for (const index of hits.slice(offset, offset + limit)) {
          for (let near = Math.max(0, index - context); near <= Math.min(all.length - 1, index + context); near++)
            if (!selected.has(near)) selected.set(near, false)
          selected.set(index, true)
        }
        const entries = Array.from(selected)
          .sort((left, right) => left[0] - right[0])
          .map(([index, match]) => ({ ...all[index], ...(context > 0 ? { match } : {}) }))
        return {
          entries: output(entries),
          total: hits.length,
          more: offset + limit < hits.length,
          ...(result.unchecked > 0
            ? {
                note: `The pattern took too long to match; the last ${result.unchecked} entries were not checked. Simplify it or narrow the range.`,
              }
            : {}),
        }
      }
      const match = input.match ?? options?.config?.search?.match ?? "hybrid"
      // Newest first: ties and the per-search embedding budget favour recent entries.
      const recent = all.toReversed()
      const needle = input.query.toLowerCase()
      const ranked = yield* rank(
        input.query,
        match,
        {
          exact: () => Effect.succeed(recent.filter((entry) => entry.text.toLowerCase().includes(needle))),
          fuzzy: () => Effect.succeed(recent),
          all: () => Effect.succeed(recent),
        },
        (entry) => entry.text,
        keyOf,
        "log",
        offset + limit,
        options,
      )
      const scored = ranked.rows.slice(offset).map((entry) => ({ ...entry, score: ranked.scores.get(keyOf(entry)) }))
      return {
        entries: output(scored),
        total: ranked.total,
        more: ranked.more,
        match: ranked.match,
        ...(ranked.note ? { note: ranked.note } : {}),
      }
    })

    const varsList: Interface["vars"] = Effect.fn("Messaging.vars")(function* (input, requested) {
      const options = yield* resolveOptions(requested, input.as ?? "user")
      const scope = yield* scopeFor(input.as ?? "user", options)
      const listed = yield* vars.list(scope, input.values ?? false)
      const rendered = input.render ? yield* vars.render(input.render, scope).pipe(Effect.mapError(invalid)) : undefined
      return { ...listed, ...(rendered !== undefined ? { rendered } : {}) }
    })

    const setVar: Interface["setVar"] = Effect.fn("Messaging.setVar")(function* (input) {
      const actor = input.as ?? "user"
      const target = input.scope === "global" ? "global" : yield* MessagingGraph.alias(db, input.scope ?? "self", actor)
      if (!target) return yield* new InvalidError({ message: `Unknown variable scope: ${input.scope}` })
      if (target !== "global" && target !== "user" && !(yield* MessagingGraph.row(db, target)))
        return yield* new NotFoundError({ message: `Session not found: ${target}` })
      yield* vars
        .set({
          scope: target,
          name: input.name,
          ...(input.value !== undefined ? { value: input.value } : {}),
          by: actor,
        })
        .pipe(Effect.mapError(invalid))
    })

    const service = Service.of({
      send,
      user,
      query,
      inspect,
      visibility,
      settings,
      subscribe,
      topic,
      topics,
      chain,
      sessions: sessionsList,
      log,
      vars: varsList,
      setVar,
      kinds: {
        register: Effect.fn("Messaging.kinds.register")(function* (definition: KindDefinition) {
          if (!/^[a-z][a-z0-9_.-]*$/.test(definition.name) || kinds.has(definition.name))
            return yield* new InvalidError({ message: `Cannot register message kind ${definition.name}` })
          kinds.set(definition.name, definition)
          yield* Effect.addFinalizer(() => Effect.sync(() => kinds.delete(definition.name)))
        }),
        list: () => Effect.sync(() => Array.from(kinds.values())),
      },
      reranker: {
        register: Effect.fn("Messaging.reranker.register")(function* (
          rerank: (viewer: string) => Rerank,
          directory?: string,
        ) {
          const entry = { rerank, ...(directory !== undefined ? { directory } : {}) }
          rerankers.push(entry)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              const index = rerankers.lastIndexOf(entry)
              if (index !== -1) rerankers.splice(index, 1)
            }),
          )
        }),
      },
    })

    yield* indexer(db, embedding, written).pipe(Effect.forkScoped)
    return service
  }),
)

/**
 * Embeds messages in the background once a model is usable, so semantic search rarely embeds on
 * demand. New messages wake it; otherwise it sweeps the backlog every few minutes.
 */
const indexer = (
  db: Database.Interface["db"],
  embedding: MessagingEmbedding.Interface,
  written: PubSub.PubSub<{ readonly topicID: number; readonly seq: number }>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(written)
      const sweep: Effect.Effect<void> = Effect.gen(function* () {
        const model = yield* embedding.ready
        const pending = yield* db
          .select({ id: MessagingMessageTable.id, data: MessagingMessageTable.data })
          .from(MessagingMessageTable)
          .where(
            and(
              notInArray(MessagingMessageTable.kind, ["delete", "restore", "settings"]),
              model.dimensions === undefined
                ? sql`NOT EXISTS (SELECT 1 FROM messaging_vector v WHERE v.source = 'message' AND v.model = ${model.id} AND v.key = CAST(${MessagingMessageTable.id} AS TEXT))`
                : sql`NOT EXISTS (SELECT 1 FROM messaging_vector v WHERE v.source = 'message' AND v.model = ${model.id} AND v.key = CAST(${MessagingMessageTable.id} AS TEXT) AND v.dimensions = ${model.dimensions})`,
            ),
          )
          .orderBy(desc(MessagingMessageTable.id))
          .limit(64)
          .all()
          .pipe(Effect.orDie)
        if (pending.length === 0) return
        const embedded = yield* embedding.embed(
          pending.map((row) => row.data),
          "document",
        )
        const now = Date.now()
        yield* Effect.forEach(
          pending,
          (row, index) => {
            const vector = embedded.vectors[index]
            if (!vector) return Effect.void
            return db
              .insert(MessagingVectorTable)
              .values({
                source: "message",
                key: String(row.id),
                model: embedded.model,
                hash: MessagingSearch.hash(row.data),
                dimensions: vector.length,
                vector: MessagingSearch.toBytes(vector),
                time_created: now,
              })
              .onConflictDoUpdate({
                target: [MessagingVectorTable.source, MessagingVectorTable.key, MessagingVectorTable.model],
                set: {
                  hash: MessagingSearch.hash(row.data),
                  dimensions: vector.length,
                  vector: MessagingSearch.toBytes(vector),
                  time_created: now,
                },
              })
              .run()
              .pipe(Effect.orDie, Effect.asVoid)
          },
          { discard: true },
        )
        if (pending.length === 64) return yield* sweep
      }).pipe(
        Effect.catchTag("Messaging.EmbeddingUnavailableError", () => Effect.sleep(Duration.seconds(30))),
        Effect.catchDefect((defect) =>
          Effect.logWarning("messaging indexer sweep failed", { defect }).pipe(
            Effect.andThen(Effect.sleep(Duration.minutes(1))),
          ),
        ),
      )
      yield* Effect.forever(
        sweep.pipe(
          Effect.andThen(PubSub.take(subscription).pipe(Effect.timeoutOption(Duration.minutes(5)))),
          Effect.andThen(Effect.sleep(Duration.seconds(2))),
        ),
      )
    }),
  )

/** Reciprocal-rank fusion of lexical and semantic rankings into one ordered list. */
function fuseRankings<A>(
  lexical: ReadonlyArray<{ readonly row: A; readonly score: number }>,
  semantic: ReadonlyArray<{ readonly row: A; readonly score: number }>,
  keyOf: (row: A) => string,
) {
  const fused = MessagingSearch.fuse([lexical.map((item) => keyOf(item.row)), semantic.map((item) => keyOf(item.row))])
  const byKey = new Map([...semantic, ...lexical].map((item) => [keyOf(item.row), item.row]))
  return Array.from(fused)
    .sort((left, right) => right[1] - left[1])
    .flatMap(([key, score]) => {
      const row = byKey.get(key)
      return row ? [{ row, score }] : []
    })
}

/**
 * SQL that is 1 when the message is effectively hidden from the viewer. Hidden kinds (delete and restore
 * operations, settings changes) stay hidden unless a row targets that message itself: a topic default
 * restore must not reveal them.
 */
function hiddenSql(viewer: string, hiddenKinds: ReadonlyArray<string>) {
  const m = MessagingMessageTable
  const state = (seq: SQL, who: SQL) =>
    sql`(SELECT v.hidden FROM messaging_visibility v WHERE v.topic_id = ${m.topic_id} AND v.seq = ${seq} AND v.viewer = ${who})`
  const own = sql`${state(sql`${m.seq}`, sql`${viewer}`)}, ${state(sql`${m.seq}`, sql`'*'`)}`
  const withDefault = sql`coalesce(${own}, ${state(sql`0`, sql`${viewer}`)}, ${state(sql`0`, sql`'*'`)}, 0)`
  if (hiddenKinds.length === 0) return sql<number>`${withDefault}`
  return sql<number>`CASE WHEN ${m.kind} IN (${sql.join(
    hiddenKinds.map((kind) => sql`${kind}`),
    sql`, `,
  )}) THEN coalesce(${own}, 1) ELSE ${withDefault} END`
}

function opMeta(meta: Record<string, unknown> | null) {
  const targets = Array.isArray(meta?.targets)
    ? meta.targets.filter((item): item is number => typeof item === "number")
    : []
  const viewers = Array.isArray(meta?.viewers)
    ? meta.viewers.filter((item): item is string => typeof item === "string")
    : []
  return {
    targets,
    viewers,
    default: meta?.default === true,
    reason: typeof meta?.reason === "string" ? meta.reason : undefined,
  }
}

function toMessage(
  row: MessageRow,
  topic: string,
  extra: { readonly hidden?: boolean; readonly score?: number; readonly ops?: ReadonlyArray<Contract.Op> },
): Contract.Message {
  return {
    id: row.id,
    topic,
    seq: row.seq,
    kind: row.kind,
    type: row.type,
    writer: row.writer,
    time: row.time_created,
    data: row.data,
    ...(row.meta ? { meta: jsonRecord(row.meta) } : {}),
    ...(row.reply ? { reply: row.reply } : {}),
    ...(extra.hidden ? { hidden: true } : {}),
    ...(extra.score !== undefined ? { score: extra.score } : {}),
    ...(extra.ops ? { ops: extra.ops } : {}),
  }
}

function jsonRecord(value: Record<string, unknown>): Record<string, Schema.Json> {
  return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(value)
}

function describeWriter(entry: Contract.Writer) {
  return `${entry.session}${entry.children ? "+children" : ""}${entry.ancestors ? "+ancestors" : ""}`
}

function defaultMode(policy: MessagingTemplate.Policy): Contract.WriteMode {
  if (policy === "open") return "open"
  if (policy === "owner") return "readonly"
  return "limited"
}

function firstLine(text: string) {
  const line =
    text
      .split("\n")
      .find((item) => item.trim() !== "")
      ?.trim() ?? ""
  return line.length > 100 ? `${line.slice(0, 97)}...` : line
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000
}

/** The model-visible text and the short transcript description of a delivered message. */
function render(
  topic: string,
  message: {
    readonly seq: number
    readonly time: number
    readonly writer: string
    readonly type: string
    readonly data: string
    readonly title?: string
  },
) {
  const attributes = [
    `topic="${escapeAttribute(topic)}"`,
    `seq="${message.seq}"`,
    `from="${escapeAttribute(message.writer)}"`,
    ...(message.title ? [`from_title="${escapeAttribute(message.title)}"`] : []),
    ...(message.type !== "message" ? [`type="${escapeAttribute(message.type)}"`] : []),
    `time="${MessagingTemplate.rfc3339(new Date(message.time))}"`,
  ]
  const body =
    message.data.length > DELIVERED_CHARS
      ? `${message.data.slice(0, DELIVERED_CHARS)}\n…[${message.data.length - DELIVERED_CHARS} more characters; read ${topic}#${message.seq} for the rest]`
      : message.data
  return {
    text: `<message ${attributes.join(" ")}>\n${MessagingLog.escapeBody(body)}\n</message>`,
    description: `✉ ${message.title || message.writer} → ${topic}: ${firstLine(message.data)}`,
  }
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
}

/**
 * Creates the trigram FTS5 index over message text, idempotently: virtual tables cannot be declared
 * in the Drizzle schema, so fresh and migrated databases both get it here. Returns false when FTS5
 * is unavailable, in which case searches scan with SQL string functions instead.
 */
function setupFts(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const existed = yield* db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messaging_message_fts'`,
    )
    yield* db.run(
      sql.raw(
        `CREATE VIRTUAL TABLE IF NOT EXISTS messaging_message_fts USING fts5(data, content='messaging_message', content_rowid='id', tokenize='trigram')`,
      ),
    )
    yield* db.run(
      sql.raw(
        `CREATE TRIGGER IF NOT EXISTS messaging_message_fts_insert AFTER INSERT ON messaging_message BEGIN INSERT INTO messaging_message_fts(rowid, data) VALUES (new.id, new.data); END`,
      ),
    )
    yield* db.run(
      sql.raw(
        `CREATE TRIGGER IF NOT EXISTS messaging_message_fts_delete AFTER DELETE ON messaging_message BEGIN INSERT INTO messaging_message_fts(messaging_message_fts, rowid, data) VALUES ('delete', old.id, old.data); END`,
      ),
    )
    if (!existed) yield* db.run(sql.raw(`INSERT INTO messaging_message_fts(messaging_message_fts) VALUES ('rebuild')`))
    return true
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("messaging full-text index unavailable", { error }).pipe(Effect.as(false)),
    ),
  )
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, Bus.node, Session.node, MessagingVars.node, MessagingEmbedding.node],
})
