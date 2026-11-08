export * as SystemOne from "./systemone.js"

/**
 * SystemOne wire translation + backend service for the systemone door
 * (#1410, parent #1146, Drew's 2026-11-02 systemone ruling).
 *
 * The façade rule is one endpoint per real standard: Jev is a Command
 * Code decision model on the `v1/systemone` contract — JSON state +
 * typed questions in, probabilities out, never text — and clef fronts
 * the same shape for OpenChamber's classifier client. This door is
 * therefore NOT a chat dialect: callers repoint from the standalone
 * clef proxy (`bin/clef-proxy.mjs` in developing-today/code, :18742)
 * to `POST /v1/systemone` here with NO contract change, and this module
 * reproduces the door's caller-visible contract exactly (recorded
 * pairs: packages/core/test/facade-parity.test.ts, systemone family;
 * HTTP level: packages/server/test/facade-parity.test.ts).
 *
 * Backend: the same one the door uses — the Cloudflare AI gateway
 * Workers AI run endpoint for the Clef family
 * (`POST <gateway>/<account>/<gatewayId>/workers-ai/run/<model>` with
 * `{state, questions}`). Only `{state, questions}` is forwarded; the
 * rest of the caller's body (model aside) is dropped, as the door
 * drops it.
 *
 * Credential story (Gate 1, #1410 comment 6590060360): read-in-place
 * with the door's exact precedence — caller `Authorization: Bearer`
 * passthrough, then env `CLOUDFLARE_API_TOKEN`, then the file
 * `~/.config/cloudflare/ai-inference-token` (account/gateway ids the
 * same way, with the door's own fallbacks). Re-read per request, so a
 * rotated token file is picked up without a restart, exactly as the
 * door's mtime cache picks it up. Nothing is copied into the
 * credential store, so there is no second copy to drift. The token is
 * a static long-lived API token: there is no refresh machinery to own;
 * if it lapses the upstream 401/403 surfaces in the door's
 * upstream-failure envelope.
 *
 * Accounting: every upstream attempt records a route_attempt row
 * through the same ModelRouteLog observer the other doors use, with
 * session_id NULL (the door convention), route_id "" (the direct-ref
 * convention), provider "cloudflare-ai-gateway" and the resolved Clef
 * model id. The gateway reports no token usage for these calls, so
 * tokens are recorded as 0/0 like the embeddings door records its
 * backend-reported counts.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ModelRouteLog } from "./model-route-log.js"
import { collectBoundedResponseBody } from "./tool/http-body.js"
import { timeoutMs } from "./util/number.js"

// ------------------------------------------------------------ translation

export const DEFAULT_MODEL = "@cf/cloudflare/clef-flash"

/** The door's model grammar (#2410 in the door): the resolved model is
 * interpolated raw into the gateway run URL, so it is confined to the
 * Clef family in the cloudflare namespace with plain name characters
 * only — no '/', dot segments, '?', '#', whitespace or controls can be
 * represented, so a hostile model cannot rewrite the upstream path or
 * spend the token on a non-Clef model. */
export const CLEF_MODEL_GRAMMAR = /^@cf\/cloudflare\/clef[A-Za-z0-9._-]*$/

/** The door's model resolution, verbatim semantics. */
export const resolveModel = (model: unknown): string => {
  if (!model || typeof model !== "string") return DEFAULT_MODEL
  if (model.startsWith("@cf/")) return model
  if (model === "clef") return "@cf/cloudflare/clef"
  if (model === "clef-flash") return "@cf/cloudflare/clef-flash"
  if (model.includes("clef")) return `@cf/cloudflare/${model}`
  return DEFAULT_MODEL
}

export interface ParsedSystemOneRequest {
  readonly model: string
  readonly modelLabel: string
  readonly state: unknown
  readonly questions: unknown
}

export type ParseSystemOneResult =
  | { readonly ok: true; readonly value: ParsedSystemOneRequest }
  | { readonly ok: false; readonly error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The door's request validation: the body must be a JSON object (an
 * array body is a 400 and never reaches upstream — the ex-code#2938
 * guard class); state/questions default to {} when absent, exactly as
 * the door forwards them; a resolved model outside the Clef grammar is
 * refused with the door's own message before any upstream call.
 */
export const parseSystemOneRequest = (body: unknown): ParseSystemOneResult => {
  if (!isRecord(body)) return { ok: false, error: "Invalid JSON body: expected an object" }
  const model = resolveModel(body.model)
  if (!CLEF_MODEL_GRAMMAR.test(model))
    return { ok: false, error: `Refused model '${model}': only Clef-family models (@cf/cloudflare/clef*) are served by this proxy` }
  return {
    ok: true,
    value: {
      model,
      modelLabel: typeof body.model === "string" && body.model ? body.model : model,
      state: body.state ?? {},
      questions: body.questions ?? {},
    },
  }
}

/** The door's plain `{error}` envelope (NOT the OpenAI error shape —
 * systemone callers read `error` as a string; preserving that is the
 * no-contract-change rule for this family). */
export const errorBody = (message: string) => ({ error: message })

export const upstreamFailureBody = (details: unknown) => ({
  error: "Cloudflare Workers AI Clef execution failed",
  details,
})

/** The door's success shape: the upstream `result.answers` verbatim,
 * nothing added (no model/usage/id fields — Jev clients read only
 * `answers`, and adding fields would still be a visible diff). */
export const answersBody = (answers: unknown) => ({ answers })

// ------------------------------------------------------------ credentials

export interface Credentials {
  readonly accountId: string
  readonly gatewayId: string
  readonly token: string
}

const readConfigFileSync = (filename: string, fallback = ""): string => {
  try {
    // $HOME first, like the door's spawn environment: os.homedir()
    // caches the process-start home, which would miss a rotated home
    // in long-lived embeddings of the server.
    const home = process.env.HOME ?? os.homedir()
    return fs.readFileSync(path.join(home, ".config", "cloudflare", filename), "utf8").trim()
  } catch {
    return fallback
  }
}

/** The door's credential resolution, same sources, same precedence,
 * same fallbacks (Gate 1: read-in-place). The account fallback is the
 * door source's own hardcoded value. */
export const resolveCredentials = (authHeader: string | undefined): Credentials => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || readConfigFileSync("account-id", "234b866b99ce2b142d7963d8d139cbfa")
  const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID || readConfigFileSync("gateway-id", "opencode-gateway")
  let token = ""
  if (authHeader && authHeader.startsWith("Bearer ")) token = authHeader.slice("Bearer ".length).trim()
  if (!token) token = process.env.CLOUDFLARE_API_TOKEN || readConfigFileSync("ai-inference-token")
  return { accountId, gatewayId, token }
}

// ------------------------------------------------------------ service

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("SystemOne.UnavailableError", {
  message: Schema.String,
  /** HTTP status the handler answers with (the door's status rules). */
  status: Schema.Number,
  /** Wire body the handler answers with, in the door's envelope. */
  body: Schema.Unknown,
}) {}

export type Error = UnavailableError

export interface EvaluateInput {
  readonly model: string
  readonly state: unknown
  readonly questions: unknown
  readonly authHeader?: string
}

export interface EvaluateResult {
  readonly answers: unknown
}

export interface Interface {
  readonly evaluate: (input: EvaluateInput) => Effect.Effect<EvaluateResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemOne") {}

/** Test seam, mirroring the door's CLEF_PROXY_GATEWAY_BASE (#692 in the
 * door): point the gateway base at a stub upstream; the URL shape after
 * the base is unchanged. */
export const GATEWAY_BASE_ENV = "OPENCODE_SYSTEMONE_GATEWAY_BASE"
export const DEFAULT_GATEWAY_BASE = "https://gateway.ai.cloudflare.com/v1"

/** The door's single deadline covering the upstream fetch AND the
 * response-body read (30s; the door's env override is honored under
 * its own name so a fleet-wide setting keeps working). */
/** The named ceiling for the env override (#1477): the deadline covers one
 * fetch plus its body read, so no legitimate setting runs to minutes, let
 * alone the unbounded values the bare conversion used to accept (up to
 * Number.MAX_SAFE_INTEGER, which silently removed the deadline). */
export const MAX_DATA_PATH_TIMEOUT_MS = 300_000

export const dataPathTimeoutMs = () =>
  timeoutMs(Number(process.env.CLEF_PROXY_DATA_PATH_TIMEOUT_MS), {
    fallback: 30_000,
    max: MAX_DATA_PATH_TIMEOUT_MS,
  })

const maxResponseBytes = 5 * 1024 * 1024

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    const evaluate: Interface["evaluate"] = (input) =>
      Effect.gen(function* () {
        const startedAt = Date.now()
        const observed = ModelRouteLog.observer({
          routeID: "",
          providerID: "cloudflare-ai-gateway",
          modelID: input.model,
          startedAt,
        })
        const fail = (status: number, body: unknown, message: string, outcome: "failure" | "timeout" = "failure") => {
          observed.done(outcome, { failure: new Error(message), outputStarted: false })
          return new UnavailableError({ message, status, body })
        }
        const credentials = resolveCredentials(input.authHeader)
        if (!credentials.token)
          return yield* fail(401, errorBody("Missing Cloudflare AI inference API token"), "Missing Cloudflare AI inference API token")
        const gatewayBase = (process.env[GATEWAY_BASE_ENV] ?? DEFAULT_GATEWAY_BASE).replace(/\/+$/, "")
        const url = `${gatewayBase}/${credentials.accountId}/${credentials.gatewayId}/workers-ai/run/${input.model}`
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const request = HttpClientRequest.post(url).pipe(
              HttpClientRequest.bodyJsonUnsafe({ state: input.state, questions: input.questions }),
              HttpClientRequest.bearerToken(credentials.token),
            )
            const response = yield* http.execute(request)
            const raw = yield* Effect.scoped(
              collectBoundedResponseBody(response, maxResponseBytes, () => new Error("systemone response exceeded the size bound")),
            )
            let data: unknown = null
            try {
              data = JSON.parse(raw.toString("utf8"))
            } catch {
              data = null
            }
            return { status: response.status, data }
          }).pipe(
            Effect.timeoutOrElse({
              duration: dataPathTimeoutMs(),
              orElse: () => Effect.fail(new Error("systemone data path timed out")),
            }),
          ),
        )
        if (result._tag === "Failure") {
          const message = result.failure instanceof Error ? result.failure.message : String(result.failure)
          if (message === "systemone data path timed out") {
            return yield* fail(504, errorBody("Cloudflare Workers AI Clef request timed out"), "Cloudflare Workers AI Clef request timed out", "timeout")
          }
          return yield* fail(500, errorBody(message || "Internal proxy error"), message || "Internal proxy error")
        }
        const { status, data } = result.success
        const record = isRecord(data) ? data : null
        const upstreamResult = record && isRecord(record.result) ? record.result : null
        if (status >= 200 && status < 300 && record?.success && upstreamResult?.answers) {
          observed.done("success", {
            outputStarted: true,
            firstOutputAt: Date.now(),
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          return { answers: upstreamResult.answers }
        }
        const answerStatus = status >= 400 ? status : 502
        return yield* fail(answerStatus, upstreamFailureBody(data), "Cloudflare Workers AI Clef execution failed")
      })

    return Service.of({ evaluate })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [httpClient] })
