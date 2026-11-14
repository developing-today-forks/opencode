import { describe, expect, test } from "bun:test"
import {
  AIError,
  AuthenticationError,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
  TransportError,
  UnknownProviderError,
} from "@opencode/ai"
import { ModelRoute } from "@opencode/core/model-route"
import { SessionStep } from "@opencode/core/session/runner/step"

const error = (reason: ConstructorParameters<typeof AIError>[0]["reason"]) => new AIError({ reason })

describe("SessionStep.failureHint", () => {
  test("reads a stated retry-after from a rate limit, directly or from its details", () => {
    expect(SessionStep.failureHint(error(new RateLimitError({ message: "slow down", retryAfterMs: 7_000 })))).toEqual({
      retryAfterMs: 7_000,
      quota: false,
      rateLimit: true,
      auth: false,
      network: false,
    })
    expect(
      SessionStep.failureHint(error(new RateLimitError({ message: "slow down", rateLimit: { retryAfterMs: 9_000 } }))),
    ).toMatchObject({ retryAfterMs: 9_000, quota: false, network: false })
  })

  test("flags authentication refusals for the long first bench", () => {
    expect(SessionStep.failureHint(error(new AuthenticationError({ message: "bad key" })))).toMatchObject({
      auth: true,
      quota: false,
    })
    const http = (status: number) => ({ url: "https://api.example.com/v1", status, headers: {} })
    expect(
      SessionStep.failureHint(error(new ProviderInternalError({ message: "forbidden", http: http(403) }))),
    ).toMatchObject({ auth: true })
    expect(
      SessionStep.failureHint(error(new ProviderInternalError({ message: "unauthorized", http: http(401) }))),
    ).toMatchObject({ auth: true })
    expect(
      SessionStep.failureHint(
        error(new ProviderInternalError({ message: "Your organization has disabled Claude subscription access" })),
      ),
    ).toMatchObject({ auth: true })
    expect(
      SessionStep.failureHint(error(new ProviderInternalError({ message: "overloaded", http: http(500) }))),
    ).toMatchObject({ auth: false })
  })

  test("flags an exhausted quota, which carries no retry-after", () => {
    const hint = SessionStep.failureHint(error(new QuotaExceededError({ message: "out of quota" })))
    expect(hint).toEqual({
      retryAfterMs: undefined,
      quota: true,
      rateLimit: false,
      auth: false,
      network: false,
    })
    expect("quotaResetAtMs" in hint).toBe(false)
  })

  test("omits quotaResetAtMs when no reset is stated, and sets it when stated in text (#2113)", () => {
    const withoutReset = SessionStep.failureHint(error(new QuotaExceededError({ message: "out of quota" })))
    expect("quotaResetAtMs" in withoutReset).toBe(false)
    expect(withoutReset.quotaResetAtMs).toBeUndefined()

    const before = Date.now()
    const withReset = SessionStep.failureHint(
      error(
        new QuotaExceededError({
          message: "Individual quota reached. Resets in 2 hours.",
        }),
      ),
    )
    const after = Date.now()
    expect("quotaResetAtMs" in withReset).toBe(true)
    expect(withReset.quotaResetAtMs).toBeGreaterThanOrEqual(before + 2 * 3600 * 1000)
    expect(withReset.quotaResetAtMs).toBeLessThanOrEqual(after + 2 * 3600 * 1000)
  })

  test("binds a quota reset stated only in the error body, not just the message (#2108)", () => {
    const absolute = SessionStep.failureHint(
      error(
        new QuotaExceededError({
          message: "out of quota",
          body: "quota reset at 2099-01-01T00:00:00Z",
        }),
      ),
    )
    expect(absolute.quota).toBe(true)
    expect(absolute.quotaResetAtMs).toBe(Date.parse("2099-01-01T00:00:00Z"))

    const before = Date.now()
    const relative = SessionStep.failureHint(
      error(
        new QuotaExceededError({
          message: "out of quota",
          body: "Individual quota reached. Resets in 2 hours.",
        }),
      ),
    )
    const after = Date.now()
    expect(relative.quotaResetAtMs).toBeGreaterThanOrEqual(before + 2 * 3600 * 1000)
    expect(relative.quotaResetAtMs).toBeLessThanOrEqual(after + 2 * 3600 * 1000)
  })

  test("reads a stated wait only in the error body as a retry-after (#2108)", () => {
    expect(
      SessionStep.failureHint(
        error(new ProviderInternalError({ message: "overloaded", body: "please wait in 30 minutes" })),
      ),
    ).toMatchObject({ retryAfterMs: 30 * 60 * 1000, quota: false })
  })

  test("a reset stated in the message wins over one stated later in the body (#2108)", () => {
    const hint = SessionStep.failureHint(
      error(
        new QuotaExceededError({
          message: "quota exhausted, resets at 2099-01-01T00:00:00Z",
          body: "resets at 2099-06-01T00:00:00Z",
        }),
      ),
    )
    expect(hint.quotaResetAtMs).toBe(Date.parse("2099-01-01T00:00:00Z"))
  })

  test("the client-timeout guard still suppresses a body-stated wait (#1551, #2108)", () => {
    expect(
      SessionStep.failureHint(
        error(
          new TransportError({
            message: "No response output within 1000ms",
            body: "wait in 30 minutes",
            transport: "http",
            operation: "request",
            code: "Timeout",
          }),
        ),
      ),
    ).toMatchObject({ retryAfterMs: undefined, network: false })
  })

  test("an ordinary provider failure may carry a retry-after and is never a quota", () => {
    expect(
      SessionStep.failureHint(error(new ProviderInternalError({ message: "overloaded", retryAfterMs: 3_000 }))),
    ).toEqual({ retryAfterMs: 3_000, quota: false, rateLimit: false, auth: false, network: false })
    expect(
      SessionStep.failureHint(error(new TransportError({ message: "reset", transport: "http", operation: "read" }))),
    ).toEqual({ retryAfterMs: undefined, quota: false, rateLimit: false, auth: false, network: true })
    expect(
      SessionStep.failureHint(
        error(
          new TransportError({
            message: "No response output within 1000ms",
            transport: "http",
            operation: "request",
            code: "Timeout",
          }),
        ),
      ),
    ).toEqual({ retryAfterMs: undefined, quota: false, rateLimit: false, auth: false, network: false })
  })

  test("a provider-stated wait on a transport timeout still yields a retry-after (#1551)", () => {
    expect(
      SessionStep.failureHint(
        error(
          new TransportError({
            message: "provider asked us to wait in 5 seconds",
            transport: "http",
            operation: "request",
            code: "Timeout",
          }),
        ),
      ),
    ).toMatchObject({ retryAfterMs: 5_000, network: true })
  })
})

describe("SessionStep.quotaFailureClassification", () => {
  test("a QuotaExceeded tag is balance exhaustion", () => {
    expect(
      SessionStep.quotaFailureClassification(error(new QuotaExceededError({ message: "out of quota" }))),
    ).toBe("balance-exhaustion")
  })

  test("explicitly credit/balance-specific text is balance exhaustion", () => {
    expect(
      SessionStep.quotaFailureClassification(error(new UnknownProviderError({ message: "insufficient credits" }))),
    ).toBe("balance-exhaustion")
    expect(
      SessionStep.quotaFailureClassification(
        error(new UnknownProviderError({ message: "Your credit balance is too low" })),
      ),
    ).toBe("balance-exhaustion")
  })

  test("generic limit text is only a rate limit, never balance exhaustion (#1380)", () => {
    expect(
      SessionStep.quotaFailureClassification(
        error(new RateLimitError({ message: "You have reached your rate limit" })),
      ),
    ).toBe("rate-limit")
    expect(
      SessionStep.quotaFailureClassification(error(new UnknownProviderError({ message: "usage limit exceeded" }))),
    ).toBe("rate-limit")
    expect(
      SessionStep.quotaFailureClassification(error(new UnknownProviderError({ message: "quota exhausted" }))),
    ).toBe("rate-limit")
  })

  test("an ordinary failure does not enter the quota-failure path", () => {
    expect(
      SessionStep.quotaFailureClassification(error(new ProviderInternalError({ message: "overloaded" }))),
    ).toBeUndefined()
  })
})

describe("SessionStep failed attempt counter", () => {
  test("counts per key and clears on request", () => {
    expect(SessionStep.countFailedAttempt("a|x/y")).toBe(1)
    expect(SessionStep.countFailedAttempt("a|x/y")).toBe(2)
    expect(SessionStep.failedAttemptCount("a|x/y")).toBe(2)
    SessionStep.clearFailedAttempt("a|x/y")
    expect(SessionStep.failedAttemptCount("a|x/y")).toBe(0)
  })

  test("never grows past its limit and forgets the oldest keys first", () => {
    for (let index = 0; index < SessionStep.FAILED_ATTEMPT_LIMIT + 500; index++)
      SessionStep.countFailedAttempt(`bounded|${index}`)
    expect(SessionStep.failedAttemptCount()).toBeLessThanOrEqual(SessionStep.FAILED_ATTEMPT_LIMIT)
    expect(SessionStep.failedAttemptCount("bounded|0")).toBe(0)
    expect(SessionStep.failedAttemptCount(`bounded|${SessionStep.FAILED_ATTEMPT_LIMIT + 499}`)).toBe(1)
  })
})

describe("SessionStep.captureRateLimit", () => {
  const target = ModelRoute.ref({ providerID: "openai", model: "captured" })
  const http = (headers: Record<string, string>) =>
    ({ url: "https://api.example.com/v1", status: 200, headers }) as never

  test("keeps what a successful response said about OpenAI-style windows and acts on a spent one", () => {
    ModelRoute.resetHealth()
    const { capture, options } = SessionStep.captureRateLimit(target)
    options({}).onResponse?.(
      http({
        "x-ratelimit-limit-requests": "60",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "20s",
        "x-ratelimit-remaining-tokens": "9000",
        "x-ratelimit-limit-tokens": "10000",
        "content-type": "text/event-stream",
      }),
    )
    expect(capture.snapshot).toMatchObject({
      limit: { requests: "60", tokens: "10000" },
      remaining: { requests: "0", tokens: "9000" },
      reset: { requests: "20s" },
    })
    expect(ModelRoute.limitedUntil(target)).toBeGreaterThan(Date.now() + 15_000)
  })

  test("reads Anthropic-style windows with timestamp resets", () => {
    ModelRoute.resetHealth()
    const { capture, options } = SessionStep.captureRateLimit(target)
    const reset = new Date(Date.now() + 120_000).toISOString()
    options({}).onResponse?.(
      http({
        "anthropic-ratelimit-requests-limit": "50",
        "anthropic-ratelimit-requests-remaining": "49",
        "anthropic-ratelimit-requests-reset": reset,
        "anthropic-ratelimit-output-tokens-remaining": "0",
        "anthropic-ratelimit-output-tokens-limit": "8000",
        "anthropic-ratelimit-output-tokens-reset": reset,
      }),
    )
    expect(capture.snapshot?.remaining).toEqual({ requests: "49", "output-tokens": "0" })
    expect(ModelRoute.limitedUntil(target)).toBeGreaterThan(Date.now() + 100_000)
  })

  test("a response without rate-limit headers captures nothing and holds nothing", () => {
    ModelRoute.resetHealth()
    const { capture, options } = SessionStep.captureRateLimit(target)
    options({}).onResponse?.(http({ "content-type": "text/event-stream" }))
    expect(capture.snapshot).toBeUndefined()
    expect(ModelRoute.rateLimitOf(target)).toBeUndefined()
  })

  test("a rejection's own headers update rate-limit state like a success's do", () => {
    ModelRoute.resetHealth()
    const { capture, options } = SessionStep.captureRateLimit(target)
    options({}).onRejected?.(
      new AIError({
        reason: new RateLimitError({
          message: "slow down",
          rateLimit: { limit: { requests: "60" }, remaining: { requests: "0" }, reset: { requests: "45s" } },
        }),
      }),
    )
    expect(capture.snapshot).toMatchObject({ remaining: { requests: "0" }, reset: { requests: "45s" } })
    expect(ModelRoute.limitedUntil(target)).toBeGreaterThan(Date.now() + 40_000)
  })

  test("still calls an existing observer", () => {
    ModelRoute.resetHealth()
    const seen: number[] = []
    const { options } = SessionStep.captureRateLimit(target)
    options({ onResponse: (value) => void seen.push(value.status) }).onResponse?.(http({}))
    expect(seen).toEqual([200])
  })
})
