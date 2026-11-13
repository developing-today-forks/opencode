/**
 * MockProvider — a scripted stand-in for a real provider at the model-route layer, built for
 * the failover regression tests in #1806 (a session died on one pool's quota wall instead of
 * rotating to a healthy member, because nothing could rehearse a wall deterministically).
 *
 * Faithfulness rule: a mock failure must be indistinguishable from a real one at every layer
 * the router consults. HTTP outcomes are therefore not hand-built error objects — the wire
 * description (status, body, headers) is run through the production classifier
 * (`RequestExecutor.httpFailure`, the same function `aisdk.ts` feeds real provider responses
 * to), so the `AIError` a test sees carries the exact tag, http context, retry-after and
 * rate-limit details production would produce. Transport outcomes mirror the two production
 * constructions: a native failure with an OS code (`aisdk.ts` `llmError`) and the runner's own
 * first-token timeout (`session/runner/step.ts`). Nothing here touches the network or a real
 * provider quota.
 */
import { AIError, TransportError } from "@opencode/ai"
import { RequestExecutor } from "@opencode/ai/route"

/** One scripted attempt outcome. Queues are consumed in order; the last outcome repeats, so a
 * wall stays a wall and a success stays a success until the test re-scripts the target. */
export type MockOutcome =
  | { readonly kind: "text"; readonly text: string; readonly delayMs?: number }
  | {
      readonly kind: "tool-call"
      readonly name: string
      readonly input?: unknown
      readonly text?: string
      readonly delayMs?: number
    }
  | {
      readonly kind: "http"
      readonly status: number
      readonly body?: string
      readonly headers?: Record<string, string>
      readonly url?: string
      readonly delayMs?: number
    }
  | { readonly kind: "transport"; readonly code: string; readonly message: string; readonly delayMs?: number }
  /** Never settles. Only meaningful behind a caller-side timeout race (see the route driver),
   * which is exactly how a hung provider presents to the runner. */
  | { readonly kind: "timeout" }

export interface MockToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export interface MockSuccess {
  readonly type: "text" | "tool-call"
  readonly text?: string
  readonly toolCalls: readonly MockToolCall[]
}

export interface MockAttemptRecord {
  readonly key: string
  readonly providerID: string
  readonly model: string
  readonly credentialID?: string
  readonly kind: MockOutcome["kind"]
  readonly at: number
}

export interface MockTarget {
  readonly providerID: string
  readonly id: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The summary message production derives from an error body (`providerMessage` in
 * `packages/ai/src/route/executor.ts`): the body's own message when it carries one, else the
 * raw body behind the HTTP fallback line. Classification also scans the raw body, so shapes
 * stay faithful even where this summary is coarser than production's full body grammar. */
const providerMessage = (status: number, body: string | undefined): string => {
  const fallback = `Provider request failed with HTTP ${status}`
  const text = body?.trim() ?? ""
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown } | string
      message?: unknown
      detail?: unknown
    }
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.error?.message === "string"
          ? parsed.error.message
          : typeof parsed.message === "string"
            ? parsed.message
            : typeof parsed.detail === "string"
              ? parsed.detail
              : undefined
    if (message) return message
  } catch {
    // Not JSON: fall through to the raw-body form.
  }
  if (/^<(?:!doctype|html)/i.test(text)) return fallback
  return `${fallback}: ${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}`
}

export class MockProvider {
  private queues = new Map<string, MockOutcome[]>()
  private records: MockAttemptRecord[] = []
  private sequence = 0

  static key(target: MockTarget, credentialID?: string): string {
    return credentialID
      ? `${target.providerID}/${target.id}#${credentialID}`
      : `${target.providerID}/${target.id}`
  }

  /** Replace the outcome queue for a target (or one credential of it). */
  script(target: MockTarget, outcomes: readonly MockOutcome[], credentialID?: string): this {
    this.queues.set(MockProvider.key(target, credentialID), [...outcomes])
    return this
  }

  /** Script a single repeating outcome — the state-flip form (`set` a target to walled, later
   * back to serving) that mid-session scenarios are written in. */
  set(target: MockTarget, outcome: MockOutcome, credentialID?: string): this {
    return this.script(target, [outcome], credentialID)
  }

  attempts(key?: string): number {
    return key === undefined ? this.records.length : this.records.filter((record) => record.key === key).length
  }

  log(): readonly MockAttemptRecord[] {
    return this.records
  }

  async attempt(target: MockTarget, credentialID?: string): Promise<MockSuccess> {
    const credentialKey = credentialID === undefined ? undefined : MockProvider.key(target, credentialID)
    const key =
      credentialKey !== undefined && this.queues.has(credentialKey)
        ? credentialKey
        : MockProvider.key(target)
    const queue = this.queues.get(key)
    if (!queue || queue.length === 0)
      throw new Error(
        `MockProvider: nothing scripted for ${MockProvider.key(target)}${credentialID ? ` (credential ${credentialID})` : ""}`,
      )
    const outcome = queue.length > 1 ? queue.shift()! : queue[0]
    this.records.push({
      key,
      providerID: target.providerID,
      model: target.id,
      ...(credentialID === undefined ? {} : { credentialID }),
      kind: outcome.kind,
      at: Date.now(),
    })
    if (outcome.kind === "timeout") return new Promise<MockSuccess>(() => {})
    if (outcome.delayMs !== undefined && outcome.delayMs > 0) await sleep(outcome.delayMs)
    switch (outcome.kind) {
      case "text":
        return { type: "text", text: outcome.text, toolCalls: [] }
      case "tool-call":
        return {
          type: "tool-call",
          ...(outcome.text === undefined ? {} : { text: outcome.text }),
          toolCalls: [{ id: `mock-call-${++this.sequence}`, name: outcome.name, input: outcome.input ?? {} }],
        }
      case "http":
        throw RequestExecutor.httpFailure({
          message: providerMessage(outcome.status, outcome.body),
          url: outcome.url ?? `https://mock.invalid/${target.providerID}/${target.id}`,
          status: outcome.status,
          responseHeaders: outcome.headers,
          responseBody: outcome.body,
        })
      case "transport": {
        const cause = Object.assign(new Error(outcome.message), { code: outcome.code })
        throw new AIError({
          reason: new TransportError({
            message: outcome.message,
            cause,
            transport: "http",
            operation: "request",
            code: outcome.code,
            url: `https://mock.invalid/${target.providerID}/${target.id}`,
          }),
        })
      }
    }
  }
}

/** Named wire scenarios, shaped after the real providers named in #1806. */
export const MockScenarios = {
  succeed: (text = "OK"): MockOutcome => ({ kind: "text", text }),

  toolCall: (name = "lookup", input: unknown = {}): MockOutcome => ({ kind: "tool-call", name, input }),

  /** Antigravity's Claude/GPT bucket wall, verbatim from the 2026-11-05 incident: HTTP 429,
   * no quota code, the reset stated only in the message text. Classifies as `RateLimit`
   * (retryable) — the shape that invited same-target retries against an 81-hour wall. */
  antigravityQuotaWall: (reset = "81h35m49s"): MockOutcome => ({
    kind: "http",
    status: 429,
    body: `Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${reset}.`,
  }),

  /** A quota answer with an explicit quota code: classifies as `QuotaExceeded` regardless of
   * the 429 it rides on — the Mistral-side shape from the same incident. */
  quotaExceeded: (): MockOutcome => ({
    kind: "http",
    status: 429,
    body: JSON.stringify({
      error: { code: "insufficient_quota", message: "Quota exceeded for this account" },
    }),
  }),

  /** OpenDesign's membership wall, verbatim from the 2026-11-10 incident (#2253): HTTP 429,
   * a `tier_limit_exceeded` code, the cap stated in the message text ("11/10"). Classifies as
   * `RateLimit` on the wire; the runner must additionally recognize it as a tier limit so the
   * account-wide hold — not an ordinary per-target bench — answers it. */
  opendesignTierLimit: (kind: "concurrency" | "rpm" = "concurrency"): MockOutcome => ({
    kind: "http",
    status: 429,
    body: JSON.stringify({
      error: {
        code: "tier_limit_exceeded",
        message:
          kind === "concurrency"
            ? "membership concurrency limit exceeded: 11/10"
            : "membership rpm limit exceeded: 101/100",
      },
    }),
  }),

  /** A plain throttle with a stated wait in the `retry-after` header. */
  rateLimit: (retryAfterSeconds = 2): MockOutcome => ({
    kind: "http",
    status: 429,
    headers: { "retry-after": String(retryAfterSeconds) },
    body: JSON.stringify({ error: { message: "Rate limit reached; slow down" } }),
  }),

  auth: (): MockOutcome => ({
    kind: "http",
    status: 401,
    body: JSON.stringify({ error: { message: "Invalid API key provided" } }),
  }),

  serverError: (): MockOutcome => ({ kind: "http", status: 500, body: "Internal Server Error" }),

  dnsFailure: (host = "api.mock-provider.invalid"): MockOutcome => ({
    kind: "transport",
    code: "ENOTFOUND",
    message: `getaddrinfo ENOTFOUND ${host}`,
  }),

  connectionRefused: (host = "api.mock-provider.invalid"): MockOutcome => ({
    kind: "transport",
    code: "ECONNREFUSED",
    message: `connect ECONNREFUSED ${host}:443`,
  }),

  timeout: (): MockOutcome => ({ kind: "timeout" }),
} as const
