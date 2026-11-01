export * as MessagingEmbedding from "./embedding.js"

import { createHash, type Hash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, open, rename, rm, stat, readdir, chmod } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Context, Deferred, Duration, Effect, Fiber, Latch, Layer, Schedule, Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { ConfigMessaging } from "@opencode/schema/config/messaging"
import type { Messaging } from "@opencode/schema/messaging"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { Global } from "@opencode/util/global"
import { collectBoundedResponseBody } from "../tool/http-body.js"
import { which } from "../util/which.js"

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Messaging.EmbeddingUnavailableError", {
  message: Schema.String,
}) {}

export interface Tier {
  readonly name: Messaging.ModelTier
  readonly model: string
  readonly repo: string
  readonly file: string
  readonly url: string
  readonly size: number
  readonly sha256: string
  readonly dimensions: number
  readonly pooling: "last" | "mean" | "cls"
  readonly query?: string
  readonly context: number
  readonly hardware: string
}

const QWEN_QUERY =
  "Instruct: Given a search query, retrieve relevant messages and transcript entries that answer the query\nQuery: "

const huggingface = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`

export const tiers: ReadonlyArray<Tier> = [
  {
    name: "tiny",
    model: "all-MiniLM-L6-v2 Q8_0",
    repo: "second-state/All-MiniLM-L6-v2-Embedding-GGUF",
    file: "all-MiniLM-L6-v2-Q8_0.gguf",
    url: huggingface("second-state/All-MiniLM-L6-v2-Embedding-GGUF", "all-MiniLM-L6-v2-Q8_0.gguf"),
    size: 25008064,
    sha256: "263215c3cadd6e16740741a7624ab4cbb6c8e777688bd5331ecfbf5681c2f8ed",
    dimensions: 384,
    pooling: "mean",
    context: 512,
    hardware: "Runs anywhere, including old phones",
  },
  {
    name: "default",
    model: "Qwen3-Embedding-0.6B Q8_0",
    repo: "Qwen/Qwen3-Embedding-0.6B-GGUF",
    file: "Qwen3-Embedding-0.6B-Q8_0.gguf",
    url: huggingface("Qwen/Qwen3-Embedding-0.6B-GGUF", "Qwen3-Embedding-0.6B-Q8_0.gguf"),
    size: 639150592,
    sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
    dimensions: 1024,
    pooling: "last",
    query: QWEN_QUERY,
    context: 8192,
    hardware: "Fast on a CPU laptop",
  },
  {
    name: "step-up",
    model: "Qwen3-Embedding-4B Q8_0",
    repo: "Qwen/Qwen3-Embedding-4B-GGUF",
    file: "Qwen3-Embedding-4B-Q8_0.gguf",
    url: huggingface("Qwen/Qwen3-Embedding-4B-GGUF", "Qwen3-Embedding-4B-Q8_0.gguf"),
    size: 4279660224,
    sha256: "b60ae5ce2dd6a0b77f82cadf21def1f310a3e10cde380ad0081b07a9d416949d",
    dimensions: 2560,
    pooling: "last",
    query: QWEN_QUERY,
    context: 8192,
    hardware: "Wants a GPU; Apple Silicon or 16 GB RAM",
  },
  {
    name: "top",
    model: "Qwen3-Embedding-8B F16",
    repo: "Qwen/Qwen3-Embedding-8B-GGUF",
    file: "Qwen3-Embedding-8B-f16.gguf",
    url: huggingface("Qwen/Qwen3-Embedding-8B-GGUF", "Qwen3-Embedding-8B-f16.gguf"),
    size: 15141156384,
    sha256: "9a2dfcc2e867828909456dd52a69e3775b677bdce1816f7cc55f3657393e7e53",
    dimensions: 4096,
    pooling: "last",
    query: QWEN_QUERY,
    context: 8192,
    hardware: "Requires a dedicated GPU, or Apple Silicon with 64 GB",
  },
]

const LLAMA_BUILD = "b11669"
// Sizes are the exact byte counts of the ggml-org/llama.cpp b11669 release assets; download enforces
// them in flight, so the sha-only asset path is bounded just like a model download.
const LLAMA_ASSETS: Readonly<
  Record<string, { readonly name: string; readonly sha256: string; readonly size: number }>
> = {
  "darwin-arm64": {
    name: "llama-b11669-bin-macos-arm64.tar.gz",
    sha256: "dbed55493d72bc1ba2babc8770d669c2289b5bc4ee9fb2a4dfc158d45b7d13fd",
    size: 12191582,
  },
  "darwin-x64": {
    name: "llama-b11669-bin-macos-x64.tar.gz",
    sha256: "cab28238d78158109b48deb27b05d50e0dcef56275d2e76da9ca8281526c7532",
    size: 11677404,
  },
  "linux-arm64": {
    name: "llama-b11669-bin-ubuntu-arm64.tar.gz",
    sha256: "9ac6fda2058d35677608a06f751a50122ddfa4ce0ddb7f084466b8e79b6d4a99",
    size: 13900160,
  },
  "linux-x64": {
    name: "llama-b11669-bin-ubuntu-x64.tar.gz",
    sha256: "cf07c1c112d709bd67e522017471de57ed0ec8bea031d732c5422351c07f65ac",
    size: 17851611,
  },
  "win32-x64": {
    name: "llama-b11669-bin-win-cpu-x64.zip",
    sha256: "37b3efcf962847ca869745fd4ccf7f5e7e8dacfeff9fa3523b4ca8cdc66d632b",
    size: 19537886,
  },
  "win32-arm64": {
    name: "llama-b11669-bin-win-cpu-arm64.zip",
    sha256: "9cff39ffed17edcd03a7d876073f74d7b48cd43a1e5eafdd59ee094185ad871b",
    size: 12442177,
  },
}

const GIB = 1024 ** 3
const BATCH = 32
const MAX_CHARS = 8000
/** Upper bound for one embeddings request; a full batch of long documents on a slow CPU stays well under it. */
const REQUEST_TIMEOUT = "60 seconds"
/** Cap on a non-200 embeddings error body (#1079): only the first 500 chars are ever shown, so the 64 KiB OAuth-error precedent (#1029) is generous headroom. */
export const embeddingErrorMaxResponseBytes = 64 * 1024
/**
 * Cap on a 200 embeddings response body (#1079): one request batches BATCH inputs and each vector has at
 * most 4096 dimensions (the largest local tier), so 32 x 4096 JSON floats at ~24 bytes each is ~3.2 MiB;
 * 16 MiB gives ~5x headroom and matches the house 16 MiB body caps.
 */
export const embeddingMaxResponseBytes = 16 * 1024 * 1024

// Hardware facts the tier gate depends on, kept separate from detection so the gate is testable.
export interface Hardware {
  readonly platform: string
  readonly arch: string
  readonly memory: number
  readonly nvidia: boolean
}

export function available(tier: Messaging.ModelTier, hardware: Hardware) {
  const apple = hardware.platform === "darwin" && hardware.arch === "arm64"
  if (tier === "step-up") return apple || hardware.memory >= 16 * GIB || hardware.nvidia
  if (tier === "top") return hardware.nvidia || (apple && hardware.memory >= 64 * GIB)
  return true
}

export function detect(): Hardware {
  return {
    platform: process.platform,
    arch: process.arch,
    memory: os.totalmem(),
    nvidia: which("nvidia-smi") !== null,
  }
}

export interface Local {
  /** Tier name, or "custom" for a url or path override. */
  readonly tier: string
  readonly gate?: Messaging.ModelTier
  readonly id: string
  readonly name: string
  readonly file: string
  readonly url?: string
  readonly path?: string
  readonly sha256?: string
  readonly size?: number
  readonly dimensions?: number
  readonly pooling: "last" | "mean" | "cls"
  readonly query?: string
  readonly context: number
  readonly server?: string
  readonly gpu_layers?: number
  readonly threads?: number
}

export interface Remote {
  readonly url: string
  readonly model: string
  readonly key?: string
  readonly dimensions?: number
  readonly query?: string
}

export interface Settings {
  /** Undefined when the local model is off or invalid. */
  readonly local?: Local
  readonly remote?: Remote
  readonly autostart: boolean
  readonly error?: string
}

/** Resolves config plus environment overrides into concrete local and remote model settings. */
export function resolve(
  input: ConfigMessaging.Info["embedding"] | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Settings {
  const config: Partial<ConfigMessaging.Embedding> = typeof input === "string" ? { tier: input } : (input ?? {})
  const remote = config.remote
    ? {
        url: config.remote.url,
        model: config.remote.model,
        key: config.remote.key === undefined ? undefined : expandEnv(config.remote.key, env),
        dimensions: config.remote.dimensions,
        query: config.query,
      }
    : undefined
  const autostart = config.autostart ?? true
  const override = env.OPENCODE_EMBEDDING?.trim()
  const source = override ? overrideSource(override) : { tier: config.tier, url: config.url, path: config.path }
  const disabled = env.OPENCODE_DISABLE_EMBEDDING === "1" || env.OPENCODE_DISABLE_EMBEDDING === "true"
  if (disabled || source.tier === "off") return { remote, autostart }
  const shared = { server: config.server, gpu_layers: config.gpu_layers, threads: config.threads }

  const custom = source.path ?? source.url
  if (custom) {
    // An unparseable link is a settings error reported as unavailable, never a thrown defect.
    const file = source.path
      ? path.basename(source.path)
      : URL.canParse(custom)
        ? path.basename(new URL(custom).pathname)
        : ""
    if (!file) return { remote, autostart, error: `Invalid embedding model URL: ${custom}` }
    const stem = file.replace(/\.gguf$/i, "")
    const qwen = file.toLowerCase().includes("qwen3-embedding")
    // sha256/size pin the configured source only: an environment override that selects a different
    // url or path must not inherit the configured model's integrity metadata.
    const pinned = !override || (source.url === config.url && source.path === config.path) ? config : {}
    return {
      remote,
      autostart,
      local: {
        ...shared,
        tier: "custom",
        id: stem.toLowerCase(),
        name: stem,
        file,
        url: source.path ? undefined : source.url,
        path: source.path,
        sha256: pinned.sha256,
        size: pinned.size,
        pooling: config.pooling ?? (qwen ? "last" : "mean"),
        query: config.query ?? (qwen ? QWEN_QUERY : undefined),
        context: qwen ? 8192 : 512,
      },
    }
  }

  const name = source.tier ?? "default"
  const tier = tiers.find((item) => item.name === name)
  if (!tier)
    return { remote, autostart, error: `Unknown embedding tier "${name}"; use tiny, default, step-up, top or off` }
  return {
    remote,
    autostart,
    local: {
      ...shared,
      tier: tier.name,
      gate: tier.name,
      id: tier.file.replace(/\.gguf$/i, "").toLowerCase(),
      name: tier.model,
      file: tier.file,
      url: tier.url,
      sha256: tier.sha256,
      size: tier.size,
      dimensions: tier.dimensions,
      pooling: config.pooling ?? tier.pooling,
      query: config.query ?? tier.query,
      context: tier.context,
    },
  }
}

function overrideSource(value: string) {
  if (/^https?:\/\//i.test(value)) return { tier: undefined, url: value, path: undefined }
  if (path.isAbsolute(value)) return { tier: undefined, url: undefined, path: value }
  return { tier: value, url: undefined, path: undefined }
}

function expandEnv(value: string, env: Readonly<Record<string, string | undefined>>) {
  const match = /^\{env:([^}]+)\}$/.exec(value.trim())
  if (!match) return value
  return env[match[1] ?? ""]
}

/**
 * Hard ceiling for a download whose expected size is unknown (the custom-URL embedding shape carries
 * neither sha256 nor size): 16 GiB, above the largest built-in tier (top, 15,141,156,384 bytes) with
 * headroom, so a legitimate custom GGUF still fits while an endless or oversized stream cannot fill
 * the disk. A configured size replaces this cap as the effective bound.
 */
export const MAX_UNKNOWN_SIZE_DOWNLOAD_BYTES = 17_179_869_184

export interface DownloadInput {
  readonly url: string
  readonly dest: string
  readonly sha256?: string
  readonly size?: number
  /** Test seam: overrides the unknown-size cap for this call. Production callers leave it unset. */
  readonly limit?: number
  readonly onProgress?: (received: number, total: number | undefined) => void
}

/**
 * One resumable download attempt into `<dest>.part`, renamed to `dest` once verified. Callers retry; a digest
 * mismatch deletes the part so the next attempt starts from zero.
 */
export const download = Effect.fn("MessagingEmbedding.download")(function* (input: DownloadInput) {
  const http = yield* HttpClient.HttpClient
  const part = `${input.dest}.part`
  // The effective bound: the known size when there is one, else the unknown-size cap. Every check
  // below uses it, so no call shape reaches the stream unbounded.
  const bound = input.size ?? input.limit ?? MAX_UNKNOWN_SIZE_DOWNLOAD_BYTES
  yield* Effect.tryPromise({ try: () => mkdir(path.dirname(input.dest), { recursive: true }), catch: toError })
  const existing = yield* Effect.promise(() =>
    stat(part).then(
      (info) => info.size,
      () => 0,
    ),
  )
  // A part already larger than the bound can never verify; drop it instead of resuming from it.
  if (existing > bound) {
    yield* Effect.promise(() => rm(part, { force: true }))
    return yield* Effect.fail(
      new Error(`download from ${input.url} is larger than expected: part already holds ${existing} of ${bound} bytes`),
    )
  }
  const resumed = createHash("sha256")
  if (existing > 0 && input.sha256)
    yield* Effect.tryPromise({ try: (signal) => hashFile(part, resumed, signal), catch: toError })

  const request = HttpClientRequest.get(input.url)
  const response = yield* http
    .execute(existing > 0 ? HttpClientRequest.setHeader(request, "Range", `bytes=${existing}-`) : request)
    .pipe(Effect.mapError(toError))

  // 416 means the part already holds every byte the server has.
  if (response.status === 416 && existing > 0) {
    input.onProgress?.(existing, existing)
    return yield* finish(input, part, resumed, existing)
  }
  if (response.status !== 200 && response.status !== 206)
    return yield* Effect.fail(new Error(`HTTP ${response.status} downloading ${input.url}`))

  const append = response.status === 206 && existing > 0
  const hash = append ? resumed : createHash("sha256")
  const start = append ? existing : 0
  const length = Number(response.headers["content-length"])
  const total =
    totalFromRange(response.headers["content-range"]) ??
    (Number.isFinite(length) && length > 0 ? start + length : input.size)
  // Fail fast on a declared length above the bound, before a single body byte is read.
  if (total !== undefined && total > bound) {
    yield* Effect.promise(() => rm(part, { force: true }))
    return yield* Effect.fail(
      new Error(
        `download from ${input.url} is larger than expected: declared ${total} bytes, expected at most ${bound}`,
      ),
    )
  }
  const progress = { received: start }
  input.onProgress?.(progress.received, total)

  // Bound the stream itself: chunked or undeclared-length bodies carry no header to pre-check, so
  // each chunk is measured before it is written and the download aborts the moment it passes the
  // bound. The oversized part is deleted, never left behind as a resumable download.
  let oversized = false
  const streamed = yield* Effect.exit(
    Effect.acquireUseRelease(
      Effect.tryPromise({ try: () => open(part, append ? "a" : "w"), catch: toError }),
      (handle) =>
        Stream.runForEach(response.stream, (chunk) => {
          if (progress.received + chunk.byteLength > bound) {
            oversized = true
            return Effect.fail(
              new Error(`download from ${input.url} is larger than expected: received more than ${bound} bytes`),
            )
          }
          return Effect.tryPromise({ try: () => handle.write(chunk), catch: toError }).pipe(
            Effect.map(() => {
              if (input.sha256) hash.update(chunk)
              progress.received += chunk.byteLength
              input.onProgress?.(progress.received, total)
            }),
          )
        }).pipe(Effect.mapError(toError)),
      (handle) => Effect.promise(() => handle.close()),
    ),
  )
  if (streamed._tag === "Failure") {
    const cause = streamed.cause
    if (oversized) yield* Effect.promise(() => rm(part, { force: true }))
    return yield* Effect.failCause(cause)
  }
  return yield* finish(input, part, hash, progress.received)
})

const finish = Effect.fnUntraced(function* (input: DownloadInput, part: string, hash: Hash, received: number) {
  const digest = input.sha256 ? hash.digest("hex") : undefined
  // Digest and size are independent requirements: a matching digest does not excuse a wrong size.
  const failure =
    digest !== undefined && digest !== input.sha256
      ? `sha256 mismatch for ${input.url}: expected ${input.sha256}, got ${digest}`
      : input.size !== undefined && received !== input.size
        ? `size mismatch for ${input.url}: expected ${input.size} bytes, got ${received}`
        : undefined
  if (failure) {
    yield* Effect.promise(() => rm(part, { force: true }))
    return yield* Effect.fail(new Error(failure))
  }
  yield* Effect.tryPromise({ try: () => rename(part, input.dest), catch: toError })
})

async function hashFile(file: string, hash: Hash, signal: AbortSignal) {
  for await (const chunk of createReadStream(file)) {
    if (signal.aborted) return
    hash.update(chunk)
  }
}

// Core also runs on Node, so file checks use node:fs rather than Bun APIs.
function exists(file: string) {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  )
}

function totalFromRange(value: string | undefined) {
  const match = value ? /\/(\d+)\s*$/.exec(value) : null
  return match ? Number(match[1]) : undefined
}

function toError(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export interface Options {
  readonly autostart?: boolean
  /** Wait before the boot start, unless config arrives first. Default 15 seconds. */
  readonly delay?: Duration.Input
}

export interface Interface {
  /** Applies config settings. Changing model/tier/url/path restarts the pipeline; "off" stops the local server. Idempotent for equal settings. If autostart is enabled for this node (Options.autostart) or start() was already called, (re)starts the background pipeline. */
  readonly configure: (settings: ConfigMessaging.Info["embedding"] | undefined) => Effect.Effect<void>
  /** Overrides the configured model source: a tier replaces a configured URL or path, and a URL or path replaces the other. Other settings (remote endpoint, server, threads) are kept; an empty choice changes nothing. */
  readonly select: (choice: {
    readonly tier?: string
    readonly url?: string
    readonly path?: string
  }) => Effect.Effect<void>
  /** Starts the background pipeline now (download llama.cpp + model, launch server) if not already running. Never blocks on the download. */
  readonly start: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Messaging.ModelStatus>
  /** The model that embed() would use right now (local when ready, else remote when configured), or undefined. */
  readonly model: () => Effect.Effect<{ readonly id: string; readonly dimensions?: number } | undefined>
  /** Waits until some model is usable, then returns it (never fails; may wait forever). */
  readonly ready: Effect.Effect<{ readonly id: string; readonly dimensions?: number }>
  /** L2-normalized vectors, one per text. kind "query" prepends the model's query instruction. */
  readonly embed: (
    texts: ReadonlyArray<string>,
    kind: "query" | "document",
  ) => Effect.Effect<{ readonly model: string; readonly vectors: ReadonlyArray<Float32Array> }, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MessagingEmbedding") {}

type Phase = "pending" | "downloading" | "starting" | "ready" | "error" | "unavailable"

interface State {
  /** The last configured value, so a runtime selection can keep the settings it does not change. */
  input: ConfigMessaging.Info["embedding"] | undefined
  settings: Settings
  key: string
  started: boolean
  booted: boolean
  fiber: Fiber.Fiber<void, unknown> | undefined
  phase: Phase
  error: string | undefined
  server: string | undefined
  endpoint: string | undefined
  dimensions: number | undefined
  file: string | undefined
}

interface Target {
  readonly id: string
  readonly dimensions?: number
  readonly url: string
  readonly model: string
  readonly key?: string
  readonly query?: string
  readonly remote: boolean
  readonly limit: number
}

const EmbeddingResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ index: Schema.Number, embedding: Schema.Array(Schema.Number) })),
})

const backoff = Schedule.exponential("2 seconds").pipe(
  Schedule.modifyDelay((meta) => Effect.succeed(Duration.min(meta.duration, Duration.minutes(5)))),
)

const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const spawner = yield* ChildProcessSpawner
      const global = yield* Global.Service
      const scope = yield* Effect.scope
      const hardware = yield* Effect.sync(detect)
      const lock = Semaphore.makeUnsafe(1)
      const usable = Latch.makeUnsafe(false)
      const firstConfig = Deferred.makeUnsafe<void>()
      const progress = new Map<string, Messaging.ModelProgress>()
      const initial = resolve(undefined)
      const state: State = {
        input: undefined,
        settings: initial,
        key: JSON.stringify(initial),
        started: false,
        booted: false,
        fiber: undefined,
        phase: "pending",
        error: undefined,
        server: undefined,
        endpoint: undefined,
        dimensions: undefined,
        file: undefined,
      }

      const blocked = (settings: Settings) => {
        if (settings.error) return settings.error
        const local = settings.local
        if (local?.gate && !available(local.gate, hardware))
          return `The ${local.gate} embedding tier (${local.name}) needs more hardware than this machine has: ${tiers.find((tier) => tier.name === local.gate)?.hardware}`
      }

      const target = (): Target | undefined => {
        const local = state.settings.local
        if (local && state.phase === "ready" && state.endpoint)
          return {
            id: local.id,
            dimensions: state.dimensions,
            url: `${state.endpoint}/v1`,
            model: local.id,
            query: local.query,
            remote: false,
            limit: Math.min(MAX_CHARS, local.context * 2),
          }
        const remote = state.settings.remote
        if (!remote) return
        return {
          id: `remote:${remote.model}`,
          dimensions: remote.dimensions,
          url: remote.url.replace(/\/$/, ""),
          model: remote.model,
          key: remote.key,
          query: remote.query,
          remote: true,
          limit: MAX_CHARS,
        }
      }

      const refresh = () => (target() ? usable.openUnsafe() : usable.closeUnsafe())

      const track = (file: string) => (received: number, total: number | undefined) =>
        progress.set(file, { file, received, total })

      const run = Effect.fnUntraced(function* (command: string, args: string[], cwd: string) {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd, extendEnv: true, stdin: "ignore" }))
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        )
        return { stdout, stderr, code }
      }, Effect.scoped)

      const executable = process.platform === "win32" ? "llama-server.exe" : "llama-server"
      const llamaRoot = path.join(global.bin, "llama.cpp")
      const llamaDir = path.join(llamaRoot, LLAMA_BUILD)

      const findServer = (dir: string) =>
        Effect.promise(() =>
          readdir(dir, { recursive: true }).then(
            (entries) => entries.find((entry) => path.basename(entry) === executable),
            () => undefined,
          ),
        ).pipe(Effect.map((entry) => (entry === undefined ? undefined : path.join(dir, entry))))

      const installServer = Effect.fnUntraced(function* (asset: {
        readonly name: string
        readonly sha256: string
        readonly size: number
      }) {
        const archive = path.join(llamaRoot, asset.name)
        state.phase = "downloading"
        yield* download({
          url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${asset.name}`,
          dest: archive,
          sha256: asset.sha256,
          size: asset.size,
          onProgress: track(asset.name),
        })
        const staging = `${llamaDir}.tmp`
        yield* Effect.tryPromise({ try: () => rm(staging, { recursive: true, force: true }), catch: toError })
        yield* Effect.tryPromise({ try: () => mkdir(staging, { recursive: true }), catch: toError })
        // Windows zips go through the bsdtar in System32, as ripgrep does: Git's GNU tar cannot read zip, and bsdtar
        // only sees the ASCII archive name relative to the staging directory.
        const result = yield* asset.name.endsWith(".zip")
          ? run(
              path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
              ["-xf", path.relative(staging, archive)],
              staging,
            )
          : run("tar", ["-xzf", archive, "-C", staging], staging)
        if (result.code !== 0)
          return yield* Effect.fail(
            new Error(result.stderr.trim() || result.stdout.trim() || `llama.cpp extraction failed (${result.code})`),
          )
        yield* Effect.tryPromise({ try: () => rename(staging, llamaDir), catch: toError })
        yield* Effect.promise(() => rm(archive, { force: true }))
        const server = yield* findServer(llamaDir)
        if (!server) return yield* Effect.fail(new Error(`llama.cpp ${LLAMA_BUILD} archive has no ${executable}`))
        if (process.platform !== "win32") yield* Effect.tryPromise({ try: () => chmod(server, 0o755), catch: toError })
        return server
      })

      // The extracted tree is kept whole: the macOS build ships its dylibs next to the binary.
      const ensureServer = Effect.fnUntraced(function* (local: Local) {
        if (local.server) return local.server
        const system = which(executable)
        if (system) return system
        const installed = yield* findServer(llamaDir)
        if (installed) return installed
        const asset = LLAMA_ASSETS[`${process.platform}-${process.arch}`]
        if (!asset) return undefined
        return yield* installServer(asset)
      })

      const ensureModel = Effect.fnUntraced(function* (local: Local) {
        if (local.path) return local.path
        const dest = path.join(global.cache, "models", local.file)
        const present = yield* Effect.promise(() => exists(dest))
        if (present) {
          // A cached file is trusted only when it still matches the model's integrity metadata;
          // a mismatch (or an unreadable file) is deleted and downloaded fresh, never served as-is.
          const valid = yield* Effect.tryPromise({
            try: async (signal) => {
              if (local.size !== undefined && (await stat(dest)).size !== local.size) return false
              if (!local.sha256) return true
              const hash = createHash("sha256")
              await hashFile(dest, hash, signal)
              return hash.digest("hex") === local.sha256
            },
            catch: toError,
          }).pipe(Effect.orElseSucceed(() => false))
          if (valid) return dest
          yield* Effect.promise(() => rm(dest, { force: true }))
        }
        if (!local.url) return yield* Effect.fail(new Error(`No download URL for ${local.name}`))
        state.phase = "downloading"
        yield* download({
          url: local.url,
          dest,
          sha256: local.sha256,
          size: local.size,
          onProgress: track(local.file),
        })
        return dest
      })

      const freePort = Effect.callback<number, Error>((resume) => {
        const server = net.createServer()
        server.once("error", (error) => resume(Effect.fail(error)))
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          const port = typeof address === "object" && address ? address.port : 0
          server.close(() => resume(port > 0 ? Effect.succeed(port) : Effect.fail(new Error("no free port"))))
        })
      })

      const request = Effect.fnUntraced(
        function* (target: Target, input: ReadonlyArray<string>) {
          const body = target.remote
            ? { model: target.model, input, ...(target.dimensions ? { dimensions: target.dimensions } : {}) }
            : { model: target.model, input, encoding_format: "float" }
          const base = HttpClientRequest.post(`${target.url}/embeddings`).pipe(HttpClientRequest.bodyJsonUnsafe(body))
          const response = yield* http.execute(target.key ? HttpClientRequest.bearerToken(base, target.key) : base)
          if (response.status !== 200) {
            // Bounded read (#1079): an over-cap error body degrades to the status-only error below
            // (empty text) instead of buffering whole; small bodies still surface their first 500 chars.
            const text = yield* Effect.scoped(
              collectBoundedResponseBody(
                response,
                embeddingErrorMaxResponseBytes,
                () => new Error(`embeddings error response exceeded ${embeddingErrorMaxResponseBytes} bytes`),
              ),
            ).pipe(
              Effect.map((body) => body.toString("utf8")),
              Effect.orElseSucceed(() => ""),
            )
            return yield* Effect.fail(
              new Error(`HTTP ${response.status} from ${target.url}/embeddings: ${text.slice(0, 500)}`),
            )
          }
          // Bounded read (#1079): collect the body under the cap first (declared-length pre-check plus
          // in-flight bound), then decode the bounded bytes instead of schemaBodyJson on the raw response.
          const raw = yield* Effect.scoped(
            collectBoundedResponseBody(
              response,
              embeddingMaxResponseBytes,
              () => new Error(`embeddings response exceeded ${embeddingMaxResponseBytes} bytes`),
            ),
          )
          const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(EmbeddingResponse))(
            raw.toString("utf8"),
          )
          if (decoded.data.length !== input.length)
            return yield* Effect.fail(new Error(`expected ${input.length} embeddings, got ${decoded.data.length}`))
          return decoded.data
            .toSorted((left, right) => left.index - right.index)
            .map((item) => normalize(item.embedding))
        },
        // A stalled endpoint must fail, so searches fall back to text matching instead of waiting forever.
        (effect, target) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: REQUEST_TIMEOUT,
              orElse: () => Effect.fail(new Error(`timed out waiting for ${target.url}/embeddings`)),
            }),
          ),
      )

      const serve = Effect.fnUntraced(
        function* (local: Local, server: string, file: string) {
          state.phase = "starting"
          state.server = server
          state.file = file
          const port = yield* freePort
          const context = String(local.context)
          const args = [
            "-m",
            file,
            "--embedding",
            "--pooling",
            local.pooling,
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "-c",
            context,
            "-ub",
            context,
            "-b",
            context,
            "-ngl",
            String(local.gpu_layers ?? 999),
            ...(local.threads ? ["-t", String(local.threads)] : []),
          ]
          const handle = yield* spawner.spawn(
            ChildProcess.make(server, args, { extendEnv: true, stdin: "ignore", stdout: "ignore", stderr: "pipe" }),
          )
          const tail = { text: "" }
          yield* Stream.runForEach(Stream.decodeText(handle.stderr), (text) =>
            Effect.sync(() => {
              tail.text = (tail.text + text).slice(-4096)
            }),
          ).pipe(Effect.ignore, Effect.forkScoped)
          const exited = handle.exitCode.pipe(
            Effect.mapError(toError),
            Effect.flatMap((code) =>
              Effect.fail(new Error(`llama-server exited with code ${code}: ${tail.text.trim().slice(-1000)}`)),
            ),
          )
          const endpoint = `http://127.0.0.1:${port}`
          const health = http.execute(HttpClientRequest.get(`${endpoint}/health`)).pipe(
            Effect.flatMap((response) =>
              response.status === 200 ? Effect.void : Effect.fail(new Error(`health ${response.status}`)),
            ),
            Effect.retry(Schedule.spaced("250 millis")),
            Effect.timeoutOrElse({
              duration: "180 seconds",
              orElse: () =>
                Effect.fail(new Error(`llama-server did not become healthy: ${tail.text.trim().slice(-1000)}`)),
            }),
          )
          yield* Effect.raceFirst(health, exited)
          const [probe] = yield* request(
            {
              id: local.id,
              url: `${endpoint}/v1`,
              model: local.id,
              remote: false,
              limit: MAX_CHARS,
            },
            ["dimension probe"],
          ).pipe(Effect.mapError(toError))
          state.dimensions = probe?.length ?? local.dimensions
          state.endpoint = endpoint
          state.phase = "ready"
          state.error = undefined
          refresh()
          yield* Effect.logInfo("embedding model ready", { model: local.id, endpoint })
          return yield* exited
        },
        Effect.ensuring(
          Effect.sync(() => {
            state.endpoint = undefined
            refresh()
          }),
        ),
        Effect.scoped,
      )

      const pipeline = (local: Local) =>
        Effect.gen(function* () {
          state.phase = "starting"
          if (local.path && !(yield* Effect.promise(() => exists(local.path ?? "")))) {
            state.phase = "unavailable"
            state.error = `Embedding model file not found: ${local.path}`
            return
          }
          const [server, file] = yield* Effect.all([ensureServer(local), ensureModel(local)], { concurrency: 2 })
          if (!server) {
            state.phase = "unavailable"
            state.error = `llama.cpp has no build for ${process.platform}-${process.arch}; set messaging.embedding.server`
            return
          }
          yield* serve(local, server, file)
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              state.phase = "error"
              state.error = error instanceof Error ? error.message : String(error)
              yield* Effect.logWarning("embedding pipeline failed", { error: state.error })
            }),
          ),
          Effect.retry(backoff),
          Effect.ignore,
          Effect.provideService(HttpClient.HttpClient, http),
        )

      const launch = lock.withPermit(
        Effect.gen(function* () {
          if (state.fiber) return
          const local = state.settings.local
          if (!local || blocked(state.settings)) return
          state.fiber = yield* pipeline(local).pipe(Effect.forkIn(scope))
        }),
      )

      const configure = Effect.fn("MessagingEmbedding.configure")(function* (
        input: ConfigMessaging.Info["embedding"] | undefined,
      ) {
        state.input = input
        const next = resolve(input)
        const key = JSON.stringify(next)
        yield* lock.withPermit(
          Effect.gen(function* () {
            if (key === state.key) return
            const fiber = state.fiber
            state.fiber = undefined
            if (fiber) yield* Fiber.interrupt(fiber)
            state.settings = next
            state.key = key
            state.phase = "pending"
            state.error = undefined
            state.server = undefined
            state.endpoint = undefined
            state.dimensions = undefined
            state.file = undefined
            progress.clear()
            refresh()
          }),
        )
        if (state.started || (options.autostart && state.booted && next.autostart)) yield* launch
        yield* Deferred.succeed(firstConfig, undefined)
      })

      const select: Interface["select"] = Effect.fn("MessagingEmbedding.select")(function* (choice) {
        if (!choice.tier && !choice.url && !choice.path) return
        const current = typeof state.input === "string" ? { tier: state.input } : (state.input ?? {})
        const currentUrl = "url" in current ? current.url : undefined
        const currentPath = "path" in current ? current.path : undefined
        // sha256/size pin one specific source file: replacing the source clears them, while
        // re-selecting the identical url/path keeps them.
        const replaces =
          choice.tier !== undefined ||
          ((choice.url !== undefined || choice.path !== undefined) &&
            (choice.url !== currentUrl || choice.path !== currentPath))
        yield* configure(
          new ConfigMessaging.Embedding({
            ...current,
            ...(replaces ? { sha256: undefined, size: undefined } : {}),
            ...(choice.tier ? { tier: choice.tier, url: undefined, path: undefined } : {}),
            ...(choice.url || choice.path ? { url: choice.url, path: choice.path } : {}),
          }),
        )
      })

      const start = Effect.fn("MessagingEmbedding.start")(function* () {
        state.started = true
        yield* launch
      })

      const describe = () => {
        const settings = state.settings
        const local = settings.local
        const reason = blocked(settings)
        if (reason) return reason
        if (!local) return "Local embeddings are off and no remote embeddings endpoint is configured"
        if (state.phase === "pending") return `The embedding model ${local.name} has not been started`
        if (state.phase === "downloading") {
          const entries = [...progress.values()]
          const received = entries.reduce((sum, item) => sum + item.received, 0)
          const total = entries.reduce((sum, item) => sum + (item.total ?? 0), 0)
          return total > 0
            ? `downloading ${Math.floor((received / total) * 100)}% of ${local.name}`
            : `downloading ${local.name}`
        }
        if (state.phase === "starting") return `starting llama-server for ${local.name}`
        return `${local.name} is unavailable${state.error ? `: ${state.error}` : ""}`
      }

      const status = Effect.fn("MessagingEmbedding.status")(function* () {
        const settings = state.settings
        const local = settings.local
        const current = target()
        const shared = {
          remote: current?.remote ? true : undefined,
          progress: progress.size > 0 ? [...progress.values()] : undefined,
          tiers: tiers.map((tier) => ({
            name: tier.name,
            model: tier.model,
            size: formatSize(tier.size),
            hardware: tier.hardware,
            available: available(tier.name, hardware),
          })),
        }
        const remote = current?.remote ? { source: current.url, dimensions: current.dimensions } : {}
        const reason = blocked(settings)
        if (reason)
          return {
            ...shared,
            ...remote,
            state: "unavailable",
            tier: local?.tier,
            model: local?.name,
            error: reason,
          } satisfies Messaging.ModelStatus
        if (!local) return { ...shared, ...remote, state: "off" } satisfies Messaging.ModelStatus
        return {
          ...shared,
          state: state.phase,
          tier: local.tier,
          model: local.name,
          dimensions: state.dimensions ?? local.dimensions,
          path: state.file ?? local.path ?? path.join(global.cache, "models", local.file),
          source: local.path ?? local.url,
          server: state.server,
          endpoint: state.endpoint,
          error: state.error,
        } satisfies Messaging.ModelStatus
      })

      const model = Effect.fn("MessagingEmbedding.model")(function* () {
        const current = target()
        if (!current) return undefined
        return { id: current.id, dimensions: current.dimensions }
      })

      const ready: Effect.Effect<{ readonly id: string; readonly dimensions?: number }> = Effect.gen(function* () {
        while (true) {
          yield* usable.await
          const current = target()
          if (current) return { id: current.id, dimensions: current.dimensions }
          // The latch can open just before the state flips back; wait briefly rather than spin.
          yield* Effect.sleep("100 millis")
        }
      })

      const embed = Effect.fn("MessagingEmbedding.embed")(function* (
        texts: ReadonlyArray<string>,
        kind: "query" | "document",
      ) {
        const current = target()
        if (!current) return yield* new UnavailableError({ message: describe() })
        const prefix = kind === "query" ? (current.query ?? "") : ""
        const inputs = texts.map((text) => {
          const clipped = text.slice(0, current.limit)
          return prefix + (clipped.trim() === "" ? " " : clipped)
        })
        const batches = Array.from({ length: Math.ceil(inputs.length / BATCH) }, (_, index) =>
          inputs.slice(index * BATCH, (index + 1) * BATCH),
        )
        const vectors = yield* Effect.forEach(batches, (batch) => request(current, batch)).pipe(
          Effect.mapError(
            (error) => new UnavailableError({ message: `Embedding request to ${current.id} failed: ${error.message}` }),
          ),
        )
        return { model: current.id, vectors: vectors.flat() }
      })

      if (options.autostart)
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* Effect.raceFirst(Deferred.await(firstConfig), Effect.sleep(options.delay ?? "15 seconds"))
            state.booted = true
            if (state.settings.autostart) yield* launch
          }),
        )

      refresh()
      return Service.of({ configure, select, start, status, model, ready, embed })
    }),
  )

function normalize(values: ReadonlyArray<number>) {
  const vector = Float32Array.from(values)
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (norm === 0) return vector
  return vector.map((value) => value / norm)
}

function formatSize(bytes: number) {
  if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`
  return `${(bytes / 1e9).toFixed(1)} GB`
}

export const configured = (options: Options = {}) =>
  makeGlobalNode({
    service: Service,
    layer: layer(options),
    deps: [Global.node, httpClient, CrossSpawnSpawner.node],
  })

export const node = configured()
