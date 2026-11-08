export * as Messaging from "./messaging.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { NonNegativeInt, PositiveInt, optional } from "./schema.js"

/**
 * Inter-session messaging contracts: topics, messages, visibility, session chains and logs.
 *
 * Actors are session IDs or `user` (a human using the API). Session-set expressions accept a
 * session ID, `self`, `parent`, `root` or `user`, optionally suffixed with `+children`,
 * `+descendants`, `+ancestors` or `+parent` to expand the set.
 */

/** System kinds sessions cannot set directly. Plugins may register more kinds. */
export const BuiltinKinds = ["message", "delete", "restore"] as const

export const WriteMode = Schema.Literals(["open", "readonly", "limited"]).annotate({
  identifier: "Messaging.WriteMode",
  description:
    "open: anyone writes. readonly: only the owner (and its ancestors) write. limited: only listed writers write.",
})
export type WriteMode = typeof WriteMode.Type

export const Delivery = Schema.Literals(["none", "inbox", "wake"]).annotate({
  identifier: "Messaging.Delivery",
  description:
    "none: store only (read on demand). inbox: queue a notice into the session without starting it. wake: queue it and start or steer the session.",
})
export type Delivery = typeof Delivery.Type

export const HiddenMode = Schema.Literals(["exclude", "include", "only"]).annotate({
  identifier: "Messaging.HiddenMode",
})
export type HiddenMode = typeof HiddenMode.Type

export const MatchMode = Schema.Literals(["exact", "regex", "fuzzy", "semantic", "hybrid", "advanced"]).annotate({
  identifier: "Messaging.MatchMode",
  description:
    "exact substring, regex, fuzzy (typo tolerant), semantic (embedding similarity), hybrid (fuzzy + semantic), advanced (hybrid reranked by an LLM)",
})
export type MatchMode = typeof MatchMode.Type

export const Order = Schema.Literals(["asc", "desc"])
export type Order = typeof Order.Type

export interface Writer extends Schema.Schema.Type<typeof Writer> {}
export const Writer = Schema.Struct({
  session: Schema.String.annotate({ description: "Session ID or user" }),
  children: Schema.Boolean.annotate({ description: "Also allow its descendants" }).pipe(optional),
  ancestors: Schema.Boolean.annotate({ description: "Also allow its ancestors" }).pipe(optional),
}).annotate({ identifier: "Messaging.Writer" })

export interface Participant extends Schema.Schema.Type<typeof Participant> {}
export const Participant = Schema.Struct({
  session: Schema.String,
  title: Schema.String.pipe(optional),
  reads: NonNegativeInt,
  writes: NonNegativeInt,
  first: Schema.Number.annotate({ description: "First read or write, epoch milliseconds" }).pipe(optional),
  last: Schema.Number.annotate({ description: "Latest read or write, epoch milliseconds" }).pipe(optional),
}).annotate({ identifier: "Messaging.Participant" })

export interface Window extends Schema.Schema.Type<typeof Window> {}
export const Window = Schema.Struct({
  total: NonNegativeInt,
  first: Schema.Array(Participant),
  latest: Schema.Array(Participant),
}).annotate({ identifier: "Messaging.Window" })

export interface Topic extends Schema.Schema.Type<typeof Topic> {}
export const Topic = Schema.Struct({
  name: Schema.String,
  exists: Schema.Boolean.annotate({ description: "Standard topics are listed before first use with exists: false" }),
  kind: Schema.String.annotate({ description: "Standard kind (private, readonly, family, dm, ...) or custom" }),
  preset: Schema.String.pipe(optional),
  owner: Schema.String.annotate({ description: "Session the standard topic belongs to" }).pipe(optional),
  creator: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mode: WriteMode,
  writers: Schema.Array(Writer).annotate({ description: "Limited writers, when mode is limited" }),
  policy: Schema.String.annotate({ description: "Effective write rule in words" }),
  messages: NonNegativeInt.annotate({ description: "Latest sequence number" }),
  created: Schema.Number.pipe(optional),
  last: Schema.Number.annotate({ description: "Time of the latest message" }).pipe(optional),
  unread: NonNegativeInt.pipe(optional),
  subscribed: Delivery.pipe(optional),
  writersWindow: Window.pipe(optional),
  readersWindow: Window.annotate({ description: "Sessions that read but never wrote" }).pipe(optional),
  allowedWindow: Window.annotate({ description: "Sessions allowed by limited-writer rules" }).pipe(optional),
}).annotate({ identifier: "Messaging.Topic" })

export interface Op extends Schema.Schema.Type<typeof Op> {}
export const Op = Schema.Struct({
  seq: PositiveInt,
  kind: Schema.String,
  writer: Schema.String,
  time: Schema.Number,
  viewers: Schema.Array(Schema.String).annotate({ description: "Sessions affected; * means everyone" }),
  reason: Schema.String.pipe(optional),
}).annotate({ identifier: "Messaging.Op" })

export interface Message extends Schema.Schema.Type<typeof Message> {}
export const Message = Schema.Struct({
  id: PositiveInt,
  topic: Schema.String,
  seq: PositiveInt,
  kind: Schema.String,
  type: Schema.String,
  writer: Schema.String,
  time: Schema.Number,
  data: Schema.String,
  meta: Schema.Record(Schema.String, Schema.Json).pipe(optional),
  reply: PositiveInt.pipe(optional),
  hidden: Schema.Boolean.pipe(optional),
  score: Schema.Number.pipe(optional),
  ops: Schema.Array(Op).annotate({ description: "Delete and restore operations applied to it" }).pipe(optional),
}).annotate({ identifier: "Messaging.Message" })

export interface Delivered extends Schema.Schema.Type<typeof Delivered> {}
export const Delivered = Schema.Struct({
  session: Schema.String,
  delivery: Delivery,
}).annotate({ identifier: "Messaging.Delivered" })

export interface SendInput extends Schema.Schema.Type<typeof SendInput> {}
export const SendInput = Schema.Struct({
  as: Schema.String.annotate({ description: "Writer session ID; defaults to user" }).pipe(optional),
  topic: Schema.String.pipe(optional),
  to: Schema.String.annotate({ description: "Session to message directly" }).pipe(optional),
  text: Schema.String,
  type: Schema.String.pipe(optional),
  meta: Schema.Record(Schema.String, Schema.Json).pipe(optional),
  reply: PositiveInt.pipe(optional),
  force: Schema.Boolean.pipe(optional),
  deliver: Delivery.pipe(optional),
}).annotate({ identifier: "Messaging.SendInput" })

export interface SendResult extends Schema.Schema.Type<typeof SendResult> {}
export const SendResult = Schema.Struct({
  topic: Schema.String,
  seq: PositiveInt,
  created: Schema.Boolean,
  forced: Schema.Boolean.pipe(optional),
  delivered: Schema.Array(Delivered),
}).annotate({ identifier: "Messaging.SendResult" })

export interface UserInput extends Schema.Schema.Type<typeof UserInput> {}
export const UserInput = Schema.Struct({
  as: Schema.String,
  text: Schema.String,
  title: Schema.String.pipe(optional),
  root: Schema.Literals(["hidden", "visible", "wake"]).annotate({
    description: "Whether the root session sees the message: hidden (user only), visible, or wake (visible and run)",
  }).pipe(optional),
}).annotate({ identifier: "Messaging.UserInput" })

export interface Query extends Schema.Schema.Type<typeof Query> {}
export const Query = Schema.Struct({
  as: Schema.String.annotate({ description: "Viewer session ID; defaults to user" }).pipe(optional),
  topics: Schema.Array(Schema.String).annotate({ description: "Topics to read; omit to search all" }).pipe(optional),
  query: Schema.String.pipe(optional),
  match: MatchMode.pipe(optional),
  from: Schema.Array(Schema.String).annotate({ description: "Writer session-set expressions" }).pipe(optional),
  types: Schema.Array(Schema.String).pipe(optional),
  kinds: Schema.Array(Schema.String).pipe(optional),
  since: Schema.String.annotate({ description: "ISO time, relative age such as 2h or 3d, or a bare epoch (10 digits = seconds, 13 digits = milliseconds)" }).pipe(optional),
  until: Schema.String.pipe(optional),
  after: NonNegativeInt.annotate({ description: "Only sequence numbers greater than this" }).pipe(optional),
  before: PositiveInt.annotate({ description: "Only sequence numbers less than this" }).pipe(optional),
  hidden: HiddenMode.pipe(optional),
  hiddenBy: Schema.Array(Schema.String).annotate({
    description: "Re-include only hidden messages hidden by these sessions (session-set expressions)",
  }).pipe(optional),
  hiddenFrom: Schema.Array(Schema.String).annotate({
    description: "Re-include only hidden messages written by these sessions (session-set expressions)",
  }).pipe(optional),
  hiddenSince: Schema.String.annotate({ description: "Re-include only messages hidden since then" }).pipe(optional),
  hiddenUntil: Schema.String.annotate({ description: "Re-include only messages hidden until then" }).pipe(optional),
  unread: Schema.Boolean.pipe(optional),
  inbox: Schema.Boolean.annotate({
    description: "Only messages addressed to the person: those written to sessions' user topics",
  }).pipe(optional),
  limit: PositiveInt.pipe(optional),
  order: Order.pipe(optional),
  markRead: Schema.Boolean.annotate({
    description:
      "Advance the viewer's read position; defaults to true for a session's plain reads, false for searches and filtered reads",
  }).pipe(optional),
  wait: NonNegativeInt.annotate({ description: "Seconds to wait for a first unread message" }).pipe(optional),
}).annotate({ identifier: "Messaging.Query" })

export interface QueryResult extends Schema.Schema.Type<typeof QueryResult> {}
export const QueryResult = Schema.Struct({
  messages: Schema.Array(Message),
  more: Schema.Boolean,
  match: MatchMode.pipe(optional),
  note: Schema.String.pipe(optional),
}).annotate({ identifier: "Messaging.QueryResult" })

export interface InspectInput extends Schema.Schema.Type<typeof InspectInput> {}
export const InspectInput = Schema.Struct({
  as: Schema.String.pipe(optional),
  topic: Schema.String,
  seq: PositiveInt,
}).annotate({ identifier: "Messaging.InspectInput" })

export interface VisibilityInput extends Schema.Schema.Type<typeof VisibilityInput> {}
export const VisibilityInput = Schema.Struct({
  as: Schema.String.pipe(optional),
  topic: Schema.String,
  action: Schema.Literals(["hide", "restore"]),
  seqs: Schema.Array(PositiveInt)
    .annotate({ description: "Messages to change; omit to set the default" })
    .pipe(optional),
  for: Schema.Array(Schema.String).annotate({
    description: "Viewers: session-set expressions or * for everyone; defaults to the actor",
  }).pipe(optional),
  reason: Schema.String.pipe(optional),
}).annotate({ identifier: "Messaging.VisibilityInput" })

export interface VisibilityResult extends Schema.Schema.Type<typeof VisibilityResult> {}
export const VisibilityResult = Schema.Struct({
  topic: Schema.String,
  seq: PositiveInt.annotate({ description: "Sequence number of the recorded operation" }),
  targets: Schema.Array(PositiveInt),
  viewers: Schema.Array(Schema.String),
  default: Schema.Boolean,
}).annotate({ identifier: "Messaging.VisibilityResult" })

export interface SettingsInput extends Schema.Schema.Type<typeof SettingsInput> {}
export const SettingsInput = Schema.Struct({
  as: Schema.String.pipe(optional),
  topic: Schema.String,
  mode: WriteMode.pipe(optional),
  writers: Schema.Array(Writer).pipe(optional),
  description: Schema.String.pipe(optional),
}).annotate({ identifier: "Messaging.SettingsInput" })

export interface SubscribeInput extends Schema.Schema.Type<typeof SubscribeInput> {}
export const SubscribeInput = Schema.Struct({
  as: Schema.String,
  topic: Schema.String,
  delivery: Delivery.pipe(optional),
  remove: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Messaging.SubscribeInput" })

export interface TopicInput extends Schema.Schema.Type<typeof TopicInput> {}
export const TopicInput = Schema.Struct({
  as: Schema.String.pipe(optional),
  topic: Schema.String,
  expand: NonNegativeInt.annotate({ description: "Show the first and latest N writers and readers" }).pipe(optional),
}).annotate({ identifier: "Messaging.TopicInput" })

export interface TopicsInput extends Schema.Schema.Type<typeof TopicsInput> {}
export const TopicsInput = Schema.Struct({
  as: Schema.String.pipe(optional),
  topics: Schema.Array(Schema.String).pipe(optional),
  sessions: Schema.Array(Schema.String).annotate({ description: "Topics these sessions read or wrote" }).pipe(optional),
  role: Schema.Literals(["any", "reader", "writer", "subscriber"]).pipe(optional),
  kinds: Schema.Array(Schema.String).pipe(optional),
  search: Schema.String.pipe(optional),
  standard: Schema.Boolean.annotate({ description: "Include the actor's standard topics" }).pipe(optional),
  sort: Schema.Literals(["created", "last"]).pipe(optional),
  order: Order.pipe(optional),
  limit: PositiveInt.pipe(optional),
  offset: NonNegativeInt.pipe(optional),
  expand: NonNegativeInt.annotate({ description: "Show the first and latest N writers and readers" }).pipe(optional),
}).annotate({ identifier: "Messaging.TopicsInput" })

export interface TopicList extends Schema.Schema.Type<typeof TopicList> {}
export const TopicList = Schema.Struct({
  topics: Schema.Array(Topic),
  total: NonNegativeInt,
}).annotate({ identifier: "Messaging.TopicList" })

export const LogPart = Schema.Literals([
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
]).annotate({ identifier: "Messaging.LogPart" })
export type LogPart = typeof LogPart.Type

export interface SessionBrief extends Schema.Schema.Type<typeof SessionBrief> {}
export const SessionBrief = Schema.Struct({
  id: Schema.String,
  title: Schema.String.pipe(optional),
  agent: Schema.String.pipe(optional),
  status: Schema.Literals(["running", "idle"]),
  created: Schema.Number.pipe(optional),
  updated: Schema.Number.pipe(optional),
}).annotate({ identifier: "Messaging.SessionBrief" })

export interface ChildWindow extends Schema.Schema.Type<typeof ChildWindow> {}
export const ChildWindow = Schema.Struct({
  total: NonNegativeInt,
  first: Schema.Array(SessionBrief),
  latest: Schema.Array(SessionBrief),
}).annotate({ identifier: "Messaging.ChildWindow" })

export interface SessionNode extends Schema.Schema.Type<typeof SessionNode> {}
export const SessionNode = Schema.Struct({
  id: Schema.String,
  title: Schema.String.pipe(optional),
  parentID: Schema.String.pipe(optional),
  depth: NonNegativeInt.annotate({ description: "Distance from the root session" }),
  agent: Schema.String.pipe(optional),
  model: Schema.String.pipe(optional),
  directory: Schema.String,
  status: Schema.Literals(["running", "idle"]),
  project: Schema.String.pipe(optional),
  original: Schema.String.annotate({ description: "Directory at creation, when moved since" }).pipe(optional),
  created: Schema.Number.pipe(optional),
  updated: Schema.Number.pipe(optional),
  outcome: Schema.String.pipe(optional),
  children: NonNegativeInt.pipe(optional),
  descendants: NonNegativeInt.pipe(optional),
  messages: NonNegativeInt.pipe(optional),
  cost: Schema.Number.pipe(optional),
  tokens: NonNegativeInt.pipe(optional),
  topics: NonNegativeInt.annotate({ description: "Topics it read or wrote" }).pipe(optional),
  childWindow: ChildWindow.pipe(optional),
}).annotate({ identifier: "Messaging.SessionNode" })

export interface ChainInput extends Schema.Schema.Type<typeof ChainInput> {}
export const ChainInput = Schema.Struct({
  session: Schema.String,
  depth: Schema.Literals(["self", "parent", "all"]).pipe(optional),
  detail: Schema.Literals(["brief", "full"]).pipe(optional),
  expand: NonNegativeInt.annotate({ description: "Show the first and latest N children of each" }).pipe(optional),
}).annotate({ identifier: "Messaging.ChainInput" })

export interface Chain extends Schema.Schema.Type<typeof Chain> {}
export const Chain = Schema.Struct({
  chain: Schema.Array(SessionNode).annotate({ description: "The session first, then each parent up to the root" }),
  root: Schema.String,
  depth: NonNegativeInt,
}).annotate({ identifier: "Messaging.Chain" })

export interface SessionsInput extends Schema.Schema.Type<typeof SessionsInput> {}
export const SessionsInput = Schema.Struct({
  as: Schema.String.pipe(optional),
  ids: Schema.Array(Schema.String).annotate({ description: "Session-set expressions" }).pipe(optional),
  parent: Schema.String.annotate({ description: "Parent session ID, or none for root sessions" }).pipe(optional),
  ancestor: Schema.String.annotate({ description: "Only descendants of this session" }).pipe(optional),
  project: Schema.String.pipe(optional),
  directory: Schema.String.pipe(optional),
  agent: Schema.String.pipe(optional),
  search: Schema.String.pipe(optional),
  active: Schema.Boolean.pipe(optional),
  since: Schema.String.pipe(optional),
  until: Schema.String.pipe(optional),
  sort: Schema.Literals(["created", "updated"]).pipe(optional),
  order: Order.pipe(optional),
  limit: PositiveInt.pipe(optional),
  offset: NonNegativeInt.pipe(optional),
  detail: Schema.Literals(["brief", "full"]).pipe(optional),
  expand: NonNegativeInt.annotate({ description: "Show the first and latest N children of each" }).pipe(optional),
}).annotate({ identifier: "Messaging.SessionsInput" })

export interface SessionList extends Schema.Schema.Type<typeof SessionList> {}
export const SessionList = Schema.Struct({
  sessions: Schema.Array(SessionNode),
  total: NonNegativeInt,
}).annotate({ identifier: "Messaging.SessionList" })

export interface LogInput extends Schema.Schema.Type<typeof LogInput> {}
export const LogInput = Schema.Struct({
  as: Schema.String.pipe(optional),
  sessions: Schema.Array(Schema.String).annotate({
    description: "Session-set expressions; +descendants covers a tree",
  }),
  op: Schema.Literals(["head", "tail", "grep", "search", "pull"]).pipe(optional),
  include: Schema.Array(LogPart).pipe(optional),
  query: Schema.String.pipe(optional),
  match: MatchMode.pipe(optional),
  context: NonNegativeInt.annotate({ description: "Entries of context around grep matches" }).pipe(optional),
  scope: Schema.Literals(["all", "context"]).annotate({
    description: "all: the full transcript. context: only what the model currently sees (after the last compaction)",
  }).pipe(optional),
  since: Schema.String.pipe(optional),
  until: Schema.String.pipe(optional),
  limit: PositiveInt.pipe(optional),
  offset: NonNegativeInt.pipe(optional),
  chars: PositiveInt.annotate({ description: "Maximum characters per entry" }).pipe(optional),
}).annotate({ identifier: "Messaging.LogInput" })

export interface LogEntry extends Schema.Schema.Type<typeof LogEntry> {}
export const LogEntry = Schema.Struct({
  session: Schema.String,
  message: Schema.String,
  index: NonNegativeInt,
  part: LogPart,
  time: Schema.Number,
  text: Schema.String,
  tool: Schema.String.pipe(optional),
  match: Schema.Boolean.annotate({ description: "False for context entries around a match" }).pipe(optional),
  score: Schema.Number.pipe(optional),
}).annotate({ identifier: "Messaging.LogEntry" })

export interface Log extends Schema.Schema.Type<typeof Log> {}
export const Log = Schema.Struct({
  entries: Schema.Array(LogEntry),
  total: NonNegativeInt,
  more: Schema.Boolean,
  match: MatchMode.pipe(optional),
  note: Schema.String.pipe(optional),
}).annotate({ identifier: "Messaging.Log" })

export interface Var extends Schema.Schema.Type<typeof Var> {}
export const Var = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["constant", "context", "time", "custom"]),
  description: Schema.String,
  template: Schema.String.pipe(optional),
  value: Schema.String.pipe(optional),
  scope: Schema.String.annotate({ description: "Where a custom variable is set" }).pipe(optional),
}).annotate({ identifier: "Messaging.Var" })

export interface Preset extends Schema.Schema.Type<typeof Preset> {}
export const Preset = Schema.Struct({
  name: Schema.String,
  template: Schema.String,
  description: Schema.String,
  policy: Schema.String,
  value: Schema.String.pipe(optional),
}).annotate({ identifier: "Messaging.Preset" })

export interface VarsInput extends Schema.Schema.Type<typeof VarsInput> {}
export const VarsInput = Schema.Struct({
  as: Schema.String.pipe(optional),
  values: Schema.Boolean.pipe(optional),
  render: Schema.String.annotate({ description: "Template to render" }).pipe(optional),
}).annotate({ identifier: "Messaging.VarsInput" })

export interface Vars extends Schema.Schema.Type<typeof Vars> {}
export const Vars = Schema.Struct({
  presets: Schema.Array(Preset),
  vars: Schema.Array(Var),
  rendered: Schema.String.pipe(optional),
}).annotate({ identifier: "Messaging.Vars" })

export interface SetVarInput extends Schema.Schema.Type<typeof SetVarInput> {}
export const SetVarInput = Schema.Struct({
  as: Schema.String.pipe(optional),
  scope: Schema.String.annotate({
    description: "Session ID (inherited by its descendants), self, or global; defaults to self",
  }).pipe(optional),
  name: Schema.String,
  value: Schema.String.annotate({ description: "Omit to remove the variable" }).pipe(optional),
}).annotate({ identifier: "Messaging.SetVarInput" })

export const ModelTier = Schema.Literals(["tiny", "default", "step-up", "top"]).annotate({
  identifier: "Messaging.ModelTier",
})
export type ModelTier = typeof ModelTier.Type

export interface ModelProgress extends Schema.Schema.Type<typeof ModelProgress> {}
export const ModelProgress = Schema.Struct({
  file: Schema.String,
  received: NonNegativeInt,
  total: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "Messaging.ModelProgress" })

export interface ModelStatus extends Schema.Schema.Type<typeof ModelStatus> {}
export const ModelStatus = Schema.Struct({
  state: Schema.Literals(["off", "unavailable", "pending", "downloading", "starting", "ready", "error"]),
  tier: Schema.String.pipe(optional),
  model: Schema.String.pipe(optional),
  dimensions: PositiveInt.pipe(optional),
  path: Schema.String.pipe(optional),
  source: Schema.String.annotate({ description: "Download URL, local path, or remote endpoint" }).pipe(optional),
  server: Schema.String.annotate({ description: "llama-server executable" }).pipe(optional),
  endpoint: Schema.String.pipe(optional),
  remote: Schema.Boolean.pipe(optional),
  progress: Schema.Array(ModelProgress).pipe(optional),
  error: Schema.String.pipe(optional),
  indexed: NonNegativeInt.pipe(optional),
  pending: NonNegativeInt.pipe(optional),
  tiers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      model: Schema.String,
      size: Schema.String,
      hardware: Schema.String,
      available: Schema.Boolean,
    }),
  ).pipe(optional),
}).annotate({ identifier: "Messaging.ModelStatus" })

export interface ModelInput extends Schema.Schema.Type<typeof ModelInput> {}
export const ModelInput = Schema.Struct({
  tier: Schema.String.annotate({ description: "tiny, default, step-up, top, or off" }).pipe(optional),
  url: Schema.String.annotate({ description: "GGUF download URL overriding the tier" }).pipe(optional),
  path: Schema.String.annotate({ description: "Existing local GGUF file overriding the tier" }).pipe(optional),
  start: Schema.Boolean.annotate({ description: "Start downloading and serving now" }).pipe(optional),
}).annotate({ identifier: "Messaging.ModelInput" })

const Created = ephemeral({
  type: "messaging.message.created",
  schema: {
    topic: Schema.String,
    seq: PositiveInt,
    kind: Schema.String,
    type: Schema.String,
    writer: Schema.String,
    time: Schema.Number,
    preview: Schema.String,
    inbox: Schema.Boolean.annotate({ description: "Addressed to the person: written to a user topic" }).pipe(optional),
  },
})

export const Event = { Created, Definitions: inventory(Created) }
