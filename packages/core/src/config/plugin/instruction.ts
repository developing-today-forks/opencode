export * as ConfigInstructionPlugin from "./instruction.js"

import { define } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { sameDirectory } from "@opencode/util/path"
import net from "node:net"
import path, { dirname, join } from "path"
import { Effect, FiberMap, PubSub, Semaphore, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Config } from "../../config.js"
import { Watcher } from "../../filesystem/watcher.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Instructions } from "../../instructions/index.js"
import { Location } from "../../location.js"
import { collectBoundedResponseBody } from "../../tool/http-body.js"

type Loaded =
  | { readonly type: "available"; readonly files: InstructionDiscovery.File[] }
  | { readonly type: "unavailable" }

/**
 * Maximum remote instruction body, in bytes.
 *
 * Instruction files (AGENTS.md-style documents) are small; even a large
 * one is tens of kilobytes, so 256 KiB leaves ample headroom while
 * keeping a bad or hostile instruction URL from buffering unbounded
 * content into memory and the model's context at config load.
 */
export const maxRemoteInstructionBytes = 256 * 1024

/**
 * Maximum redirects followed for one remote instruction fetch.
 *
 * Redirects are followed manually under the policy on
 * `resolveInstructionRedirect`; the hop bound keeps a redirect loop from
 * spinning until the fetch timeout, and exceeding it fails the fetch.
 */
export const maxRemoteInstructionRedirects = 5

export const Plugin = define({
  id: "opencode.config.instruction",
  effect: Effect.fn(function* (ctx) {
    const discovery = yield* InstructionDiscovery.Service
    // Activate even when both discovery scopes are disabled: configured `instructions`
    // entries are explicit requests, not discovery.
    yield* Effect.gen(function* () {
      const config = yield* Config.Service
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const http = yield* HttpClient.HttpClient
      const location = yield* Location.Service
      const watcher = yield* Watcher.Service
      const changes = yield* PubSub.sliding<string>(1)
      const watches = yield* FiberMap.make<string>()
      const lock = Semaphore.makeUnsafe(1)
      const start = yield* fs.resolve(location.directory)
      const root = yield* fs.resolve(location.project.directory)
      const home = yield* fs.resolve(global.home)
      const project = discovery.project && FSUtil.contains(root, start)
      const stop = FSUtil.contains(home, start) ? home : root
      const globalFile = yield* fs.resolve(join(global.config, "AGENTS.md"))
      const loaded: { current: Loaded } = { current: { type: "available", files: [] } }
      const configured: { sources: string[]; remote: Map<string, InstructionDiscovery.File> } = {
        sources: [],
        remote: new Map(),
      }

      const publish = (update: Watcher.Update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)
      // The ancestor walk can reach the global file when the location sits
      // beneath the global config dir; global: false excludes it there too.
      const candidates = [
        ...(discovery.global ? [globalFile] : []),
        ...(project
          ? ancestorDirectories(start, stop)
              .map((directory) => join(directory, "AGENTS.md"))
              .filter((file) => discovery.global || file !== globalFile)
          : []),
      ]
      for (const file of new Set(candidates)) {
        const updates = yield* watcher.subscribe({ path: file, type: "file" })
        yield* updates.pipe(Stream.runForEach(publish), Effect.forkScoped({ startImmediately: true }))
      }

      const read = Effect.fn("ConfigInstructionPlugin.read")(function* (filepath: string) {
        const content = yield* fs.readFileStringSafe(filepath)
        if (content !== undefined) return new InstructionDiscovery.File({ path: filepath, content })
        yield* Effect.logDebug("instruction file skipped", { path: filepath, reason: "unavailable" })
      })

      const globalSource = Effect.fn("ConfigInstructionPlugin.globalSource")(function* () {
        if (!discovery.global || !(yield* fs.isFile(globalFile))) return []
        const file = yield* read(globalFile)
        return file ? [file] : []
      })

      const projectSource = Effect.fn("ConfigInstructionPlugin.projectSource")(function* () {
        if (!project) return []
        const walked = yield* Effect.forEach(
          yield* fs.up({ targets: ["AGENTS.md"], start, stop, type: "file" }),
          fs.resolve,
        )
        const discovered = new Set(walked.filter((file) => discovery.global || file !== globalFile))
        const files = yield* Effect.forEach(discovered, read, { concurrency: "unbounded" })
        if (files.some((file) => file === undefined)) return Instructions.unavailable
        return files.filter((file): file is InstructionDiscovery.File => file !== undefined)
      })

      // Relative patterns search upward from the location to the project root. Without
      // project discovery they resolve against the global config directory instead.
      const match = Effect.fn("ConfigInstructionPlugin.match")(function* (source: string) {
        const expanded = source.startsWith("~/") ? path.join(global.home, source.slice(2)) : source
        const options = { absolute: true, include: "file", dot: true } as const
        if (path.isAbsolute(expanded))
          return yield* fs
            .scan(path.basename(expanded), { ...options, cwd: path.dirname(expanded) })
            .pipe(Effect.orElseSucceed(() => [] as string[]))
        if (project) return yield* fs.globUp(expanded, start, root)
        if (!discovery.global) return []
        return yield* fs
          .scan(expanded, { ...options, cwd: global.config })
          .pipe(Effect.orElseSucceed(() => [] as string[]))
      })

      const configuredSource = Effect.fn("ConfigInstructionPlugin.configuredSource")(function* () {
        const files: InstructionDiscovery.File[] = []
        const watched = new Set<string>()
        for (const source of configured.sources) {
          if (isUrl(source)) {
            const file = configured.remote.get(source)
            if (file) files.push(file)
            continue
          }
          for (const item of (yield* match(source)).toSorted()) {
            const resolved = yield* fs.resolve(item)
            if (watched.has(resolved)) continue
            watched.add(resolved)
            const file = yield* read(resolved)
            if (file) files.push(file)
          }
        }
        for (const [key] of Array.from(watches)) if (!watched.has(key)) yield* FiberMap.remove(watches, key)
        for (const file of watched) {
          const updates = yield* watcher.subscribe({ path: file, type: "file" })
          yield* FiberMap.run(watches, file, updates.pipe(Stream.runForEach(publish)), {
            onlyIfMissing: true,
            startImmediately: true,
          })
        }
        return files
      })

      // Redirects are followed manually: the transport must not follow them
      // itself, or a configured URL could redirect to a destination that was
      // never checked (the webfetch policy, #2283, applied to this fetch).
      // Every destination must pass resolveInstructionRedirect before it is
      // requested; the final response must carry a success status, exactly
      // as the filterStatusOk wrapper enforced before manual following.
      const fetchRemote = Effect.fn("ConfigInstructionPlugin.fetchRemote")(function* (url: string) {
        let current = url
        let redirects = 0
        while (true) {
          const response = yield* HttpClientRequest.get(current).pipe(
            http.execute,
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          )
          if (!isRedirectResponse(response)) {
            const ok = yield* HttpClientResponse.filterStatusOk(response)
            return yield* Effect.scoped(
              collectBoundedResponseBody(
                ok,
                maxRemoteInstructionBytes,
                () => new Error(`instruction url response exceeded ${maxRemoteInstructionBytes} bytes`),
              ),
            )
          }
          if (redirects >= maxRemoteInstructionRedirects)
            return yield* Effect.fail(new Error(`instruction url exceeded ${maxRemoteInstructionRedirects} redirects`))
          redirects++
          const location = response.headers["location"]!
          current = yield* Effect.try({
            try: () => resolveInstructionRedirect(current, location),
            catch: (error) =>
              error instanceof Error ? error : new Error(`instruction url redirect failed: ${String(error)}`),
          })
        }
      })

      // Remote instructions are fetched only when config loads, not on every file rescan.
      // A failed fetch keeps the last good copy or skips the URL, so an unreachable URL
      // never makes the whole instruction set unavailable.
      const reconfigure = Effect.fn("ConfigInstructionPlugin.reconfigure")(
        function* () {
          const entries = yield* config.entries()
          const sources = Array.from(
            new Set(entries.flatMap((entry) => (entry.type === "document" ? (entry.info.instructions ?? []) : []))),
          )
          const fetched = yield* Effect.forEach(
            sources.filter(isUrl),
            (url) =>
              fetchRemote(url).pipe(
                Effect.map((body) => body.toString("utf8")),
                Effect.timeout("5 seconds"),
                Effect.map((content) => new InstructionDiscovery.File({ path: url, content })),
                Effect.catchCause((cause) =>
                  Effect.logWarning("failed to fetch instruction url", { url, cause }).pipe(
                    Effect.as(configured.remote.get(url)),
                  ),
                ),
              ),
            { concurrency: 4 },
          )
          configured.sources = sources
          configured.remote = new Map(
            fetched.filter((file) => file !== undefined).map((file) => [file.path, file] as const),
          )
        },
        (effect) => lock.withPermit(effect),
      )

      const isolate = <A, E, R>(source: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to load instruction source", { source, cause }).pipe(
              Effect.as(Instructions.unavailable),
            ),
          ),
        )

      const refresh = Effect.fn("ConfigInstructionPlugin.refresh")(
        function* (file?: string) {
          const sources = yield* Effect.all({
            global: isolate("global", globalSource()),
            project: isolate("project", projectSource()),
            configured: isolate("configured", configuredSource()),
          })
          loaded.current =
            Array.isArray(sources.global) && Array.isArray(sources.project) && Array.isArray(sources.configured)
              ? { type: "available", files: [...sources.global, ...sources.project, ...sources.configured] }
              : { type: "unavailable" }
          if (!file) return
          yield* Effect.logDebug("instructions rescanned", {
            file,
            instructions:
              loaded.current.type === "available" ? loaded.current.files.map((item) => item.path) : "unavailable",
          })
        },
        (effect, ..._args: [file?: string]) => lock.withPermit(effect),
      )

      // Editor saves arrive as bursts of watcher events; settle before rescanning once. Subscribe
      // before debouncing so no update slips through while the debounce starts its pull.
      const updates = yield* PubSub.subscribe(changes)
      yield* Stream.fromSubscription(updates).pipe(
        Stream.debounce("100 millis"),
        Stream.runForEach((file) => refresh(file).pipe(Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      // Subscribe before the first config read so an update in between still triggers a reload.
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "config.updated"),
        Stream.runForEach(() => reconfigure().pipe(Effect.andThen(refresh()), Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* reconfigure()
      yield* refresh()
      yield* discovery.transform((editor) => {
        if (loaded.current.type === "unavailable") {
          editor.unavailable()
          return
        }
        for (const file of loaded.current.files) editor.add(file)
      })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to activate instruction source", { cause }).pipe(
          Effect.andThen(discovery.transform((editor) => editor.unavailable())),
          Effect.asVoid,
        ),
      ),
    )
  }),
})

// `start` keeps the client's spelling while `stop` may come from git, so a Windows drive
// letter can differ only in case (`c:\repo` vs `C:\repo`). Compare the way FSUtil.contains
// admitted `start` beneath `stop`, or the walk passes `stop` and recurses at the drive root.
function ancestorDirectories(start: string, stop: string): string[] {
  if (sameDirectory(start, stop)) return [start]
  return [start, ...ancestorDirectories(dirname(start), stop)]
}

function isUrl(source: string) {
  return URL.canParse(source) && /^https?:$/.test(new URL(source).protocol)
}

function isRedirectResponse(response: HttpClientResponse.HttpClientResponse) {
  return response.status >= 300 && response.status < 400 && response.headers["location"] !== undefined
}

/**
 * Redirect trust policy for remote instruction fetches.
 *
 * The configured URL itself is an explicit user choice and is fetched as
 * configured — including a loopback or LAN address the user deliberately
 * picked for their own instruction server. Redirect destinations are
 * different: they are chosen by the remote server, not the user, so every
 * hop is revalidated here before it is requested.
 *
 * A redirect is followed only when the destination
 * - resolves against the current URL (a malformed `Location` fails closed),
 * - uses http: or https:, and
 * - does not move the fetch from a non-local origin into the local network:
 *   a destination whose host is a local or private address is rejected
 *   unless the URL issuing the redirect is itself local or private. A
 *   public host therefore cannot trampoline the local process into
 *   internal services, while a deliberately configured local source keeps
 *   working, redirects included.
 *
 * Same-origin and public cross-origin redirects are allowed. Hostnames
 * other than the localhost family are taken at face value: name
 * resolution is not re-checked, so a public name that resolves to a
 * private address is out of scope for this layer.
 */
export function resolveInstructionRedirect(current: string, location: string): string {
  let destination: URL
  try {
    destination = new URL(location, current)
  } catch {
    throw new Error(`instruction url redirect location is invalid: ${location}`)
  }
  if (destination.protocol !== "http:" && destination.protocol !== "https:")
    throw new Error(`instruction url redirect to unsupported protocol: ${destination.protocol}`)
  if (isLocalOrPrivateHost(destination.hostname) && !isLocalOrPrivateHost(new URL(current).hostname))
    throw new Error(`instruction url redirect to a local or private destination is not allowed: ${destination.hostname}`)
  return destination.toString()
}

/**
 * Whether a URL hostname names the local machine or a non-public network:
 * the localhost family, or an IP literal in a loopback, private,
 * link-local, unique-local, shared (CGNAT), benchmarking, documentation,
 * or reserved range. Anything else — including ordinary DNS names — is
 * treated as public.
 */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const lowered = hostname.toLowerCase().replace(/\.$/, "")
  const host = lowered.startsWith("[") && lowered.endsWith("]") ? lowered.slice(1, -1) : lowered
  if (host === "localhost" || host.endsWith(".localhost")) return true
  const version = net.isIP(host)
  if (version === 4) return isNonPublicIPv4(host)
  if (version === 6) return isNonPublicIPv6(host)
  return false
}

function isNonPublicIPv4(host: string): boolean {
  const [a, b, c] = host.split(".").map(Number)
  if (a === 0 || a === 10 || a === 127) return true // "this" network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT shared address space
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 240) return true // reserved, incl. the limited broadcast address
  return false
}

function isNonPublicIPv6(host: string): boolean {
  const groups = expandIPv6(host)
  if (!groups) return true // fail closed: a v6 literal we cannot classify is not public
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number]
  if (groups.every((group) => group === 0)) return true // :: unspecified
  if (g7 === 1 && groups.slice(0, 7).every((group) => group === 0)) return true // ::1 loopback
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true // fe80::/10 link-local
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true // fc00::/7 unique-local
  if (g0 >= 0xff00) return true // multicast
  // IPv4-mapped (::ffff:0:0/96) and NAT64 well-known (64:ff9b::/96)
  // destinations are classified by the IPv4 address they embed.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff)
    return isNonPublicIPv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return isNonPublicIPv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`)
  return false
}

function expandIPv6(host: string): number[] | undefined {
  const halves = host.split("::")
  if (halves.length > 2) return undefined
  const parseSide = (side: string): number[] | undefined => {
    if (side === "") return []
    const groups: number[] = []
    for (const part of side.split(":")) {
      if (part.includes(".")) {
        const v4 = part.split(".").map(Number)
        if (v4.length !== 4 || v4.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined
        groups.push(parseInt(part, 16))
      }
    }
    return groups
  }
  const left = parseSide(halves[0])
  const right = halves.length === 2 ? parseSide(halves[1]) : []
  if (left === undefined || right === undefined) return undefined
  if (halves.length === 1) return left.length === 8 ? left : undefined
  const missing = 8 - left.length - right.length
  if (missing < 1) return undefined
  return [...left, ...new Array<number>(missing).fill(0), ...right]
}
