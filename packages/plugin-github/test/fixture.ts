import type { PermissionDomain } from "@opencode/plugin/effect/permission"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Redacted, Schema, Scope } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import path from "node:path"
import { GitHubClient } from "../src/client.js"
import { GitHubProcess } from "../src/process.js"
import type { GitHubShared } from "../src/shared.js"

const unwrap = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value

export interface Request {
  readonly method: string
  readonly url: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

export interface Reply {
  readonly status?: number
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

/** A route answers `METHOD /path` (REST, path without the api.github.com origin) or `GRAPHQL <operation text>`. */
export type Route = (request: Request) => Reply | undefined

/**
 * An in-process GitHub: REST routes are matched by `METHOD /path`, GraphQL by a substring of the query. Unmatched
 * requests answer 599 so a test fails loudly instead of reaching the network.
 */
export function fakeGitHub(routes: Record<string, Reply | Route>) {
  const requests: Request[] = []
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url)
      const raw = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
      const body = raw === undefined ? undefined : parse(raw)
      const recorded: Request = {
        method: request.method,
        url: request.url,
        path: url.pathname,
        // Effect keeps request parameters apart from the URL until the request is sent.
        query: Object.fromEntries(
          [...url.searchParams, ...request.urlParams.params].map(([key, value]) => [key, unwrap(value)] as const),
        ),
        headers: request.headers,
        body,
      }
      requests.push(recorded)
      const graphql = url.pathname === "/graphql" && typeof body === "object" && body !== null && "query" in body
      const reply = graphql
        ? Object.entries(routes)
            .filter(([key]) => key.startsWith("GRAPHQL "))
            .map(([key, route]) =>
              String((body as { query: string }).query).includes(key.slice(8)) ? answer(route, recorded) : undefined,
            )
            .find((value) => value !== undefined)
        : answer(routes[`${request.method} ${url.pathname}`], recorded)
      const resolved = reply ?? { status: 599, body: { message: `unrouted ${request.method} ${url.pathname}` } }
      const payload = graphql && reply && resolved.status === undefined ? { data: resolved.body } : resolved.body
      return HttpClientResponse.fromWeb(
        request,
        new Response(payload === undefined ? null : JSON.stringify(payload), {
          status: resolved.status ?? 200,
          headers: { "content-type": "application/json", ...resolved.headers },
        }),
      )
    }),
  )
  return { http, requests }
}

function answer(route: Reply | Route | undefined, request: Request) {
  if (route === undefined) return undefined
  return typeof route === "function" ? route(request) : route
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function memoryKV(): StorageDomain {
  const store = new Map<string, Schema.Json>()
  return {
    get: (key) => Effect.sync(() => store.get(key)),
    set: (key, value) => Effect.sync(() => void store.set(key, value)),
    remove: (key) => Effect.sync(() => void store.delete(key)),
    scan: (options) =>
      Effect.sync(() => ({
        entries: [...store]
          .filter(([key]) => key.startsWith(options.prefix) && (options.after === undefined || key > options.after))
          .map(([key, value]) => ({ key, value })),
      })),
  }
}

export const sessionID = Session.ID.make("ses_github_test")

export const context: Tool.Context = {
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_github_test"),
  id: Tool.CallID.make("call_github_test"),
  progress: () => Effect.void,
}

/** Builds tool dependencies around a fake GitHub. The token comes from GH_TOKEN, so no gh process is spawned. */
export const makeDeps = Effect.fn("test.github.deps")(function* (input: {
  readonly http: HttpClient.HttpClient
  readonly directory?: string
}) {
  const scope = yield* Scope.Scope
  const kv = memoryKV()
  const asserted: Parameters<PermissionDomain["assert"]>[0][] = []
  const notified: Parameters<GitHubShared.Deps["sessions"]["synthetic"]>[0][] = []
  const permission: GitHubShared.Deps["permission"] = {
    assert: (assertion) => Effect.sync(() => void asserted.push(assertion)),
  }
  // The admitted inbox item is never read by the tools, so the fake never completes.
  const sessions: GitHubShared.Deps["sessions"] = {
    synthetic: (message) => Effect.sync(() => void notified.push(message)).pipe(Effect.andThen(Effect.never)),
  }
  // Local file approvals resolve against the working directory and are recorded.
  const approvals: Array<{ readonly kind: "read" | "external"; readonly path: string }> = []
  const directory = input.directory ?? "/nonexistent-github-test-directory"
  const resolve = (file: string) => {
    const absolute = path.resolve(directory, file)
    return { absolute, resource: absolute }
  }
  const files: GitHubShared.Deps["files"] = {
    resolve: (target) => Effect.succeed(resolve(target.path)),
    authorizeExternal: (targets) =>
      Effect.sync(() => targets.forEach((target) => approvals.push({ kind: "external", path: target.absolute }))),
    authorizeRead: (file) =>
      Effect.sync(() => {
        const target = resolve(file)
        approvals.push({ kind: "read", path: target.absolute })
        return target
      }),
  }
  const deps: GitHubShared.Deps = {
    client: GitHubClient.make({ http: input.http, run: GitHubProcess.run }),
    run: GitHubProcess.run,
    kv,
    permission,
    sessions,
    files,
    scope,
    directory,
    codemode: true,
  }
  return { deps, kv, asserted, notified, approvals }
})

/** Runs a tool's executor and checks its output against the declared schema, as the registry would. */
export const run = <I, O>(tool: Tool.Info, input: I) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(tool.input as Schema.Codec<I, unknown>)(input)
    const result = yield* tool.execute(decoded, context)
    yield* Schema.encodeUnknownEffect(tool.output as Schema.Codec<O, unknown>)(result.output)
    return result.output as O
  })

export const find = (tools: ReadonlyArray<Tool.Info>, name: string) => {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}
