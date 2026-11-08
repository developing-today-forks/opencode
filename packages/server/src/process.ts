export * as ServerProcess from "./process"

import { NodeHttpServer } from "@effect/platform-node"
import { Bus } from "@opencode/core/bus"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { Config } from "@opencode/core/config"
import { InstallationEvent } from "@opencode/schema/installation-event"
import { hasPtyConnectTicketURL } from "@opencode/protocol/groups/pty"
import { hasPersistentPtyConnectTicketURL } from "@opencode/protocol/groups/persistent-pty"
import { isPairingConnectURL } from "@opencode/protocol/groups/server"
import { Global } from "@opencode/util/global"
import { Cause, Context, Duration, Effect, Exit, Latch, Layer, Option, Ref, Scope } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { NetAddress } from "effect/net"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { ListenOptions, Socket } from "node:net"
import { ServerAuth } from "./auth"
import { isAllowedCorsOrigin } from "./cors"
import { adoptInheritedSocket } from "./inherited-socket"
import { authorizedRequest, unauthorizedResponse } from "./middleware/authorization"
import { withoutParentSpan } from "./request-tracing"
import { createRoutes } from "./routes"
import { ServerInfo } from "./server-info"
import { PluginServerUrl } from "@opencode/core/plugin/server-url"
import { Status } from "./service-status"
import type { ServerOptions } from "./options"

export interface Lifecycle<E = never, R = never> {
  readonly onListen: (
    address: NetAddress.SocketAddress,
    shutdown: Effect.Effect<void>,
  ) => Effect.Effect<Effect.Effect<void>, E, R>
}

type App = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>

export type Transform = (app: App) => App

const errorResponseLogger = HttpMiddleware.make((app) =>
  HttpMiddleware.logger(
    Effect.tap(app, (response) =>
      response.status < 400 ? HttpMiddleware.withLoggerDisabled(Effect.void) : Effect.void,
    ),
  ),
)

export const start = Effect.fn("ServerProcess.start")(function* <E, R>(
  options: ServerOptions,
  lifecycle?: Lifecycle<E, R>,
  transform?: Transform,
  remoteURLs?: () => ReadonlyArray<string>,
) {
  const password = options.password
  if (!password) return yield* Effect.fail(new Error("Missing server password"))
  const hostname = options.hostname ?? "127.0.0.1"
  const port = Option.fromNullishOr(options.port)
  const shutdown = yield* Latch.make()
  const status = yield* Status.make()
  const bound = yield* listen({ hostname, port, inheritedFd: options.inheritedListenFd })
  // Requests still running when a drain starts keep the process up until they finish. Event streams are
  // open-ended, so the drain does not wait for them; they end when the process exits.
  const inFlight = new Set<ServerResponse>()
  // Connections the listener has accepted. A connection accepted in the last instant before a drain
  // starts may not have sent its request yet, so it is not in inFlight; the drain keeps serving
  // accepted connections briefly instead of resetting a request that was already on its way.
  const accepted = new Set<Socket>()
  let draining = false
  bound.server.on("connection", (socket: Socket) => {
    accepted.add(socket)
    socket.once("close", () => accepted.delete(socket))
  })
  bound.server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    // Event streams are open-ended: the drain does not wait for them, so they must not hold the linger either.
    if (new URL(request.url ?? "/", "http://localhost").pathname === EVENT_STREAM_PATH) {
      accepted.delete(request.socket)
      return
    }
    inFlight.add(response)
    response.once("close", () => inFlight.delete(response))
    // A draining process closes each connection after its current response, so clients reconnect to the successor.
    if (draining) response.setHeader("connection", "close")
  })
  const localURLs = () => {
    const address = bound.server.address()
    if (address === null || typeof address === "string") return []
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address
    return ServerInfo.connectionURLs(`http://${host}:${address.port}`, hostname)
  }
  const urls = () => [...localURLs(), ...(remoteURLs?.() ?? [])]
  // Plugins read the active listener through Plugin.Context.serverUrl.
  const activeUrl = urls()[0]
  PluginServerUrl.setServerUrl(activeUrl)
  const application = yield* Ref.make(Option.none<App>())
  const app = dispatch(password, status, application, options.app?.version ?? "unknown", urls, Global.Path.tmp)
  // Request fibers may continue inbound trace context, but must not inherit the server startup parent.
  yield* bound.http
    .serve(
      (transform ? transform(app) : app).pipe(
        HttpMiddleware.compression(),
        HttpMiddleware.cors({ allowedOrigins: (origin) => isAllowedCorsOrigin(origin, options), maxAge: 86_400 }),
      ),
      errorResponseLogger,
    )
    .pipe(Effect.provide(NodeHttpServer.layerHttpServices), withoutParentSpan)
  if (lifecycle)
    yield* lifecycle.onListen(bound.http.address, shutdown.open.pipe(Effect.asVoid)).pipe(
      Effect.flatMap((cleanup) =>
        Effect.addFinalizer(() => Scope.close(bound.scope, Exit.void).pipe(Effect.andThen(cleanup))),
      ),
      Effect.uninterruptible,
    )

  const parentScope = yield* Scope.Scope
  const applicationScope = yield* Scope.fork(parentScope)
  yield* Effect.addFinalizer(() =>
    status.beginStopping.pipe(
      Effect.andThen(Ref.set(application, Option.none())),
      Effect.andThen(Effect.sync(() => bound.server.closeAllConnections())),
      Effect.andThen(
        Effect.sync(() => {
          if (PluginServerUrl.getServerUrl() === activeUrl) PluginServerUrl.setServerUrl(undefined)
        }),
      ),
    ),
  )

  const boot = Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(
      createRoutes(
        {
          ...options,
          password,
        },
        urls,
      ).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices)),
      applicationScope,
    )
    if (lifecycle) {
      yield* installRestartContinuity(Context.get(context, SessionRestart.Service)).pipe(
        Effect.provideService(Scope.Scope, applicationScope),
      )
    }
    yield* Ref.set(application, Option.some(Context.get(context, HttpRouter.HttpRouter).asHttpEffect()))
    yield* status.ready
    const bus = Context.get(context, Bus.Service)
    const execution = Context.get(context, SessionExecution.Service)
    const runningSessions = execution.active.pipe(Effect.map((sessions) => Array.from(sessions)))
    const untilIdle = Effect.gen(function* () {
      while ((yield* runningSessions).length > 0 || inFlight.size > 0) yield* Effect.sleep("250 millis")
    })
    const waitForAccepted = Effect.gen(function* () {
      while (accepted.size > 0) yield* Effect.sleep("10 millis")
    })
    const waitForRequests = Effect.gen(function* () {
      while (inFlight.size > 0) yield* Effect.sleep("10 millis")
    })
    return {
      address: bound.http.address,
      shutdown: shutdown.await,
      updateAvailable: (version: string) =>
        bus.publish(InstallationEvent.UpdateAvailable, { version }).pipe(Effect.asVoid),
      updated: (version: string) => bus.publish(InstallationEvent.Updated, { version }).pipe(Effect.asVoid),
      reload: () => bus.publish(Config.ReloadRequested, {}).pipe(Effect.asVoid),
      drain: (grace: Duration.Input, cutNow: Effect.Effect<void>) =>
        Effect.gen(function* () {
          yield* status.beginStopping
          draining = true
          // Closing the server stops accepting. With an inherited socket this process only drops its own
          // descriptor; the supervisor keeps the listener, so connections queue for the successor.
          yield* Effect.sync(() => {
            bound.server.close()
          })
          const sessions = yield* runningSessions
          if (sessions.length > 0 || inFlight.size > 0)
            yield* Effect.logInfo("draining running sessions and requests", {
              sessions,
              requests: inFlight.size,
              grace,
            })
          // The interrupt that started this drain must not cancel the wait; a second SIGTERM ends it.
          yield* Effect.gen(function* () {
            if (sessions.length > 0 || inFlight.size > 0) yield* untilIdle.pipe(Effect.timeoutOption(grace))
            // Keep serving connections the listener accepted before it closed: their requests may not have
            // arrived when the drain began, so inFlight did not see them. Bounded so idle keep-alive
            // connections cannot hold shutdown.
            yield* waitForAccepted.pipe(Effect.timeoutOption(drainLinger))
            // A request that arrived during the linger is now in flight; finish it before closing.
            yield* waitForRequests.pipe(Effect.timeoutOption(grace))
          }).pipe(Effect.raceFirst(cutNow), Effect.uninterruptible)
          const remaining = yield* runningSessions
          if (remaining.length > 0 || inFlight.size > 0)
            yield* Effect.logWarning("shutdown ended with sessions or requests still running; interrupting them", {
              sessions: remaining,
              requests: inFlight.size,
            })
        }),
    }
  }).pipe(
    Effect.catchCause((cause) => {
      if (!lifecycle || Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      return status.fail.pipe(
        Effect.andThen(
          Scope.close(applicationScope, Exit.failCause(cause)).pipe(
            Effect.catchCause((cleanupCause) =>
              Effect.logError("failed to clean up background service boot", { cause: cleanupCause }),
            ),
          ),
        ),
        Effect.andThen(Effect.logError("background service boot failed", { cause })),
        Effect.andThen(Effect.never),
      )
    }),
  )
  if (!lifecycle) return yield* boot
  return yield* Effect.raceFirst(boot, shutdown.await.pipe(Effect.andThen(Effect.interrupt)))
})

const EVENT_STREAM_PATH = "/api/event"

// How long a draining server keeps serving connections it already accepted before closing them. A
// request on such a connection usually arrives within one round trip; this covers a slow one without
// letting idle keep-alive connections hold shutdown.
const drainLinger = Duration.millis(500)

function listen(options: {
  readonly hostname: string
  readonly port: Option.Option<number>
  readonly inheritedFd?: number | undefined
}) {
  if (options.inheritedFd !== undefined) return bind({ fd: options.inheritedFd })
  if (Option.isSome(options.port)) return bind({ host: options.hostname, port: options.port.value })
  const next = (port: number): ReturnType<typeof bind> =>
    bind({ host: options.hostname, port }).pipe(
      Effect.catch((error) => (port < 65_535 && addressInUse(error) ? next(port + 1) : Effect.fail(error))),
    )
  return next(4096)
}

function bind(address: { readonly host: string; readonly port: number } | { readonly fd: number }) {
  return Effect.gen(function* () {
    const parentScope = yield* Scope.Scope
    const serverScope = yield* Scope.fork(parentScope)
    const server = createServer()
    // Bun's node:http ignores `fd`, so an inherited socket is adopted through node:net there. Node takes `fd` directly.
    const listening = "fd" in address && "Bun" in globalThis ? adoptInheritedSocket(server, address.fd) : server
    return yield* Effect.gen(function* () {
      // @types/node leaves `fd` off ListenOptions, but Node's server.listen accepts it.
      const http = yield* NodeHttpServer.make(() => listening, address as ListenOptions)
      yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))
      return { http, server, scope: serverScope }
    }).pipe(
      Effect.provideService(Scope.Scope, serverScope),
      Effect.onError((cause) => Scope.close(serverScope, Exit.failCause(cause))),
    )
  })
}

function addressInUse(error: unknown) {
  if (typeof error !== "object" || error === null || !("cause" in error)) return false
  const cause = error.cause
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE"
}

function dispatch(
  password: string,
  status: Status.Interface,
  application: Ref.Ref<Option.Option<App>>,
  version: string,
  urls: () => ReadonlyArray<string>,
  tmp: string,
): App {
  const auth = ServerAuth.Config.of({ password: Option.some(password), username: "opencode" })
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://localhost")
    const info = request.method === "GET" && url.pathname === "/api/info"
    // Only the info route answers at once during startup; other requests wait (bounded, see `Status.startupWait`).
    // The request fiber is uninterruptible above the router, so the wait opts back in: a disconnect must cancel it.
    if (!info) yield* status.awaitStartup.pipe(Effect.interruptible)
    const state = yield* status.current
    const app = yield* Ref.get(application)
    const ready = state.type === "ready" && Option.isSome(app)
    // A draining server stops listening, but it still answers the requests already accepted on its connections:
    // a 503 there would look like a failed request to a client that a successor is about to serve.
    const serving = (state.type === "ready" || state.type === "stopping") && Option.isSome(app)
    if (info && !ready) {
      if (!(yield* authorizedRequest(request, auth))) return unauthorizedResponse(request)
      return yield* infoResponse(status, version, urls, tmp)
    }
    if (
      !isPairingConnectURL(url) &&
      (!serving || (!hasPtyConnectTicketURL(url) && !hasPersistentPtyConnectTicketURL(url))) &&
      !(yield* authorizedRequest(request, auth))
    )
      return unauthorizedResponse(request)
    if (serving) return yield* app.value
    return unavailable(state)
  })
}

const infoResponse = Effect.fnUntraced(function* (
  status: Status.Interface,
  version: string,
  urls: () => ReadonlyArray<string>,
  tmp: string,
) {
  const state = yield* status.current
  return HttpServerResponse.jsonUnsafe(
    { version, pid: process.pid, urls: urls(), paths: { tmp } },
    {
      status: state.type === "ready" ? 200 : state.type === "failed" ? 500 : 503,
      headers: state.type === "starting" || state.type === "stopping" ? { "retry-after": "1" } : undefined,
    },
  )
})

function unavailable(status: Status.State) {
  if (status.type === "failed")
    return HttpServerResponse.jsonUnsafe(
      {
        code: "service_failed",
        message: "The background service could not start.",
        action: "Run `opencode service restart` after checking the service logs.",
      },
      { status: 503 },
    )
  return HttpServerResponse.jsonUnsafe(
    { code: status.type === "stopping" ? "service_stopping" : "service_starting" },
    { status: 503, headers: { "retry-after": "1" } },
  )
}

/**
 * The managed server owns restart continuity: at boot it resumes Sessions whose execution claim was
 * never released. Claims are written when execution starts (see SessionExecution), so recovery covers
 * graceful restarts and unclean deaths alike — no shutdown hook participates.
 */
const installRestartContinuity = Effect.fnUntraced(function* (restart: SessionRestart.Interface) {
  yield* Effect.forkScoped(restart.resumeSuspendedSessions)
})
