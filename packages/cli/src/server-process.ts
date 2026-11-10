export * as ServerProcess from "./server-process"

import { NodeServices } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_VERSION } from "./version"
import { AppProcess } from "@opencode/util/process"
import { randomBytes, randomUUID } from "node:crypto"
import { Cause, Effect, Option, Redacted, Schema } from "effect"
import { PersistentPty } from "@opencode/schema/persistent-pty"
import { HttpServer } from "effect/http"
import { NetAddress } from "effect/net"
import { Env } from "./env"
import { ServiceConfig } from "./services/service-config"
import { ServerConnection } from "./services/server-connection"
import { RetainedImage } from "./services/retained-image"
import { ServiceRegistration } from "./services/service-registration"
import { RemoteTunnel } from "./services/remote-tunnel"
import { WebUi } from "./services/web-ui"
import { databasePath } from "./database-path"
import { inheritedListenFd, notifyReady } from "./systemd"

export type Mode = "default" | "service" | "stdio"

export type Options = {
  readonly mode: Mode
  readonly hostname?: string
  readonly port?: number
  readonly cors?: readonly string[]
}

/** A compatible managed service already bound to the service URL, as probed without a version requirement. */
export type ServiceIncumbent = {
  readonly version?: string
  readonly pid?: number
}

/**
 * What a deliberate `serve --service` start does about an incumbent (code#8255): no incumbent
 * proceeds to bind; an incumbent on this build's version is an explicit already-current no-op
 * (same code = no restart); any other version is taken over, because service mode is only
 * entered deliberately (see the call site in processEffect for why that makes takeover on any
 * mismatch safe here, unlike a passive client probe).
 */
export function incumbentDecision(incumbent: ServiceIncumbent | undefined, version: string = OPENCODE_VERSION) {
  if (incumbent === undefined) return { _tag: "proceed" } as const
  if (incumbent.version !== undefined && incumbent.version === version)
    return { _tag: "already-current", version: incumbent.version, pid: incumbent.pid } as const
  return { _tag: "takeover", version: incumbent.version, pid: incumbent.pid } as const
}

/**
 * Stop an incumbent so this build can bind in its place. The stop effect is injected so tests
 * can observe the handoff stop and its failure without a live service. A failed stop is a loud
 * failure: exiting 0 here would report a successful start that never bound, which is exactly
 * the silent no-op this takeover exists to remove.
 */
export function takeoverIncumbent<R>(
  incumbent: ServiceIncumbent,
  stop: Effect.Effect<void, unknown, R>,
  version: string = OPENCODE_VERSION,
) {
  return Effect.gen(function* () {
    yield* Effect.sync(() =>
      console.log(
        `managed service version ${incumbent.version ?? "unknown"} (pid ${incumbent.pid ?? "unknown"}) is running; taking over with version ${version}`,
      ),
    )
    yield* stop.pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          new Error(
            `Failed to stop managed service version ${incumbent.version ?? "unknown"} (pid ${incumbent.pid ?? "unknown"}) so version ${version} could take over; refusing to exit without binding`,
            { cause: Cause.squash(cause) },
          ),
        ),
      ),
    )
  })
}

// The process effect lives until server shutdown; tracing it would parent every request to one process-lifetime trace.
export const run = Effect.fnUntraced(function* (options: Options) {
  return yield* processEffect(options).pipe(
    Effect.provide(
      LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, FSUtil.node]), {
        replacements: [
          Global.node.replace(
            Global.layerWith(process.env.OPENCODE_CONFIG_DIR ? { config: process.env.OPENCODE_CONFIG_DIR } : {}),
          ),
        ],
      }),
    ),
    Effect.provide(NodeServices.layer),
  )
})

const processEffect = Effect.fnUntraced(function* (options: Options) {
  // A supervisor that passed us its listening socket owns the handover; drop the variables so children never see them.
  const listenFd = inheritedListenFd(process.env, process.pid)
  if (listenFd !== undefined) {
    delete process.env.LISTEN_FDS
    delete process.env.LISTEN_PID
  }
  const inherited = process.env.OPENCODE_PTY_HANDOFF
  delete process.env.OPENCODE_PTY_HANDOFF
  const handoff =
    inherited === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PersistentPty.Handoff))(inherited).pipe(
          Effect.catch(() =>
            Effect.logWarning("Ignoring invalid PTY restart handoff; persistent terminals will start fresh").pipe(
              Effect.as(undefined),
            ),
          ),
        )
  const global = yield* Global.Service
  if (options.mode === "service") yield* Effect.sync(() => process.chdir(global.home))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const foreground = options.mode === "default"
      // Version-checked in service mode so the incumbent probe below can tell this build's
      // own service apart from a different build's (code#8255). Only `file` is used from these
      // options later (registration), so the version field changes nothing downstream.
      const serviceOptions =
        options.mode === "service" ? yield* ServiceConfig.options({ checkVersion: true }) : undefined
      const config = options.mode === "service" ? yield* ServiceConfig.read() : {}
      const hostname = options.hostname ?? config.hostname ?? "127.0.0.1"
      const port = options.port ?? config.port ?? (options.mode === "service" ? ServiceConfig.defaultPort() : undefined)
      const findIncumbent =
        serviceOptions !== undefined && port !== undefined
          ? Service.incumbent({ ...serviceOptions, url: serviceURL(hostname, port) })
          : undefined
      if (serviceOptions !== undefined && port !== undefined) {
        // Probe without the version requirement too: the version-checked probe above cannot
        // distinguish "no incumbent" from "incumbent on a different version", and those must
        // not share an outcome. Service mode is only entered by a deliberate
        // `serve --service` invocation: a systemd unit, `opencode service start/restart`
        // (through ensure), desktop's background-service ensure, or a contender spawned by
        // ensure. A contender runs its spawner's own binary (selfCommand), so it shares the
        // spawner's version by construction; a mismatch here therefore means a different
        // build was deliberately started against this service, so taking over on any
        // mismatch is the intended replace semantics (the same symmetry as decide() in
        // ensure), not an accidental downgrade by a passive client.
        const existing = yield* Service.incumbent({
          ...serviceOptions,
          version: undefined,
          url: serviceURL(hostname, port),
        })
        const decision = incumbentDecision(existing)
        if (decision._tag === "already-current") {
          yield* Effect.sync(() =>
            console.log(
              `managed service version ${decision.version} (pid ${decision.pid ?? "unknown"}) is already running; this build is already current`,
            ),
          )
          return
        }
        if (decision._tag === "takeover") {
          const stopOptions = { ...serviceOptions, pty: "handoff" as const }
          yield* takeoverIncumbent(
            { version: decision.version, pid: decision.pid },
            Effect.gen(function* () {
              // Same primitives as the service restart handler: ask the incumbent to hand its
              // persistent terminals over (best-effort), then stop it with a PTY handoff so
              // those terminals survive the replacement.
              yield* ServerConnection.shutdownPersistentPty(serviceOptions).pipe(Effect.ignore)
              yield* Service.stop(stopOptions)
            }),
          )
        }
      }
      // Desktop can launch the service directly without injecting its saved environment.
      Object.assign(process.env, config.env)
      // Keep a package-manager or curl install replaceable while the service runs; Desktop updates its own copy.
      if (options.mode === "service" && process.platform === "win32" && RetainedImage.installed(global.home))
        yield* RetainedImage.retain(global.cache, "service")
      const { start } = yield* Effect.promise(() => import("@opencode/server/process"))
      const environmentPassword = yield* Env.password
      // Keep the lease credential out of the environment inherited by tools.
      if (options.mode === "stdio") {
        delete process.env.OPENCODE_PASSWORD
        delete process.env.OPENCODE_SERVER_PASSWORD
      }
      const password =
        options.mode === "service"
          ? config.password || randomBytes(32).toString("base64url")
          : environmentPassword
            ? Redacted.value(environmentPassword)
            : randomBytes(32).toString("base64url")
      if (!password) return yield* Effect.fail(new Error("Missing server password"))
      const instanceID = randomUUID()
      const transform = yield* WebUi.handler()
      const remote = { urls: [] as ReadonlyArray<string> }
      const launch = start(
        {
          app: {
            name: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT,
            version: OPENCODE_VERSION,
            channel: OPENCODE_CHANNEL,
          },
          hostname,
          port,
          inheritedListenFd: listenFd,
          cors: options.cors ?? config.cors,
          password,
          pty: { handoff },
          simulation: truthy(process.env.OPENCODE_SIMULATE),
          database: {
            path: databasePath(global.data),
          },
          models: {
            url: process.env.OPENCODE_MODELS_URL,
            file: process.env.OPENCODE_MODELS_PATH,
            fetch: !truthy(process.env.OPENCODE_DISABLE_MODELS_FETCH),
          },
          // Only real CLI servers download and start the local embedding model in the background; test homes never do.
          embedding: {
            autostart: !truthy(process.env.OPENCODE_DISABLE_EMBEDDING) && !process.env.OPENCODE_TEST_HOME,
          },
          config: {
            directory: process.env.OPENCODE_CONFIG_DIR,
            project: !truthy(
              process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
            ),
            // .claude is only read for skills, so both flags gate the same roots.
            claude: !(
              truthy(process.env.OPENCODE_DISABLE_CLAUDE_CODE) ||
              truthy(process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS)
            ),
            file: process.env.OPENCODE_CONFIG,
            content: process.env.OPENCODE_CONFIG_CONTENT,
          },
          windows: {
            gitbash: process.env.OPENCODE_GIT_BASH_PATH,
          },
          fs: {
            filewatcher: !truthy(process.env.OPENCODE_FILEWATCHER_DISABLE ?? process.env.OPENCODE_DISABLE_FILEWATCHER),
            fff:
              process.env.OPENCODE_DISABLE_FFF === undefined
                ? process.platform !== "win32"
                : !truthy(process.env.OPENCODE_DISABLE_FFF),
          },
        },
        serviceOptions === undefined
          ? undefined
          : {
              onListen: (address, shutdown) =>
                Effect.gen(function* () {
                  if (!config.password) yield* ServiceConfig.password(password)
                  return yield* ServiceRegistration.register({
                    address,
                    password,
                    id: instanceID,
                    file: serviceOptions.file,
                    shutdown,
                  })
                }),
            },
        transform,
        () => remote.urls,
      )
      const server = yield* launch.pipe(
        Effect.catch((error) => {
          if (findIncumbent === undefined || !addressInUse(error)) return Effect.fail(error)
          return Effect.gen(function* () {
            const deadline = Date.now() + 15_000
            while (Date.now() < deadline) {
              const found = yield* findIncumbent.pipe(Effect.timeoutOption(deadline - Date.now()))
              if (Option.isSome(found) && found.value !== undefined) return
              yield* Effect.sleep("100 millis")
              if (Date.now() >= deadline) break
              // Failed binds close their scope; a successful bind may take longer than this window to boot.
              const server = yield* launch.pipe(Effect.catchIf(addressInUse, () => Effect.void))
              if (server !== undefined) return server
            }
            return yield* Effect.fail(
              new Error(
                `Managed service port ${port} on ${hostname} is already in use by another process. ` +
                  "Configure another port with `opencode service set port <port>` and start the service again.",
                { cause: error },
              ),
            )
          })
        }),
      )
      if (server === undefined) return
      if (serviceOptions !== undefined && config.remote !== undefined && NetAddress.isInetAddress(server.address)) {
        const bound = NetAddress.formatIp(server.address.address)
        // A wildcard bind also listens on loopback, which is all the tunnel needs to reach.
        const target =
          bound === "0.0.0.0" || bound === "::"
            ? `127.0.0.1:${server.address.port}`
            : NetAddress.formatInet(server.address)
        yield* Effect.forkScoped(
          RemoteTunnel.run({
            route: config.remote.route,
            target,
            onURL: (url) => {
              remote.urls = url === undefined ? [] : [url]
            },
          }),
        )
      }
      const url = HttpServer.formatAddress(server.address)
      console.log(options.mode === "stdio" ? JSON.stringify({ url }) : `server listening on ${url}`)
      announceReady(options.mode === "stdio")
      if (foreground && !environmentPassword) console.log(`server password ${password}`)
      if (options.mode === "stdio") return yield* waitForStdinClose()
      yield* Effect.forkScoped(onHangup(server.reload()))
      const grace = shutdownGrace()
      return yield* (options.mode === "service" ? server.shutdown : Effect.never).pipe(
        Effect.onExit(() => server.drain(grace, secondTerm())),
      )
    }).pipe(Effect.annotateLogs({ role: "server" })),
  )
})

function serviceURL(hostname: string, port: number) {
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`
}

// Ready is reported once start() has returned: this process's own listener is bound and its application is
// ready. No request goes over the socket, because a predecessor still draining on a shared socket could answer it.
// stdio mode owns stdout for its JSON handshake, so its line goes to stderr.
function announceReady(stdio: boolean) {
  notifyReady().catch((error: unknown) => console.error(error instanceof Error ? error.message : String(error)))
  if (stdio) console.error("opencode: ready")
  else console.log("opencode: ready")
}

function truthy(value?: string) {
  return value === "1" || value?.toLowerCase() === "true"
}

function addressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "EADDRINUSE") return true
  return "cause" in error && addressInUse(error.cause)
}

export function shutdownGrace() {
  // Mirror of serverShutdownGrace() in packages/client/src/service-timing.ts; the two copies
  // must agree, because the client's stop path has to outwait the server's drain. A blank value
  // is absent, not an authored 0 (#874): bare Number() reads "" as 0 and also accepts hex and
  // exponent spellings, so only a plain non-negative decimal (surrounding whitespace trimmed)
  // names a duration; anything else falls back to the default.
  const raw = process.env.OPENCODE_SHUTDOWN_GRACE_MS?.trim()
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  return Number.isFinite(value) ? value : 30_000
}

// The first SIGTERM is the shutdown being drained; a second one ends the drain wait at once.
function secondTerm() {
  return Effect.callback<void>((resume) => {
    const handler = () => resume(Effect.void)
    process.once("SIGTERM", handler)
    return Effect.sync(() => process.off("SIGTERM", handler))
  })
}

function onHangup(reload: Effect.Effect<void>) {
  return Effect.callback<never>(() => {
    const handler = () => {
      Effect.runFork(reload)
    }
    process.on("SIGHUP", handler)
    return Effect.sync(() => process.off("SIGHUP", handler))
  })
}

function waitForStdinClose() {
  return Effect.callback<void>((resume) => {
    const close = () => resume(Effect.void)
    process.stdin.once("end", close)
    process.stdin.once("close", close)
    process.stdin.resume()
    if (process.stdin.readableEnded || process.stdin.destroyed) close()
    return Effect.sync(() => {
      process.stdin.off("end", close)
      process.stdin.off("close", close)
      process.stdin.pause()
    })
  })
}
