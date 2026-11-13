export * as MessagingVars from "./vars.js"

import os from "os"
import path from "path"
import { and, eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer, Ref } from "effect"
import type { ConfigMessaging } from "@opencode/schema/config/messaging"
import type { Messaging } from "@opencode/schema/messaging"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Database } from "../database/database.js"
import { ProjectTable } from "../project/sql.js"
import { MessagingGraph } from "./graph.js"
import { MessagingVarTable } from "./sql.js"
import { MessagingTemplate } from "./template.js"

export interface ScopeInput {
  /** Subject session ID; `user` or undefined when acting outside a session. */
  readonly session?: string
  readonly args?: Readonly<Record<string, string>>
  readonly config?: ConfigMessaging.Info
  /** Freeze time variables to the session's start, for text re-rendered on every step. */
  readonly stableTime?: boolean
}

export interface Scope {
  readonly session?: MessagingGraph.Row
  readonly actor: string
  readonly config?: ConfigMessaging.Info
  readonly args: Readonly<Record<string, string>>
  readonly resolve: (name: string) => Effect.Effect<MessagingTemplate.Resolved>
}

export interface ResolvedTopic extends MessagingTemplate.Classification {
  readonly name: string
}

export interface Interface {
  readonly scope: (input: ScopeInput) => Effect.Effect<Scope, MessagingTemplate.TemplateError>
  readonly render: (
    template: string,
    scope: Scope,
    options?: { readonly strict?: boolean },
  ) => Effect.Effect<string, MessagingTemplate.TemplateError>
  readonly topic: (argument: string, scope: Scope) => Effect.Effect<ResolvedTopic, MessagingTemplate.TemplateError>
  readonly list: (
    scope: Scope,
    values: boolean,
  ) => Effect.Effect<{ readonly presets: Messaging.Preset[]; readonly vars: Messaging.Var[] }>
  readonly set: (input: {
    readonly scope: string
    readonly name: string
    readonly value?: string
    readonly by: string
  }) => Effect.Effect<void, MessagingTemplate.TemplateError>
  /** The session-start line(s) for a session, or undefined when disabled. */
  readonly sessionStart: (
    sessionID: string,
    config?: ConfigMessaging.Info,
  ) => Effect.Effect<string | undefined, MessagingTemplate.TemplateError>
  /** Renders variables in text whose frontmatter opts in with `vars`, stripping that frontmatter. */
  readonly inject: (text: string, sessionID: string, config?: ConfigMessaging.Info) => Effect.Effect<string>
  /** Renders known variables in text for a session, leaving unknown placeholders untouched. */
  readonly expand: (
    text: string,
    sessionID: string,
    options?: { readonly config?: ConfigMessaging.Info; readonly stableTime?: boolean },
  ) => Effect.Effect<string>
  /**
   * Sets the messaging config used when a caller passes none (HTTP requests, skills, instructions). Each location's
   * plugin applies its resolved config for its directory; a session uses the config of its directory, and a caller
   * without a session uses the latest applied. An inactive directory uses the built-in defaults.
   */
  readonly configure: (config: ConfigMessaging.Info | undefined, directory?: string) => Effect.Effect<void>
  readonly config: (directory?: string) => Effect.Effect<ConfigMessaging.Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MessagingVars") {}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export const policyText: Readonly<Record<MessagingTemplate.Policy, string>> = {
  open: "anyone writes",
  owner: "only the owner session and its ancestors write",
  family: "only the family head, its subsessions and its ancestors write",
  tree: "only sessions in the root's tree write",
  roots: "only root sessions write",
  pair: "only the two linked sessions write",
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const commonDirs = new Map<string, string | undefined>()
    const configs = new Map<string, ConfigMessaging.Info | undefined>()
    const latest = yield* Ref.make<ConfigMessaging.Info | undefined>(undefined)
    const configFor = (directory: string | undefined) =>
      directory === undefined ? Ref.get(latest) : Effect.succeed(configs.get(directory))

    const commonDir = Effect.fnUntraced(function* (directory: string) {
      if (commonDirs.has(directory)) return commonDirs.get(directory)
      const found = (yield* fs.findUp(".git", directory).pipe(Effect.orElseSucceed(() => [] as string[])))[0]
      const resolved = found ? yield* gitCommonDir(fs, found) : undefined
      commonDirs.set(directory, resolved)
      return resolved
    })

    const customValues = Effect.fnUntraced(function* (session: MessagingGraph.Row | undefined) {
      const chain = session
        ? [session.id, ...(yield* MessagingGraph.ancestors(db, session.id)).map((row) => row.id)]
        : []
      const scopes = [...chain, "global"]
      const rows = yield* db
        .select()
        .from(MessagingVarTable)
        .where(inArray(MessagingVarTable.scope, scopes))
        .all()
        .pipe(Effect.orDie)
      const values = new Map<string, { value: string; scope: string }>()
      for (const scope of scopes)
        for (const item of rows)
          if (item.scope === scope && !values.has(item.name)) values.set(item.name, { value: item.value, scope })
      return values
    })

    const scope = Effect.fn("MessagingVars.scope")(function* (request: ScopeInput) {
      const session =
        request.session && request.session !== "user" ? yield* MessagingGraph.row(db, request.session) : undefined
      if (request.session && request.session !== "user" && !session)
        return yield* new MessagingTemplate.TemplateError({ message: `Session not found: ${request.session}` })
      const input = request.config ? request : { ...request, config: yield* configFor(session?.directory) }
      const args = input.args ?? {}
      const originals = new Map<string, string>()
      const chain = memoize(session ? MessagingGraph.ancestors(db, session.id) : Effect.succeed([]))
      const parent = Effect.map(chain, (rows) => rows[0] ?? session)
      const root = Effect.map(chain, (rows) => rows.at(-1) ?? session)
      const custom = memoize(customValues(session))
      const projectDir = memoize(
        session
          ? db
              .select({ worktree: ProjectTable.worktree })
              .from(ProjectTable)
              .where(eq(ProjectTable.id, session.project_id))
              .get()
              .pipe(
                Effect.orDie,
                Effect.map((project): string => project?.worktree ?? session.directory),
              )
          : Effect.succeed(undefined),
      )
      const now = input.stableTime && session ? new Date(session.time_created) : new Date()

      const original = Effect.fnUntraced(function* (row: MessagingGraph.Row) {
        const known = originals.get(row.id)
        if (known !== undefined) return known
        const value = (yield* MessagingGraph.originalDirectory(db, row.id)) ?? row.directory
        originals.set(row.id, value)
        return value
      })

      const field = (row: MessagingGraph.Row, name: string): Effect.Effect<string | undefined> => {
        const created = new Date(row.time_created)
        switch (name) {
          case "id":
            return Effect.succeed(row.id)
          case "title":
            return Effect.succeed(row.title ?? "")
          case "agent":
            return Effect.succeed(row.agent ?? "")
          case "model":
            return Effect.succeed(row.model ? `${row.model.providerID}/${row.model.id}` : "")
          case "dir":
            return Effect.succeed(row.directory)
          case "original_dir":
            return original(row)
          case "project_id":
            return Effect.succeed(row.project_id)
          case "start":
            return Effect.succeed(MessagingTemplate.rfc3339(created))
          case "start_date":
            return Effect.succeed(MessagingTemplate.localDate(created))
          case "start_date_hour":
            return Effect.succeed(MessagingTemplate.localDateHour(created))
          case "depth":
            return MessagingGraph.ancestors(db, row.id).pipe(Effect.map((rows) => String(rows.length)))
        }
        return Effect.succeed(undefined)
      }

      const sessionVariable = Effect.fnUntraced(function* (name: string) {
        const prefixes = [
          ["root_session_", root],
          ["parent_session_", parent],
          ["session_", Effect.succeed(session)],
        ] as const
        for (const [prefix, target] of prefixes) {
          if (!name.startsWith(prefix)) continue
          const key = name.slice(prefix.length)
          if (!Object.hasOwn(MessagingTemplate.sessionFields, key)) return undefined
          const value = yield* target
          return value ? yield* field(value, key) : undefined
        }
        return undefined
      })

      const fact = Effect.fnUntraced(function* (name: string) {
        if (Object.hasOwn(MessagingTemplate.timeVars, name)) return timeValue(name, now)
        const scoped = yield* sessionVariable(name)
        if (scoped !== undefined) return scoped
        switch (name) {
          case "home":
            return global.home
          case "tmp":
            return global.tmp
          case "hostname":
            return os.hostname()
          case "platform":
            return process.platform
          case "from":
            return args.from ?? session?.id
          case "to":
          case "child_id":
            return args[name] ?? args.to
        }
        if (!session) return undefined
        switch (name) {
          case "parent_id":
            return (yield* parent)?.id
          case "root_id":
            return (yield* root)?.id
          case "family_id":
            return session.parent_id ?? session.id
          case "project_id":
            return session.project_id
          case "pwd":
          case "session_dir":
            return session.directory
          case "parent_dir":
            return path.dirname(session.directory)
          case "original_dir":
            return yield* field(session, "original_dir")
          case "project_dir":
            return yield* projectDir
          case "common_dir":
            return yield* commonDir(session.directory)
          case "all_children":
            return (yield* MessagingGraph.children(db, session.id)).map((row) => row.id).join(",")
          case "all_subsessions":
            return (yield* MessagingGraph.descendants(db, session.id)).map((row) => row.id).join(",")
          case "all_root_sessions":
            return (yield* MessagingGraph.roots(db)).map((row) => row.id).join(",")
          case "session_lineage": {
            if (!session.parent_id) return ""
            const top = yield* root
            return ` Parent session: ${session.parent_id}. Root session: ${top?.id ?? session.parent_id}.`
          }
          case "dm_first":
          case "dm_second": {
            const peer = args.to
            if (!peer) return undefined
            const [first, second] = yield* pair(session.id, peer)
            return name === "dm_first" ? first : second
          }
        }
        return undefined
      })

      const pair = Effect.fnUntraced(function* (self: string, peer: string) {
        const ancestorsOfSelf = (yield* chain).map((row): string => row.id)
        if (ancestorsOfSelf.includes(peer)) return [peer, self] as const
        const ancestorsOfPeer = (yield* MessagingGraph.ancestors(db, peer)).map((row): string => row.id)
        if (ancestorsOfPeer.includes(self)) return [self, peer] as const
        return (self < peer ? [self, peer] : [peer, self]) as readonly [string, string]
      })

      const resolve = Effect.fnUntraced(function* (name: string) {
        if (Object.hasOwn(args, name) && args[name] !== undefined) return { value: args[name] }
        const value = yield* fact(name)
        if (value !== undefined) return { value }
        const defined = (yield* custom).get(name)
        if (defined) return { value: defined.value, template: true }
        const configured = MessagingTemplate.constant(name, input.config)
        if (configured !== undefined) return { value: configured, template: true }
        return undefined
      })

      return {
        session,
        actor: session?.id ?? input.session ?? "user",
        config: input.config,
        args,
        resolve,
      } satisfies Scope
    })

    const render: Interface["render"] = (template, current, options) =>
      MessagingTemplate.render(template, current.resolve, { strict: options?.strict ?? true })

    const topic = Effect.fn("MessagingVars.topic")(function* (argument: string, current: Scope) {
      const parsed = MessagingTemplate.parseTopic(argument, current.config)
      if (parsed.kind === "raw") {
        if (!parsed.value) return yield* new MessagingTemplate.TemplateError({ message: "Topic name is empty" })
        return { name: parsed.value, ...MessagingTemplate.classify(parsed.value, current.config) }
      }
      if (parsed.kind === "template") {
        const name = yield* render(parsed.value, current)
        return { name, ...MessagingTemplate.classify(name, current.config) }
      }
      const preset = parsed.preset
      const target = parsed.target ? yield* MessagingGraph.alias(db, parsed.target, current.actor) : undefined
      if (parsed.target && !target)
        return yield* new MessagingTemplate.TemplateError({ message: `Unknown session: ${parsed.target}` })
      const subject =
        target && !preset.targetsPeer
          ? yield* scope({ session: target, args: current.args, config: current.config })
          : target
            ? yield* scope({
                session: current.session?.id ?? current.actor,
                args: { ...current.args, to: target, child_id: target },
                config: current.config,
              })
            : current
      if (preset.targetsPeer && !subject.args.to)
        return yield* new MessagingTemplate.TemplateError({
          message: `Preset ${preset.name} needs a session: use ${preset.name}@<session ID>`,
        })
      const name = yield* render(preset.template, subject).pipe(
        Effect.mapError(
          (error) =>
            new MessagingTemplate.TemplateError({
              message: subject.session
                ? `Preset ${preset.name}: ${error.message}`
                : `Preset ${preset.name} needs a session context (${error.message})`,
            }),
        ),
      )
      const classified = MessagingTemplate.classify(name, current.config)
      return { name, ...classified, preset: preset.name, policy: preset.policy }
    })

    const list = Effect.fn("MessagingVars.list")(function* (current: Scope, values: boolean) {
      const value = (template: string) =>
        values
          ? render(template, current).pipe(
              Effect.map((text) => ({ value: text })),
              Effect.orElseSucceed(() => ({})),
            )
          : Effect.succeed({})
      const presets = yield* Effect.forEach(MessagingTemplate.presetList(current.config), (preset) =>
        value(preset.template).pipe(
          Effect.map(
            (rendered): Messaging.Preset => ({
              name: preset.name,
              template: preset.template,
              description: preset.description,
              policy: policyText[preset.policy],
              ...rendered,
            }),
          ),
        ),
      )
      const custom = yield* customValues(current.session)
      const constants = Object.entries({
        ...Object.fromEntries(
          Object.entries(MessagingTemplate.constants).map(([name, item]) => [name, item.description]),
        ),
        ...Object.fromEntries(
          Object.keys(current.config?.vars ?? {})
            .filter((name) => !Object.hasOwn(MessagingTemplate.constants, name))
            .map((name) => [name, "Configured variable"]),
        ),
      })
      const vars: Messaging.Var[] = [
        ...(yield* Effect.forEach(constants, ([name, description]) =>
          value(`{${name}}`).pipe(
            Effect.map(
              (rendered): Messaging.Var => ({
                name,
                kind: "constant",
                description,
                template: MessagingTemplate.constant(name, current.config) ?? "",
                ...rendered,
              }),
            ),
          ),
        )),
        ...(yield* Effect.forEach(Object.entries(MessagingTemplate.contextVars), ([name, description]) =>
          value(`{${name}}`).pipe(
            Effect.map((rendered): Messaging.Var => ({ name, kind: "context", description, ...rendered })),
          ),
        )),
        ...(yield* Effect.forEach(Object.entries(MessagingTemplate.timeVars), ([name, description]) =>
          value(`{${name}}`).pipe(
            Effect.map((rendered): Messaging.Var => ({ name, kind: "time", description, ...rendered })),
          ),
        )),
        ...Array.from(
          custom,
          ([name, item]): Messaging.Var => ({
            name,
            kind: "custom",
            description: "Custom variable",
            template: item.value,
            scope: item.scope,
          }),
        ),
      ]
      return { presets, vars }
    })

    const set = Effect.fn("MessagingVars.set")(function* (input: Parameters<Interface["set"]>[0]) {
      if (!NAME.test(input.name))
        return yield* new MessagingTemplate.TemplateError({ message: `Invalid variable name: ${input.name}` })
      if (
        Object.hasOwn(MessagingTemplate.contextVars, input.name) ||
        Object.hasOwn(MessagingTemplate.timeVars, input.name)
      )
        return yield* new MessagingTemplate.TemplateError({
          message: `{${input.name}} is computed and cannot be overridden`,
        })
      // Topic names are classified from constants in config only, so a stored override would rename topics
      // without changing their write rules.
      if (Object.hasOwn(MessagingTemplate.constants, input.name))
        return yield* new MessagingTemplate.TemplateError({
          message: `{${input.name}} is built in; change it under messaging.vars in the config instead`,
        })
      if (input.value === undefined) {
        yield* db
          .delete(MessagingVarTable)
          .where(and(eq(MessagingVarTable.scope, input.scope), eq(MessagingVarTable.name, input.name)))
          .run()
          .pipe(Effect.orDie)
        return
      }
      yield* db
        .insert(MessagingVarTable)
        .values({ scope: input.scope, name: input.name, value: input.value, by: input.by, time_updated: Date.now() })
        .onConflictDoUpdate({
          target: [MessagingVarTable.scope, MessagingVarTable.name],
          set: { value: input.value, by: input.by, time_updated: Date.now() },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const sessionStart = Effect.fn("MessagingVars.sessionStart")(function* (
      sessionID: string,
      requested?: ConfigMessaging.Info,
    ) {
      const config = requested ?? (yield* configFor((yield* MessagingGraph.row(db, sessionID))?.directory))
      const template = config?.session_start ?? MessagingTemplate.defaultSessionStart
      if (template.trim() === "") return undefined
      const current = yield* scope({ session: sessionID, config, stableTime: true })
      return yield* render(template, current, { strict: false })
    })

    const expand: Interface["expand"] = Effect.fn("MessagingVars.expand")(function* (text, sessionID, options) {
      if (!/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(text)) return text
      const current = yield* scope({
        session: sessionID,
        ...(options?.config ? { config: options.config } : {}),
        ...(options?.stableTime ? { stableTime: true } : {}),
      }).pipe(Effect.orElseSucceed(() => undefined))
      if (!current) return text
      return yield* render(text, current, { strict: false }).pipe(Effect.orElseSucceed(() => text))
    })

    const inject = Effect.fn("MessagingVars.inject")(function* (
      text: string,
      sessionID: string,
      config?: ConfigMessaging.Info,
    ) {
      const parsed = MessagingTemplate.frontmatter(text)
      if (!parsed) return text
      const current = yield* scope({ session: sessionID, ...(config ? { config } : {}), stableTime: true }).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      if (!current) return parsed.body
      const allowed = parsed.vars === true ? undefined : new Set(parsed.vars)
      return yield* MessagingTemplate.render(
        parsed.body,
        (name) => (allowed && !allowed.has(name) ? Effect.succeed(undefined) : current.resolve(name)),
        { strict: false },
      ).pipe(Effect.orElseSucceed(() => parsed.body))
    })

    return Service.of({
      scope,
      render,
      topic,
      list,
      set,
      sessionStart,
      inject,
      expand,
      configure: (config, directory) =>
        Effect.gen(function* () {
          if (directory !== undefined) configs.set(directory, config)
          yield* Ref.set(latest, config)
        }),
      config: configFor,
    })
  }),
)

/** Runs an effect at most once and replays its value; per-scope lookups stay lazy and cheap. */
function memoize<A>(effect: Effect.Effect<A>): Effect.Effect<A> {
  let cell: { readonly value: A } | undefined
  return Effect.suspend(() =>
    cell
      ? Effect.succeed(cell.value)
      : effect.pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              cell = { value }
            }),
          ),
        ),
  )
}

function timeValue(name: string, now: Date) {
  switch (name) {
    case "system_time":
      return MessagingTemplate.rfc3339(now)
    case "system_time_utc":
      return now.toISOString()
    case "system_time_zone":
      return MessagingTemplate.timeZone()
    case "today":
      return MessagingTemplate.localDate(now)
    case "date_hour":
      return MessagingTemplate.localDateHour(now)
    case "timestamp":
      return String(now.getTime())
    case "unix":
      return String(Math.floor(now.getTime() / 1000))
    case "weekday":
      return now.toLocaleDateString("en-US", { weekday: "long" })
  }
  return undefined
}

// A `.git` directory is its own common dir. A worktree's `.git` file points at a gitdir whose
// `commondir` file names the shared repository directory.
const gitCommonDir = Effect.fnUntraced(function* (fs: FSUtil.Interface, dotGit: string) {
  if (yield* fs.isDir(dotGit)) return dotGit
  const pointer = (yield* fs.readFileStringSafe(dotGit).pipe(Effect.orElseSucceed(() => undefined)))?.trim()
  const gitdir = pointer?.startsWith("gitdir:")
    ? path.resolve(path.dirname(dotGit), pointer.slice(7).trim())
    : undefined
  if (!gitdir) return undefined
  const common = (yield* fs
    .readFileStringSafe(path.join(gitdir, "commondir"))
    .pipe(Effect.orElseSucceed(() => undefined)))?.trim()
  return common ? path.resolve(gitdir, common) : gitdir
})

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, FSUtil.node, Global.node],
})
