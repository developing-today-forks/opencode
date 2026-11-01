export * as McpxTool from "./mcpx.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { execFile, spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { McpxSubagent } from "./mcpx-subagent.js"
export * as McpxSubagent from "./mcpx-subagent.js"
import { interceptToolDiagnostic } from "./mcpx-diagnose.js"
export * as McpxDiagnose from "./mcpx-diagnose.js"
import {
  projectTools,
  projectedNamespaces,
  projectedToolDefinitions,
  retractTools,
  autoProjectFromScript,
  stepTurnTtl,
} from "./mcpx-projection.js"
export * as McpxProjection from "./mcpx-projection.js"
import { DaemonHTTPError, DaemonTimeoutError, DaemonUnreachableError, ensureScriptReady, failureOf } from "./mcpx-secrets.js"
export * as McpxSecrets from "./mcpx-secrets.js"
import { CodeModeRules } from "../../codemode/rules.js"
import { readBoundedResponseText } from "../http-body.js"

export const name = "mcpx"

const defaultSocketPath = (): string => {
  if (process.env.MCPX_SOCKET) return process.env.MCPX_SOCKET
  const stateDir = process.env.MCPX_STATE_DIR ||
    (process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME!, "mcpx") :
    join(homedir(), ".local", "state", "mcpx"))
  return join(stateDir, "daemon.sock")
}

const findDaemonSocket = (): string | undefined => {
  const direct = defaultSocketPath()
  if (existsSync(direct)) return direct

  // Check state directory for daemon info files
  const stateDir = process.env.MCPX_STATE_DIR ||
    (process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME, "mcpx") : join(homedir(), ".local", "state", "mcpx"))
  if (existsSync(stateDir)) {
    try {
      const files = readdirSync(stateDir).filter((f) => f.startsWith("daemon-") && f.endsWith(".json"))
      for (const file of files) {
        try {
          const info = JSON.parse(readFileSync(join(stateDir, file), "utf-8"))
          if (info.socket && existsSync(info.socket)) return info.socket
        } catch {}
      }
    } catch {}
  }
  return undefined
}

/**
 * The mcpx executable opencode talks to. `OPENCODE_MCPX_BIN` pins a stable
 * binary (path or name); otherwise the first `mcpx` on `PATH` wins, which in
 * a test or CI shell may be an unrelated build.
 */
export const mcpxBinary = (env: NodeJS.ProcessEnv = process.env): string => env.OPENCODE_MCPX_BIN || "mcpx"

/**
 * Whether opencode may spawn a detached mcpx daemon. Spawning is off when
 * `OPENCODE_MCPX_DAEMON` is `0`/`false`/`off`, and in test processes
 * (`OPENCODE_TEST_HOME` set, as every package test runner does): each test
 * home would otherwise leak its own daemon, invisible to `mcpx daemons`
 * once the temp home is deleted (#14). A daemon that is already running is
 * still used; only spawning is gated. Tests that cover mcpx inject one via
 * `McpxSubagent.setDaemonCaller` or `MCPX_DAEMON_ENDPOINT` instead.
 */
export const daemonAutostartEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const flag = env.OPENCODE_MCPX_DAEMON?.trim().toLowerCase()
  if (flag === "0" || flag === "false" || flag === "off") return false
  if (env.OPENCODE_TEST_HOME) return false
  return true
}

/**
 * Parses `mcpx settings get daemon.autostart` output (first line:
 * `daemon.autostart = true|false`). Returns undefined when the output does
 * not carry the setting, e.g. an mcpx too old to know it.
 */
export const parseMcpxDaemonAutostart = (output: string): boolean | undefined => {
  const match = /^daemon\.autostart\s*=\s*(true|false)\b/m.exec(output)
  if (!match) return undefined
  return match[1] === "true"
}

/**
 * Whether mcpx's own `daemon.autostart` setting allows starting a daemon.
 * A supervised daemon (launchd/systemd) is configured with the setting off
 * so nothing else puts a second daemon on the same socket while it restarts
 * (#134); the CLI honours it, so the plugin resolves it the same way — by
 * asking the CLI. Only an explicit `false` blocks the spawn: a missing or
 * unparseable answer (old mcpx, binary not installed) keeps today's
 * behaviour, since the setting defaults to true. The settings-call timeout
 * is a parameter (default 5s) so tests can exercise the timeout branch
 * without waiting it out (#178).
 */
export const mcpxDaemonAutostart = async (timeoutMs = 5000): Promise<boolean> => {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        mcpxBinary(),
        ["settings", "get", "daemon.autostart"],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(err)
          else resolve(stdout || stderr)
        },
      )
    })
    return parseMcpxDaemonAutostart(output) ?? true
  } catch {
    return true
  }
}

/**
 * Arguments for a daemon opencode spawns. The daemon gets a bounded idle
 * lifetime (`--daemon-idle-exit`, default 1h, `OPENCODE_MCPX_DAEMON_IDLE_EXIT`
 * overrides; `0`/`0s` restores mcpx's never-exit default) so a daemon started
 * by a short-lived process exits on its own instead of leaking forever (#14).
 */
export const daemonSpawnArgs = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const idle = env.OPENCODE_MCPX_DAEMON_IDLE_EXIT?.trim() || "1h"
  const total = mcpxDurationNs(idle)
  if (total === 0n) return ["daemon"]
  if (total === undefined) {
    console.warn(
      `Invalid OPENCODE_MCPX_DAEMON_IDLE_EXIT value ${JSON.stringify(idle)}: expected a duration like "1h" or "15m"; falling back to "1h".`,
    )
    return ["daemon", "--daemon-idle-exit", "1h"]
  }
  return ["daemon", "--daemon-idle-exit", idle]
}

// mcpx parses durations with Go's time.ParseDuration (its settings validation
// rejects anything else before the daemon starts, and the spawn below discards
// the daemon's stderr, so a rejected value used to fail silently): an optional
// sign, then one or more <number><unit> components ("1h", "15m", "1h30m",
// "1.5h"), where the number may be fractional and the unit is ns, us, µs, μs,
// ms, s, m, or h. Go also accepts a bare signed "0" with no unit, and rejects
// any total whose magnitude overflows int64 nanoseconds (~2562047h47m) — a
// shape-only check passes those through to a daemon that cannot start (#79).
// Returns the total in nanoseconds (sign aside: Go applies it to the whole
// value, and mcpx treats any idle exit <= 0 as "never"), or undefined when
// Go's parser would reject the value.
const mcpxDurationNs = (value: string): bigint | undefined => {
  if (/^[+-]?0$/.test(value)) return 0n
  if (
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h)(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))*$/.test(
      value,
    )
  )
    return undefined
  const units: Record<string, bigint> = {
    ns: 1n,
    us: 1_000n,
    µs: 1_000n,
    μs: 1_000n,
    ms: 1_000_000n,
    s: 1_000_000_000n,
    m: 60_000_000_000n,
    h: 3_600_000_000_000n,
  }
  let total = 0n
  for (const match of value.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/g)) {
    const unit = units[match[2] ?? ""]
    if (unit === undefined) return undefined
    const [whole = "0", fraction = ""] = (match[1] ?? "").split(".")
    total += BigInt(whole || "0") * unit
    if (fraction) total += (BigInt(fraction) * unit) / 10n ** BigInt(fraction.length)
  }
  // Go's int64 range is asymmetric: a negative value may reach 2^63 ns.
  const limit = value.startsWith("-") ? 9_223_372_036_854_775_808n : 9_223_372_036_854_775_807n
  return total > limit ? undefined : total
}

export const runCli = (args: string[], env?: Record<string, string | undefined>): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      mcpxBinary(),
      args,
      { maxBuffer: 16 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || stdout || err.message))
        } else {
          resolve(stdout || stderr)
        }
      },
    )
  })

const cliOutput = (args: string[], env?: Record<string, string | undefined>) =>
  Effect.tryPromise({
    try: () => runCli(args, env),
    catch: (error: any) => new ToolFailure({ message: error.message, error }),
  })

/**
 * How long one daemon request may go unanswered before it fails with
 * DaemonTimeoutError (#1023). The daemon is a local process: a call it accepts
 * but never answers is wedged, and hanging on it hangs the tool call (and
 * the session turn waiting on it) forever instead of degrading to the CLI
 * fallback. The bound is generous next to local round-trips so long tool
 * executions still complete; callers with their own deadline (the
 * ensureDaemon health poll) pass a shorter timeoutMs.
 */
export const daemonRequestTimeoutMs = 120_000

/**
 * Cap on a daemon response body (#1023): the same 16 MiB the CLI fallback
 * in this file allows via runCli's maxBuffer. Success bodies are read
 * through readBoundedResponseText, so an over-cap body fails naming the
 * path and the cap instead of buffering whole.
 */
export const daemonResponseMaxBytes = 16 * 1024 * 1024

/**
 * Cap on how much of an error body DaemonHTTPError carries. Error bodies
 * are diagnostics, not payloads, and the whole body used to be embedded
 * verbatim in the exception message; past this cap the message says the
 * body was truncated instead.
 */
export const daemonErrorBodyMaxBytes = 16 * 1024

/** How long an ensureDaemon health probe may go unanswered (see daemonRequestTimeoutMs). */
const daemonHealthTimeoutMs = 1_000

// No answer at all is DaemonUnreachableError; a non-2xx answer is DaemonHTTPError. Only the first lets mcpx_exec fall
// back to the CLI, because only then did the daemon not receive the request. A timeout is neither: the request may
// already be executing, so it surfaces as DaemonTimeoutError and is never replayed through the CLI.
const send = async (request: () => Promise<Response>, path: string, timeoutMs: number): Promise<any> => {
  let res: Response
  try {
    res = await request()
  } catch (error) {
    // The only abort source on these fetches is the timeout signal, whose
    // rejection is named TimeoutError (AbortError in older runtimes).
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      throw new DaemonTimeoutError(`mcpx daemon did not answer ${path} within ${timeoutMs}ms; the request may already be executing`)
    throw new DaemonUnreachableError(error instanceof Error ? error.message : String(error))
  }
  if (!res.ok) {
    const text = await readBoundedResponseText(
      res,
      daemonErrorBodyMaxBytes,
      () => new Error(`mcpx daemon error body for ${path} exceeded ${daemonErrorBodyMaxBytes} bytes`),
    ).catch(() => `[mcpx daemon error body for ${path} exceeded ${daemonErrorBodyMaxBytes} bytes and was truncated]`)
    throw new DaemonHTTPError(res.status, text)
  }
  const text = await readBoundedResponseText(
    res,
    daemonResponseMaxBytes,
    () => new Error(`mcpx daemon response for ${path} exceeded ${daemonResponseMaxBytes} bytes`),
  ).catch((error) => {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      throw new DaemonTimeoutError(`mcpx daemon did not answer ${path} within ${timeoutMs}ms; the request may already be executing`)
    throw error
  })
  return JSON.parse(text)
}

export const callDaemon = async (
  path: string,
  method = "GET",
  body?: any,
  headers?: Record<string, string>,
  timeoutMs = daemonRequestTimeoutMs,
): Promise<any> => {
  const endpoint = process.env.MCPX_DAEMON_ENDPOINT || process.env.MCPX_ENDPOINT
  const socket = findDaemonSocket()
  const init = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  }

  if (endpoint && endpoint.startsWith("http")) {
    return send(() => fetch(`${endpoint.replace(/\/+$/, "")}${path}`, init), path, timeoutMs)
  }

  if (socket) {
    return send(() => (fetch as any)(`http://localhost${path}`, { ...init, unix: socket }), path, timeoutMs)
  }

  throw new DaemonUnreachableError("No mcpx daemon reachable")
}

let daemonEnsured = false

/** Test-only: forget that the daemon was already ensured in this process. */
export const resetDaemonEnsured = (): void => {
  daemonEnsured = false
}

/**
 * Ensures mcpx daemon is standing and up-to-date.
 * Decoupled lifecycle:
 * - If daemon is not running, spawn detached in the background (`unref()`).
 *   OpenCode shutting down or reloading will not terminate the mcpx daemon.
 * - If daemon is already running, check if reload is needed or notify it.
 */
export const ensureDaemon = async (): Promise<void> => {
  if (daemonEnsured) return
  try {
    const health = await callDaemon("/v1/health", "GET", undefined, undefined, daemonHealthTimeoutMs)
    if (health?.status === "ok") {
      // Daemon is standing; trigger seamless hot reload so any updated config or binary is active
      try {
        await callDaemon("/v1/reload", "POST")
      } catch {}
      daemonEnsured = true
      return
    }
  } catch {}

  // Daemon not reachable. Tests and opted-out processes must not spawn one:
  // a detached daemon per test home leaks invisibly (#14). The tools degrade
  // to their CLI fallback / unreachable errors, as when mcpx is not installed.
  if (!daemonAutostartEnabled()) {
    daemonEnsured = true
    return
  }

  // mcpx itself may forbid autostart (daemon.autostart=false, set when a
  // supervisor owns the daemon): spawning here would race the supervised
  // daemon for its socket (#134). Tools degrade as above; the supervised
  // daemon answers health once it is up.
  if (!(await mcpxDaemonAutostart())) {
    daemonEnsured = true
    return
  }

  // Spawn detached so it outlives opencode, but with a bounded idle lifetime
  // and an owner tag (`MCPX_OWNER=opencode:<pid>`) so `script/mcpx-cleanup.ts`
  // can find daemons opencode started (#14).
  try {
    const child = spawn(mcpxBinary(), daemonSpawnArgs(), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, MCPX_OWNER: `opencode:${process.pid}` },
    })
    // A missing binary (ENOENT) is reported as an async 'error' event, not a thrown exception.
    // Without a listener it crashes OpenCode for everyone who has not installed mcpx.
    let spawnFailed = false
    child.on?.("error", () => {
      spawnFailed = true
    })
    child.unref()

    // Give daemon up to 1.5s to answer /v1/health
    const deadline = Date.now() + 1500
    while (Date.now() < deadline && !spawnFailed) {
      await new Promise((r) => setTimeout(r, 100))
      try {
        const health = await callDaemon("/v1/health", "GET", undefined, undefined, Math.max(1, deadline - Date.now()))
        if (health?.status === "ok") {
          daemonEnsured = true
          return
        }
      } catch {}
    }
  } catch {}
  daemonEnsured = true
}

export const Plugin = {
  id: "opencode.tools.mcpx",
  effect: Effect.fn("McpxTool.Plugin")(function* (ctx: Context) {
    // Opportunistically ensure daemon is standing detached in background
    yield* Effect.promise(() => ensureDaemon())

    // Wire subagent session leasing hooks
    yield* McpxSubagent.Plugin.effect(ctx)

    // Inject session leasing into shell commands
    yield* ctx.shell.hook("create.before", (invocation: any) =>
      Effect.sync(() => {
        invocation.env ??= {}
        const sessionID = invocation.sessionID ?? invocation.env?.OPENCODE_SESSION_ID
        const lease = sessionID ? McpxSubagent.getLease(sessionID) : undefined
        if (lease) {
          invocation.env.MCPX_SESSION_ID = lease.childSessionID
          invocation.env.MCPX_PARENT_SESSION_ID = lease.parentSessionID
        } else if (!invocation.env.MCPX_SESSION_ID && invocation.sessionID) {
          invocation.env.MCPX_SESSION_ID = invocation.sessionID
        }
        invocation.env.MCPX_HARNESS = "opencode"
      }),
    )

    // Turn-based TTL: each assistant message that runs a tool is one turn. Expired projections are dropped and the
    // registry is rebuilt so they leave the tool list.
    let lastTurnMessageID: string | undefined
    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        if (event.messageID === lastTurnMessageID) return
        lastTurnMessageID = event.messageID
        if (stepTurnTtl().length > 0) yield* ctx.tool.reload()
      }),
    )

    // Self-healing: enrich failed mcpx_exec scripts and projected tool calls with typo and argument hints
    yield* ctx.tool.hook("execute.after", (event) =>
      interceptToolDiagnostic(event, {
        callDaemon,
        getTools: () => ctx.tool.list(),
      }),
    )

    yield* ctx.tool.transform((editor) => {
      // 1. mcpx_exec: TypeScript Code Mode across all MCP servers
      editor.add({
        name: "mcpx_exec",
        options: { codemode: false },
        description: [
          "Run TypeScript against every MCP server at once via mcpx. Tools are bound as await tools.<namespace>.<tool>({...}) and only what you print comes back, saving context tokens. Top-level await is supported.",
          "Before any code runs, mcpx checks every server the script uses. A missing secret is waited for; if it is not provided, the call fails and nothing runs.",
          CodeModeRules.canonical,
        ].join(" "),
        input: Schema.Struct({
          source: Schema.String.annotate({ description: "TypeScript code to execute against tools.<server>.<method>()" }),
        }),
        output: Schema.Struct({
          output: Schema.String,
        }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const lease = context?.sessionID ? McpxSubagent.getLease(context.sessionID) : undefined
            const sessionID = lease ? lease.childSessionID : context?.sessionID
            const headers: Record<string, string> = {}
            if (sessionID) headers["x-mcpx-session-id"] = sessionID
            if (lease?.parentSessionID) headers["x-mcpx-parent-session-id"] = lease.parentSessionID
            const body: any = { source: input.source }
            if (sessionID) body.session = sessionID
            // Nothing runs until every server the script uses is active. Only a daemon that cannot be reached falls back
            // to the CLI. A refused or failed run is reported and never retried.
            const daemon = yield* Effect.gen(function* () {
              yield* ensureScriptReady(callDaemon, input.source)
              const res = yield* Effect.tryPromise({
                try: () => callDaemon("/v1/exec", "POST", body, headers),
                catch: (error) => error,
              })
              return { res }
            }).pipe(
              Effect.catch((error) =>
                error instanceof DaemonUnreachableError
                  ? Effect.succeed(undefined)
                  : Effect.fail(failureOf(error, "the script")),
              ),
            )
            let output: string
            if (daemon) {
              const res = daemon.res
              if (res?.error || (typeof res?.exitCode === "number" && res.exitCode !== 0)) {
                return yield* new ToolFailure({
                  message: res.error || res.stderr || `Execution exited with code ${res.exitCode}`,
                })
              }
              output = String(res.output ?? JSON.stringify(res.result ?? res, null, 2))
            } else {
              const env: Record<string, string> = {}
              if (sessionID) env.MCPX_SESSION_ID = sessionID
              if (lease?.parentSessionID) env.MCPX_PARENT_SESSION_ID = lease.parentSessionID
              output = yield* cliOutput(["exec", input.source], env)
            }
            // Auto-project tools used in script with a 3-turn TTL for subsequent review
            const projected = yield* Effect.tryPromise(() =>
              autoProjectFromScript({ source: input.source, callDaemon, defaultTtl: 3 }),
            ).pipe(Effect.orElseSucceed(() => [] as string[]))
            if (projected.length > 0) yield* ctx.tool.reload()
            return { output: { output } }
          }),
      })

      // 2. mcpx_discover: server listing and tool signatures
      editor.add({
        name: "mcpx_discover",
        options: { codemode: false },
        description: [
          "List the MCP servers mcpx knows about, the tools scripts can call, and the tools that can be projected. Pass a namespace to show its TypeScript signatures. Call with no arguments first: the answer is small and tells you what else is worth asking for.",
          CodeModeRules.canonical,
        ].join(" "),
        input: Schema.Struct({
          namespace: Schema.optionalKey(Schema.String.annotate({ description: "Namespace to show TypeScript signatures for; omit to list all" })),
        }),
        output: Schema.Struct({
          output: Schema.String,
        }),
        execute: (input) =>
          Effect.gen(function* () {
            const namespace = input.namespace
            const output = namespace
              ? yield* Effect.tryPromise(() => callDaemon(`/v1/types?namespace=${encodeURIComponent(namespace)}`)).pipe(
                  Effect.map((res: any) => (typeof res === "string" ? res : JSON.stringify(res, null, 2))),
                  Effect.catch(() => cliOutput(["types", namespace])),
                )
              : yield* Effect.tryPromise(() => callDaemon("/v1/namespaces")).pipe(
                  Effect.map((res: any) => {
                    const namespaces = Array.isArray(res) ? res : (res.namespaces ?? [])
                    const text = namespaces
                      .map((n: any) => `${n.namespace}  (${n.tools ?? 0} tools)${n.description ? "  " + n.description : ""}`)
                      .join("\n")
                    return text || "No MCP namespaces active."
                  }),
                  Effect.catch(() => cliOutput(["ls"])),
                )
            return { output: { output } }
          }),
      })

      // 3. mcpx_observe: inspect durable logs and statistics
      editor.add({
        name: "mcpx_observe",
        options: { namespace: "opencode" },
        description: [
          "Query what mcpx has been doing: the durable log, or aggregate statistics. Use it when a call failed and you want to know why without running it again.",
          CodeModeRules.canonical,
        ].join(" "),
        input: Schema.Struct({
          what: Schema.Literals(["log", "calls", "errors", "servers", "slowest"]).annotate({
            description: "log for records, the rest are aggregate stats",
          }),
          since: Schema.optionalKey(Schema.String.annotate({ description: "Duration or time cutoff (e.g. 15m, 2h, or RFC3339 timestamp)" })),
        }),
        output: Schema.Struct({
          output: Schema.String,
        }),
        execute: (input) =>
          Effect.gen(function* () {
            const query = input.since ? `?since=${encodeURIComponent(input.since)}` : ""
            const sinceArgs = input.since ? ["--since", input.since] : []
            const output =
              input.what === "log"
                ? yield* Effect.tryPromise(() => callDaemon(`/v1/log${query}`)).pipe(
                    Effect.map((res: any) => JSON.stringify(res.records ?? res, null, 2)),
                    Effect.catch(() => cliOutput(["log", ...sinceArgs])),
                  )
                : yield* Effect.tryPromise(() => callDaemon(`/v1/stats/${input.what}${query}`)).pipe(
                    Effect.map((res: any) => JSON.stringify(res, null, 2)),
                    Effect.catch(() => cliOutput(["stats", input.what, ...sinceArgs])),
                  )
            return { output: { output } }
          }),
      })

      // 4. mcpx_project: Dynamic tool projection ("Ghost Tools")
      editor.add({
        name: "mcpx_project",
        options: { codemode: false },
        description: [
          "Project tools from mcpx namespaces for this session. A projected tool becomes a native tool named <namespace>_<tool> right away, and scripts can also call it as tools.<namespace>.<tool>(args). Projected tools stay until they are retracted or their ttl runs out.",
          CodeModeRules.canonical,
        ].join(" "),
        input: Schema.Struct({
          namespaces: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "Namespaces to project tools from (e.g. ['neon', 'chrome_devtools'])" })),
          tools: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "Specific tool names to project (e.g. ['click', 'take_screenshot'])" })),
          ttl: Schema.optionalKey(Schema.Number.annotate({ description: "Optional number of turns this projection should remain active before auto-retracting (default: persistent until retracted)" })),
        }),
        output: Schema.Struct({
          output: Schema.String,
          projected: Schema.Array(Schema.String),
        }),
        execute: (input) =>
          Effect.gen(function* () {
            const result = yield* Effect.tryPromise(() =>
              projectTools({
                namespaces: input.namespaces,
                tools: input.tools,
                ttl: input.ttl,
                callDaemon,
              }),
            ).pipe(Effect.mapError((err: any) => new ToolFailure({ message: err?.message || String(err), error: err })))
            if (result.added.length > 0) yield* ctx.tool.reload()

            const msg = `Projected ${result.added.length} tool(s): ${result.added.join(", ") || "none"}.${
              typeof input.ttl === "number" ? ` (TTL: ${input.ttl} turns)` : ""
            }${result.errors.length > 0 ? " Errors: " + result.errors.join("; ") : ""}`
            return {
              output: {
                output: msg,
                projected: result.added,
              },
            }
          }),
      })

      // 5. mcpx_retract: Dynamic tool retraction
      editor.add({
        name: "mcpx_retract",
        options: { codemode: false },
        description: [
          "Retract previously projected MCP tools from the native tool list and the Code Mode catalog, to reduce schema context bloat.",
          CodeModeRules.canonical,
        ].join(" "),
        input: Schema.Struct({
          targets: Schema.Array(Schema.String).annotate({ description: "Tool names or namespaces to retract (e.g. ['chrome_devtools', 'neon_describe_table_schema'])" }),
        }),
        output: Schema.Struct({
          output: Schema.String,
          retracted: Schema.Array(Schema.String),
        }),
        execute: (input) =>
          Effect.gen(function* () {
            const retracted = retractTools(input.targets)
            if (retracted.length > 0) yield* ctx.tool.reload()
            const msg = `Retracted ${retracted.length} tool(s): ${retracted.join(", ") || "none"}.`
            return {
              output: {
                output: msg,
                retracted,
              },
            }
          }),
      })

      // Projected tools live in the projection module, not in this editor: re-add them on every rebuild
      for (const namespace of projectedNamespaces()) editor.namespace(namespace)
      for (const tool of projectedToolDefinitions()) {
        try {
          editor.add(tool)
        } catch {}
      }
    })
  }),
}
