export * as MessagingTemplate from "./template.js"

import { Effect, Schema } from "effect"
import type { ConfigMessaging } from "@opencode/schema/config/messaging"
import { ConfigMarkdown } from "../config/markdown.js"
import { ModelRouteLimits } from "../model-route-limits.js"

/**
 * Topic presets and template variables.
 *
 * A template is text with `{name}` placeholders. Constants are configurable tokens whose values may
 * themselves be templates; context and time variables are facts about the acting session and the
 * clock and cannot be overridden; custom variables are set per session (inherited by descendants)
 * or globally. Topic arguments accept a preset name (optionally `preset@session`), a template, or a
 * raw name (`=name` forces a raw name).
 */

export class TemplateError extends Schema.TaggedError<TemplateError>()("Messaging.TemplateError", {
  message: Schema.String,
}) {}

export type Policy = "open" | "owner" | "family" | "tree" | "roots" | "pair"

export interface Constant {
  readonly value: string
  readonly description: string
}

export const constants: Readonly<Record<string, Constant>> = {
  separator: { value: "/", description: "Separator between topic name parts" },
  private: { value: "private", description: "Suffix of a session's private scratch topic" },
  read_only: { value: "readonly", description: "Suffix of a session's read-only announcement topic" },
  read_write: { value: "readwrite", description: "Suffix of a session's public read-write topic" },
  tasks: { value: "tasks", description: "Suffix of a session's task board" },
  family: { value: "family", description: "Suffix of a family topic (a session and all its subsessions)" },
  root: { value: "root", description: "Suffix of the topic that reaches a root session" },
  user: { value: "user", description: "Suffix of the topic for messages to the user" },
  global: { value: "global", description: "Name of the global topic" },
  root_sessions_only: { value: "roots", description: "Suffix of the global topic only root sessions write" },
  workdir: { value: "dir", description: "Prefix of per-working-directory topics" },
  project: { value: "project", description: "Prefix of per-project topics" },
  git: { value: "git", description: "Prefix of per-git-repository topics (by git common dir)" },
  bidirectional: { value: "bidi", description: "Marker of a private two-way link between two sessions" },
  private_link: {
    value: "{separator}{bidirectional}{separator}",
    description: "Joins the two sessions of a private link",
  },
}

export interface Preset {
  readonly name: string
  readonly template: string
  readonly kind: string
  readonly description: string
  readonly policy: Policy
  /** Variable whose session ID owns the topic. */
  readonly owner?: string
  /** Variable holding the other session of a two-session topic. */
  readonly peer?: string
  /** Whether `preset@session` names the peer (`to`) rather than the subject session. */
  readonly targetsPeer?: boolean
}

export const presets: ReadonlyArray<Preset> = [
  {
    name: "private",
    template: "{session_id}{separator}{private}",
    kind: "private",
    owner: "session_id",
    policy: "owner",
    description: "Personal scratch topic; the session and its parents write, anyone reads",
  },
  {
    name: "readonly",
    template: "{session_id}{separator}{read_only}",
    kind: "readonly",
    owner: "session_id",
    policy: "owner",
    description: "Announcements; the session and its parents write, anyone reads",
  },
  {
    name: "readwrite",
    template: "{session_id}{separator}{read_write}",
    kind: "readwrite",
    owner: "session_id",
    policy: "open",
    description: "Public board of a session; anyone writes",
  },
  {
    name: "tasks",
    template: "{session_id}{separator}{tasks}",
    kind: "tasks",
    owner: "session_id",
    policy: "open",
    description: "Task board of a session",
  },
  {
    name: "family",
    template: "{family_id}{separator}{family}",
    kind: "family",
    owner: "family_id",
    policy: "family",
    description: "Your parent and all its subsessions (your own subtree when you are a root)",
  },
  {
    name: "children",
    template: "{session_id}{separator}{family}",
    kind: "family",
    owner: "session_id",
    policy: "family",
    description: "You and all your subsessions",
  },
  {
    name: "tree",
    template: "{root_session_id}{separator}{family}",
    kind: "family",
    owner: "root_session_id",
    policy: "family",
    description: "Every session under your root session",
  },
  {
    name: "root",
    template: "{root_session_id}{separator}{root}",
    kind: "root",
    owner: "root_session_id",
    policy: "tree",
    description: "Reaches the root session from any subtask; messages are delivered to the root",
  },
  {
    name: "user",
    template: "{session_id}{separator}{user}",
    kind: "user",
    owner: "session_id",
    policy: "open",
    description: "Your line to the user: what you send up to the user and what the user sends you directly",
  },
  {
    name: "global",
    template: "{global}",
    kind: "global",
    policy: "open",
    description: "Every session everywhere",
  },
  {
    name: "roots",
    template: "{global}{separator}{root_sessions_only}",
    kind: "roots",
    policy: "roots",
    description: "Global topic only root sessions write",
  },
  {
    name: "workdir",
    template: "{workdir}{separator}{pwd}",
    kind: "workdir",
    policy: "open",
    description: "Sessions in the current working directory",
  },
  {
    name: "project",
    template: "{project}{separator}{project_id}",
    kind: "project",
    policy: "open",
    description: "Sessions in the current project",
  },
  {
    name: "git",
    template: "{git}{separator}{common_dir}",
    kind: "git",
    policy: "open",
    description: "Sessions in any worktree of the current git repository",
  },
  {
    name: "dm",
    template: "{dm_first}{private_link}{dm_second}",
    kind: "dm",
    owner: "dm_first",
    peer: "dm_second",
    policy: "pair",
    targetsPeer: true,
    description: "Direct conversation with another session (dm@<session>); the ancestor comes first",
  },
  {
    name: "parent_link",
    template: "{parent_session_id}{private_link}{session_id}",
    kind: "dm",
    owner: "parent_session_id",
    peer: "session_id",
    policy: "pair",
    description: "Private link between you and your parent",
  },
  {
    name: "child_link",
    template: "{session_id}{private_link}{child_id}",
    kind: "dm",
    owner: "session_id",
    peer: "child_id",
    policy: "pair",
    targetsPeer: true,
    description: "Private link between you and a child (child_link@<child>)",
  },
]

/** Context variables of one session, available as session_*, parent_session_* and root_session_*. */
export const sessionFields: Readonly<Record<string, string>> = {
  id: "Session ID",
  title: "Title",
  agent: "Agent",
  model: "Model (provider/model)",
  dir: "Working directory",
  original_dir: "Working directory when the session was created",
  project_id: "Project ID",
  start: "Creation time (RFC 3339, local timezone)",
  start_date: "Creation date (YYYY-MM-DD)",
  start_date_hour: "Creation date and hour (YYYY-MM-DDTHH)",
  depth: "Distance from the root session",
}

export const contextVars: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(sessionFields).flatMap(([field, description]) => [
      [`session_${field}`, `${description} of the session`],
      [`parent_session_${field}`, `${description} of the parent session (the session itself for a root)`],
      [`root_session_${field}`, `${description} of the root session`],
    ]),
  ),
  parent_id: "Alias of parent_session_id",
  root_id: "Alias of root_session_id",
  project_id: "Project ID of the session",
  family_id: "Parent session ID, or the session's own ID for a root",
  pwd: "Working directory of the session",
  session_dir: "Working directory of the session",
  parent_dir: "Parent directory of the working directory",
  original_dir: "Working directory when the session was created",
  project_dir: "Project root directory",
  common_dir: "Git common directory shared by all worktrees of the repository",
  all_children: "Comma-separated IDs of direct subsessions",
  all_subsessions: "Comma-separated IDs of all subsessions",
  all_root_sessions: "Comma-separated IDs of all root sessions",
  session_lineage: "Parent and root of a subsession as a sentence; empty for a root",
  to: "Target session of a direct message",
  from: "Sending session",
  child_id: "Child session of a child link",
  dm_first: "First session of a direct conversation (the ancestor, else the lower ID)",
  dm_second: "Second session of a direct conversation",
  home: "Home directory",
  tmp: "Temporary directory approved for agents",
  hostname: "Machine hostname",
  platform: "Operating system platform",
}

export const timeVars: Readonly<Record<string, string>> = {
  system_time: "Current time (RFC 3339, local timezone)",
  system_time_utc: "Current time (RFC 3339, UTC)",
  system_time_zone: "System timezone (IANA name)",
  today: "Current date (YYYY-MM-DD)",
  date_hour: "Current date and hour (YYYY-MM-DDTHH)",
  timestamp: "Current Unix time in milliseconds",
  unix: "Current Unix time in seconds",
  weekday: "Current weekday",
}

export type Resolved = { readonly value: string; readonly template?: boolean } | undefined

const TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const MAX_DEPTH = 8

/** Variable names used directly by a template. */
export function tokens(template: string) {
  return Array.from(new Set(Array.from(template.matchAll(TOKEN), (match) => match[1])))
}

/**
 * Renders `{name}` placeholders. Template-valued variables (constants, config and custom variables)
 * render recursively; context values are inserted verbatim. Unknown variables fail when strict and are
 * left untouched otherwise, so prose with braces survives lenient rendering.
 */
export const render = Effect.fnUntraced(function* <E, R>(
  template: string,
  resolve: (name: string) => Effect.Effect<Resolved, E, R>,
  options: { readonly strict: boolean },
) {
  const cache = new Map<string, Resolved>()
  const unknown = new Set<string>()
  const lookup = Effect.fnUntraced(function* (name: string) {
    if (cache.has(name)) return cache.get(name)
    const value = yield* resolve(name)
    cache.set(name, value)
    return value
  })
  const expand = (text: string, stack: ReadonlyArray<string>): Effect.Effect<string, E | TemplateError, R> =>
    Effect.gen(function* () {
      const parts = text.split(TOKEN)
      const output: string[] = []
      for (let index = 0; index < parts.length; index++) {
        if (index % 2 === 0) {
          output.push(parts[index])
          continue
        }
        const name = parts[index]
        const resolved = yield* lookup(name)
        if (resolved === undefined) {
          unknown.add(name)
          output.push(`{${name}}`)
          continue
        }
        if (!resolved.template || !resolved.value.includes("{")) {
          output.push(resolved.value)
          continue
        }
        if (stack.includes(name))
          return yield* new TemplateError({
            message: `Variable reference cycle: ${[...stack, name].join(" -> ")} (variable {${name}} is reached again)`,
          })
        if (stack.length >= MAX_DEPTH)
          return yield* new TemplateError({
            message: `Variable {${name}} exceeds the maximum expansion depth of ${MAX_DEPTH} (chain: ${[...stack, name].join(" -> ")})`,
          })
        output.push(yield* expand(resolved.value, [...stack, name]))
      }
      return output.join("")
    })
  const result = yield* expand(template, [])
  if (options.strict && unknown.size > 0)
    return yield* new TemplateError({
      message: `Unknown variable${unknown.size === 1 ? "" : "s"}: ${Array.from(unknown, (name) => `{${name}}`).join(", ")}. List them with topics({ mode: "presets" }).`,
    })
  return result
})

export type TopicArgument =
  | { readonly kind: "template"; readonly value: string }
  | { readonly kind: "raw"; readonly value: string }
  | {
      readonly kind: "preset"
      readonly value: string
      readonly preset: Preset
      /** Session named after `@`, before alias resolution. */
      readonly target?: string
    }

/** Classifies a topic argument without rendering it. */
export function parseTopic(argument: string, config?: ConfigMessaging.Info): TopicArgument {
  const trimmed = argument.trim()
  if (trimmed.startsWith("=")) return { kind: "raw", value: trimmed.slice(1) }
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)(?:@(.+))?$/.exec(trimmed)
  const preset = match ? presetList(config).find((item) => item.name === match[1]) : undefined
  if (match && preset) return { kind: "preset", value: trimmed, preset, ...(match[2] ? { target: match[2] } : {}) }
  if (/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(trimmed)) return { kind: "template", value: trimmed }
  return { kind: "raw", value: trimmed }
}

/** Built-in presets with configured overrides and additions applied. */
export function presetList(config?: ConfigMessaging.Info): ReadonlyArray<Preset> {
  const overrides = config?.presets ?? {}
  const builtin = presets.map((preset) =>
    overrides[preset.name] === undefined ? preset : { ...preset, template: overrides[preset.name] },
  )
  const added = Object.entries(overrides)
    .filter(([name]) => !presets.some((preset) => preset.name === name))
    .map(
      ([name, template]): Preset => ({
        name,
        template,
        kind: "custom",
        policy: "open",
        description: "Configured preset",
      }),
    )
  return [...builtin, ...added]
}

/** Constant value with config overrides applied; custom variables are resolved by the caller. */
export function constant(name: string, config?: ConfigMessaging.Info) {
  // Own-property lookups only (#793): plain indexing reads through the prototype chain, so
  // "constructor" / "__proto__" resolve to inherited non-string values when any vars exist.
  const configured = config?.vars && Object.hasOwn(config.vars, name) ? config.vars[name] : undefined
  return configured ?? (Object.hasOwn(constants, name) ? constants[name]?.value : undefined)
}

export interface Classification {
  readonly kind: string
  readonly preset?: string
  readonly owner?: string
  readonly peer?: string
  readonly policy: Policy
}

// Generated session IDs are `ses_` plus base62, but callers may supply their own IDs, which can contain underscores.
const SESSION_PATTERN = "(ses_[A-Za-z0-9_-]+)"

/**
 * Detects which standard preset produced a topic name by compiling each preset template into a
 * pattern: constants become literals, session variables capture session IDs, and other context
 * variables capture any text. Names that match no preset are custom topics.
 */
export function classify(name: string, config?: ConfigMessaging.Info): Classification {
  for (const preset of presetList(config)) {
    if (preset.kind === "custom") continue
    const compiled = compile(preset.template, config)
    if (!compiled) continue
    const match = compiled.pattern.exec(name)
    if (!match) continue
    const capture = (variable?: string) => {
      if (!variable) return undefined
      const index = compiled.names.indexOf(variable)
      return index === -1 ? undefined : match[index + 1]
    }
    return {
      kind: preset.kind,
      preset: preset.name,
      policy: preset.policy,
      ...(capture(preset.owner) ? { owner: capture(preset.owner) } : {}),
      ...(capture(preset.peer) ? { peer: capture(preset.peer) } : {}),
    }
  }
  return { kind: "custom", policy: "open" }
}

function compile(template: string, config: ConfigMessaging.Info | undefined, depth = 0) {
  const names: string[] = []
  const expand = (text: string, level: number): string | undefined => {
    if (level > MAX_DEPTH) return undefined
    const parts = text.split(TOKEN)
    const output: string[] = []
    for (let index = 0; index < parts.length; index++) {
      if (index % 2 === 0) {
        output.push(escape(parts[index]))
        continue
      }
      const name = parts[index]
      const value = constant(name, config)
      if (value !== undefined) {
        const nested = expand(value, level + 1)
        if (nested === undefined) return undefined
        output.push(nested)
        continue
      }
      names.push(name)
      output.push(isSessionVariable(name) ? SESSION_PATTERN : "(.+?)")
    }
    return output.join("")
  }
  const source = expand(template, depth)
  if (source === undefined) return undefined
  return { pattern: new RegExp(`^${source}$`), names }
}

function isSessionVariable(name: string) {
  return (
    (name.endsWith("_id") && name !== "project_id" && !name.endsWith("_project_id") && !name.startsWith("all_")) ||
    ["to", "from", "dm_first", "dm_second"].includes(name)
  )
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export interface Frontmatter {
  readonly vars: true | ReadonlyArray<string>
  readonly body: string
}

/**
 * Finds frontmatter that opts a skill or instruction file into variable injection: `vars: true`, or a
 * list of variable names. Only frontmatter carrying `vars` is stripped; other files are left untouched.
 */
export function frontmatter(content: string): Frontmatter | undefined {
  if (!/^\uFEFF?---/.test(content)) return undefined
  const parsed = ConfigMarkdown.parseOption(content)
  const value: unknown = parsed?.data.vars
  if (!parsed || value === undefined || value === null) return undefined
  if (value === true || value === 1 || (typeof value === "string" && /^(true|yes|on|1)$/i.test(value.trim())))
    return { vars: true, body: parsed.content }
  const list = (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/^\{|\}$/g, ""))
    .filter((item) => item !== "" && !/^(false|no|off|0)$/i.test(item))
  return list.length > 0 ? { vars: list, body: parsed.content } : undefined
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0")

export function localDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function localDateHour(date: Date) {
  return `${localDate(date)}T${pad(date.getHours())}`
}

/** RFC 3339 in the local timezone, for example 2026-10-16T09:41:07-05:00. */
export function rfc3339(date: Date) {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const minutes = Math.abs(offset)
  return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

export function timeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export const defaultSessionStart =
  "Session started {session_start} ({system_time_zone}). Session ID: {session_id}.{session_lineage}"

/** Parses an ISO time, a relative age such as 90s, 15m, 2h, 3d or 1w, or a bare epoch timestamp into epoch milliseconds. Bare epochs are magnitude-aware: exactly 10 digits are epoch seconds (the form most tools emit) and are scaled to milliseconds; exactly 13 digits are epoch milliseconds. Any other bare-digit length is rejected (undefined, so callers raise Invalid time) instead of being silently misread, except a bare 4-digit ISO year ("2026"), which falls through to Date.parse and reads as Jan 1 of that year. */
export function parseTime(input: string, now: number): number | undefined {
  const relative = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(input.trim())
  if (relative) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
      relative[2].toLowerCase() as "s" | "m" | "h" | "d" | "w"
    ]
    return now - Number(relative[1]) * unit
  }
  const bare = input.trim()
  if (/^\d{10}$/.test(bare)) return Number(bare) * 1_000
  if (/^\d{13}$/.test(bare)) return Number(bare)
  // A bare 4-digit ISO year ("2026") is not a bare epoch; fall through to the calendar-checked
  // Date.parse path so it parses as Jan 1 (#695), restoring the pre-#623 behaviour for this form.
  if (/^\d+$/.test(bare) && !/^\d{4}$/.test(bare)) return undefined
  // Calendar check via ModelRouteLimits.parseAbsoluteTime (#609): a bare Date.parse
  // silently rolls calendar-invalid ISO dates such as 2026-02-30 into the next month
  // instead of failing, so callers would query the wrong day instead of raising
  // Invalid time. Non-ISO Date.parse forms (e.g. "Jan 5 2026") keep their old behaviour.
  return ModelRouteLimits.parseAbsoluteTime(input.trim())
}
