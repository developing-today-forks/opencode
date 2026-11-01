export * as McpxSecrets from "./mcpx-secrets.js"

import { ToolFailure } from "@opencode/ai"
import { Effect, Option } from "effect"

// Core never reads, logs, stores, or sends a secret value. It works with names, statuses, and request ids from the
// daemon. A missing secret is waited for, and if it does not arrive the tool call fails before anything runs.

export type DaemonCall = (
  path: string,
  method?: string,
  body?: any,
  headers?: Record<string, string>,
  timeoutMs?: number,
) => Promise<any>

/** The daemon answered with a non-2xx status: the request was received and refused or failed. */
export class DaemonHTTPError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, text: string) {
    super(`mcpx daemon returned HTTP ${status}: ${text}`)
    this.status = status
    this.body = parseBody(text)
  }
}

/** No daemon answered, so nothing was sent. Only this lets mcpx_exec fall back to the CLI. */
export class DaemonUnreachableError extends Error {}

/**
 * The daemon did not answer within the request timeout. Unlike
 * DaemonUnreachableError this does NOT establish that the daemon never
 * received the request — an execution may already be running — so it
 * never lets mcpx_exec replay the request through the CLI.
 */
export class DaemonTimeoutError extends Error {}

const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export interface Timing {
  /** How long a pending secret request may wait before the tool call fails. */
  readonly timeoutMs: number
  /** How often pending requests are polled. */
  readonly pollMs: number
}

const defaultTiming: Timing = { timeoutMs: 10 * 60 * 1000, pollMs: 1000 }

let timing: Timing = defaultTiming

/** Overrides the wait bounds for the next waits; calling with nothing restores the defaults. Tests shorten them. */
export const setSecretTiming = (next?: Partial<Timing>): void => {
  timing = { ...defaultTiming, ...next }
}

export interface Missing {
  readonly server: string
  readonly secrets: readonly string[]
}

/** The `POST /v1/preflight` answer. Parsing is static on the daemon, so it never runs the script. */
export interface Preflight {
  readonly namespaces: readonly string[]
  readonly unknown: readonly string[]
  readonly ready: boolean
  readonly missing: readonly Missing[]
  readonly requests: readonly string[]
}

export interface SecretRequest {
  readonly id: string
  readonly server: string
  readonly secrets: readonly string[]
  readonly status: "pending" | "resolved" | "declined"
}

export interface ServerState {
  readonly name: string
  readonly active: boolean
  readonly requiresSecrets?: readonly string[]
  readonly missingSecrets?: readonly string[]
}

/** A `409 secret_required` from a call or an exec. */
export interface SecretRequired {
  readonly server: string
  readonly secrets: readonly string[]
  readonly requestId?: string
}

export type Settled =
  | { readonly _tag: "settled" }
  | { readonly _tag: "declined"; readonly request: SecretRequest }
  | { readonly _tag: "timeout" }

const daemon = <A>(call: () => Promise<any>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: call, catch: (error) => error })

/**
 * Asks the daemon which secrets a script needs, without running it. A daemon without the secrets API answers 404,
 * and that counts as ready so an older daemon keeps working.
 */
export const preflight = (callDaemon: DaemonCall, source: string) =>
  daemon<Preflight>(() => callDaemon("/v1/preflight", "POST", { source })).pipe(
    Effect.catch((error) =>
      error instanceof DaemonHTTPError && error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  )

/** The daemon's view of one server, or undefined when the daemon does not know it. */
export const serverState = (callDaemon: DaemonCall, name: string) =>
  daemon<ServerState>(() => callDaemon(`/v1/servers/${encodeURIComponent(name)}`)).pipe(
    Effect.catch((error) =>
      error instanceof DaemonHTTPError && error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  )

/**
 * Polls each listed request every `pollMs` until all are resolved, one is declined, or `timeoutMs` passes.
 * Interrupting the caller (cancelling the tool call) stops the loop.
 */
export const awaitRequests = (callDaemon: DaemonCall, ids: readonly string[]) => {
  const { timeoutMs, pollMs } = timing
  const poll = Effect.gen(function* () {
    let pending = ids
    while (true) {
      const requests = yield* Effect.forEach(pending, (id) =>
        daemon<SecretRequest>(() => callDaemon(`/v1/secret-requests/${encodeURIComponent(id)}`)),
      )
      const declined = requests.find((request) => request.status === "declined")
      if (declined) return { _tag: "declined", request: declined } as const
      pending = requests.filter((request) => request.status === "pending").map((request) => request.id)
      if (pending.length === 0) return { _tag: "settled" } as const
      yield* Effect.sleep(pollMs)
    }
  })
  return poll.pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map((outcome): Settled => (Option.isSome(outcome) ? outcome.value : { _tag: "timeout" })),
  )
}

const formatWait = (ms: number) => {
  const minutes = ms / 60_000
  if (Number.isInteger(minutes) && minutes >= 1) return `${minutes} minute${minutes === 1 ? "" : "s"}`
  return `${ms} ms`
}

/**
 * The failure a tool call returns when it cannot run because a secret is missing. It names the servers and
 * secrets, gives the two ways to provide a value, and includes the request ids so the user can find the prompt.
 */
export const secretFailure = (input: {
  readonly subject: string
  readonly reason: "unset" | "declined" | "timeout"
  readonly missing: readonly Missing[]
  readonly requestIDs: readonly string[]
}) => {
  const entries = input.missing.flatMap((item) => item.secrets.map((secret) => ({ secret, server: item.server })))
  const requests = input.requestIDs.length === 0 ? "" : ` (request ${input.requestIDs.join(", ")})`
  if (entries.length === 0) {
    const servers = input.missing.map((item) => `"${item.server}"`).join(", ")
    const which = servers === "" ? "a server it uses is" : `server ${servers} is`
    return new ToolFailure({
      message: `mcpx did not run ${input.subject}: ${which} not active${requests}. Nothing ran.`,
    })
  }
  const list = entries.map(({ secret, server }) => `${secret} (server "${server}")`).join(", ")
  const plural = entries.length > 1
  const state =
    input.reason === "unset"
      ? `${plural ? "are" : "is"} not set`
      : input.reason === "declined"
        ? `${plural ? "were" : "was"} declined`
        : `${plural ? "were" : "was"} not provided within ${formatWait(timing.timeoutMs)}`
  const names = [...new Set(entries.map((entry) => entry.secret))]
  const commands = names.map((name) => `\`mcpx secrets set ${name}\``).join(" and ")
  return new ToolFailure({
    message: `mcpx did not run ${input.subject}: ${list} ${state}${requests}. Provide ${names.join(", ")} in the OpenChamber prompt, or run ${commands}, then try again. Nothing ran.`,
  })
}

/** Turns a settled wait into a failure, or undefined when the requests resolved. */
const failureFromSettled = (subject: string, settled: Settled, fallback: Missing[], ids: readonly string[]) => {
  if (settled._tag === "declined")
    return secretFailure({
      subject,
      reason: "declined",
      missing: [{ server: settled.request.server, secrets: settled.request.secrets }],
      requestIDs: [settled.request.id],
    })
  if (settled._tag === "timeout")
    return secretFailure({ subject, reason: "timeout", missing: fallback, requestIDs: ids })
  return undefined
}

/**
 * The gate in front of `mcpx_exec`. Returns once every server the script references is active. Otherwise it waits
 * for the listed requests, preflights again, and fails before any code runs if a secret is still missing or was
 * declined.
 */
export const ensureScriptReady = (callDaemon: DaemonCall, source: string) =>
  Effect.gen(function* () {
    const first = yield* preflight(callDaemon, source)
    if (first === undefined || first.ready !== false) return
    const settled = yield* awaitRequests(callDaemon, first.requests)
    const failed = failureFromSettled("the script", settled, [...first.missing], first.requests)
    if (failed) return yield* failed
    const again = yield* preflight(callDaemon, source)
    if (again === undefined || again.ready !== false) return
    return yield* secretFailure({
      subject: "the script",
      reason: "unset",
      missing: [...again.missing],
      requestIDs: again.requests,
    })
  })

/**
 * The gate in front of each projected tool call. Checks the server's `active` and `missingSecrets`. When it is
 * inactive, it waits on the requests a preflight of the tool's reference files, then checks the server again.
 */
export const ensureServerReady = (callDaemon: DaemonCall, server: string, tool: string) =>
  Effect.gen(function* () {
    const before = yield* serverState(callDaemon, server)
    if (before === undefined || before.active !== false) return
    const reference = `tools[${JSON.stringify(server)}][${JSON.stringify(tool)}]`
    const filed = yield* preflight(callDaemon, reference)
    const ids = filed?.requests ?? []
    const missing: Missing[] = [{ server, secrets: before.missingSecrets ?? before.requiresSecrets ?? [] }]
    if (filed?.ready === false) {
      const settled = yield* awaitRequests(callDaemon, ids)
      const failed = failureFromSettled(tool, settled, missing, ids)
      if (failed) return yield* failed
    }
    const after = yield* serverState(callDaemon, server)
    if (after === undefined || after.active !== false) return
    return yield* secretFailure({
      subject: tool,
      reason: "unset",
      missing: [{ server, secrets: after.missingSecrets ?? after.requiresSecrets ?? [] }],
      requestIDs: ids,
    })
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Reads a `409 secret_required` from a call or an exec. Anything else returns undefined. */
export const secretRequired = (error: unknown): SecretRequired | undefined => {
  if (!(error instanceof DaemonHTTPError) || error.status !== 409) return undefined
  const body = error.body
  if (!isRecord(body) || body.code !== "secret_required" || typeof body.server !== "string") return undefined
  return {
    server: body.server,
    secrets: Array.isArray(body.secrets) ? body.secrets.filter((name): name is string => typeof name === "string") : [],
    requestId: typeof body.requestId === "string" ? body.requestId : undefined,
  }
}

/** The same failure as the preflight path, built from a refused call. */
export const secretRequiredFailure = (subject: string, required: SecretRequired) =>
  secretFailure({
    subject,
    reason: "unset",
    missing: [{ server: required.server, secrets: required.secrets }],
    requestIDs: required.requestId ? [required.requestId] : [],
  })

/** Maps whatever a daemon call raised onto the failure the model sees. A refused secret keeps its request id. */
export const failureOf = (error: unknown, subject: string): ToolFailure => {
  if (error instanceof ToolFailure) return error
  const required = secretRequired(error)
  if (required) return secretRequiredFailure(subject, required)
  return new ToolFailure({ message: error instanceof Error ? error.message : String(error), error })
}
