import { afterEach, describe, expect, test } from "bun:test"
import { AIError, isRetryable } from "@opencode/ai"
import { ModelRoute } from "@opencode/core/model-route"
import { SessionStep } from "@opencode/core/session/runner/step"
import { MockProvider, MockScenarios } from "./fixture/mock-provider"
import { driveStep } from "./fixture/mock-route-driver"

afterEach(() => {
  ModelRoute.resetHealth()
  ModelRoute.resetSelection()
  ModelRoute.setAdjustments([])
})

const ref = (providerID: string, model: string) => ModelRoute.ref({ providerID, model })

const definition = (
  id: string,
  targets: readonly ModelRoute.Target[],
  nodes: unknown,
  health?: ModelRoute.Policy,
): ModelRoute.Definition =>
  ({
    id,
    targets,
    targetVariants: [],
    health: health ?? ModelRoute.policy(),
    nodes,
  }) as unknown as ModelRoute.Definition

const poolOfTwo = (id: string, a: ModelRoute.Target, b: ModelRoute.Target, health?: ModelRoute.Policy) =>
  definition(id, [a, b], [{ selection: "round-robin", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }], health)

const failure = async (mock: MockProvider, target: ModelRoute.Target, credentialID?: string): Promise<AIError> => {
  const error = await mock.attempt(target, credentialID).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(AIError)
  return error as AIError
}

describe("MockProvider wire fidelity", () => {
  test("the Antigravity wall classifies as a retryable rate limit with the reset in its text", async () => {
    const mock = new MockProvider()
    const target = ref("antigravity-direct", "claude-sonnet-5-5")
    mock.set(target, MockScenarios.antigravityQuotaWall())
    const error = await failure(mock, target)
    expect(error.reason._tag).toBe("RateLimit")
    expect(error.reason.http?.status).toBe(429)
    expect(isRetryable(error)).toBe(true)
    // The reset lives only in the message text; the runner's hint extraction must find it,
    // or the cooldown cannot be driven by the stated reset (#1806 mechanism 4).
    const hint = SessionStep.failureHint(error)
    expect(hint.quota).toBe(false)
    expect(hint.retryAfterMs).toBeDefined()
    const expected = (81 * 3600 + 35 * 60 + 49) * 1000
    expect(Math.abs(hint.retryAfterMs! - expected)).toBeLessThan(60_000)
  })

  test("a quota-coded answer classifies as QuotaExceeded and is not same-target retryable", async () => {
    const mock = new MockProvider()
    const target = ref("mistral", "mistral-small-latest")
    mock.set(target, MockScenarios.quotaExceeded())
    const error = await failure(mock, target)
    expect(error.reason._tag).toBe("QuotaExceeded")
    expect(isRetryable(error)).toBe(false)
    expect(SessionStep.isQuotaFailure(error)).toBe(true)
    expect(SessionStep.quotaFailureClassification(error)).toBe("balance-exhaustion")
  })

  test("an HTTP 401 classifies as Authentication and hints the long bench", async () => {
    const mock = new MockProvider()
    const target = ref("prov", "m")
    mock.set(target, MockScenarios.auth())
    const error = await failure(mock, target)
    expect(error.reason._tag).toBe("Authentication")
    expect(SessionStep.failureHint(error).auth).toBe(true)
  })

  test("an HTTP 500 classifies as a retryable provider-internal error", async () => {
    const mock = new MockProvider()
    const target = ref("prov", "m")
    mock.set(target, MockScenarios.serverError())
    const error = await failure(mock, target)
    expect(error.reason._tag).toBe("ProviderInternal")
    expect(isRetryable(error)).toBe(true)
  })

  test("a stated retry-after header lands on the rate-limit reason", async () => {
    const mock = new MockProvider()
    const target = ref("prov", "m")
    mock.set(target, MockScenarios.rateLimit(2))
    const error = await failure(mock, target)
    expect(error.reason._tag).toBe("RateLimit")
    expect(error.reason._tag === "RateLimit" && error.reason.retryAfterMs).toBe(2000)
  })

  test("a DNS failure is a transport error with the OS code and a network hint", async () => {
    const mock = new MockProvider()
    const target = ref("prov", "m")
    mock.set(target, MockScenarios.dnsFailure())
    const error = await failure(mock, target)
    expect(error.reason._tag).toBe("Transport")
    expect(error.reason._tag === "Transport" && error.reason.code).toBe("ENOTFOUND")
    expect(error.reason.http).toBeUndefined()
    expect(SessionStep.failureHint(error).network).toBe(true)
  })
})

describe("MockProvider scripting", () => {
  test("serves text and tool-call outcomes, consumes sequences, and repeats the last outcome", async () => {
    const mock = new MockProvider()
    const target = ref("prov", "m")
    mock.script(target, [MockScenarios.quotaExceeded(), MockScenarios.toolCall("weather", { city: "Osseo" })])
    const error = await failure(mock, target)
    expect(error.reason._tag).toBe("QuotaExceeded")
    const success = await mock.attempt(target)
    expect(success.type).toBe("tool-call")
    expect(success.toolCalls[0]?.name).toBe("weather")
    expect(success.toolCalls[0]?.input).toEqual({ city: "Osseo" })
    // The last outcome repeats: the tool call keeps being the answer until re-scripted.
    expect((await mock.attempt(target)).type).toBe("tool-call")
    expect(mock.attempts()).toBe(3)
    mock.set(target, MockScenarios.succeed("recovered"))
    expect((await mock.attempt(target)).text).toBe("recovered")
  })

  test("a timeout outcome never settles", async () => {
    const mock = new MockProvider()
    const target = ref("prov", "m")
    mock.set(target, MockScenarios.timeout())
    const verdict = await Promise.race([
      mock.attempt(target).then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 30)),
    ])
    expect(verdict).toBe("pending")
  })

  test("an unscripted target is a loud defect, not a provider error", async () => {
    const mock = new MockProvider()
    const error = await mock.attempt(ref("ghost", "m")).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(AIError)
  })
})

describe("MockRouteDriver failover (#1806)", () => {
  test("acceptance: a two-member pool whose serving member walls mid-session completes on the other member", async () => {
    const a = ref("prov-a", "model-a")
    const b = ref("prov-b", "model-b")
    const route = poolOfTwo("wall-pool", a, b)
    const mock = new MockProvider()
    mock.set(a, MockScenarios.succeed("from-a"))
    mock.set(b, MockScenarios.succeed("from-b"))

    const first = await driveStep({ definition: route, mock, sessionID: "s1" })
    expect(first.status).toBe("served")
    const walled = first.servedIndex!
    const survivor = 1 - walled
    mock.set([a, b][walled], MockScenarios.quotaExceeded())

    const second = await driveStep({ definition: route, mock, sessionID: "s1" })
    expect(second.status).toBe("served")
    expect(second.servedIndex).toBe(survivor)
    expect(second.attempts).toHaveLength(2)
    expect(second.attempts[0]?.index).toBe(walled)
    expect(second.attempts[0]?.error?.reason._tag).toBe("QuotaExceeded")
    expect(second.attempts[1]?.index).toBe(survivor)
  })

  test("an Antigravity-shaped wall fails over in-step and the member is not re-attempted next step", async () => {
    const a = ref("antigravity-direct", "claude-sonnet-5-5")
    const b = ref("prov-b", "model-b")
    const route = poolOfTwo("ag-pool", a, b)
    const mock = new MockProvider()
    mock.set(a, MockScenarios.antigravityQuotaWall())
    mock.set(b, MockScenarios.succeed("from-b"))

    const first = await driveStep({ definition: route, mock, sessionID: "s2" })
    expect(first.status).toBe("served")
    expect(first.servedTarget).toBe(b)
    expect(first.attempts[0]?.error?.reason._tag).toBe("RateLimit")

    const second = await driveStep({ definition: route, mock, sessionID: "s2" })
    expect(second.status).toBe("served")
    expect(second.servedTarget).toBe(b)
    expect(mock.attempts(MockProvider.key(a))).toBe(1)
  })

  test("a quota failure breaks the session's pin on an ordered route and the session stays moved", async () => {
    const a = ref("prov-a", "model-a")
    const b = ref("prov-b", "model-b")
    const route = definition("ordered-route", [a, b], [
      { selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
    ])
    const mock = new MockProvider()
    mock.set(a, MockScenarios.succeed("from-a"))
    mock.set(b, MockScenarios.succeed("from-b"))

    const first = await driveStep({ definition: route, mock, sessionID: "s3" })
    expect(first.servedTarget).toBe(a)
    expect(ModelRoute.continuityOf("ordered-route", "s3")?.current).toContain("model-a")

    mock.set(a, MockScenarios.quotaExceeded())
    const second = await driveStep({ definition: route, mock, sessionID: "s3" })
    expect(second.status).toBe("served")
    expect(second.servedTarget).toBe(b)
    expect(ModelRoute.continuityOf("ordered-route", "s3")?.current).toContain("model-b")

    const third = await driveStep({ definition: route, mock, sessionID: "s3" })
    expect(third.servedTarget).toBe(b)
    expect(mock.attempts(MockProvider.key(a))).toBe(2)
  })

  test("failover excludes attempted leaves, not the pool they came from", async () => {
    const targets = [ref("prov-a", "model-a"), ref("prov-b", "model-b"), ref("prov-c", "model-c")]
    const route = definition("trio", targets, [
      { selection: "round-robin", weights: [1, 1, 1], children: [{ leaf: 0 }, { leaf: 1 }, { leaf: 2 }] },
    ])
    const mock = new MockProvider()
    for (const target of targets) mock.set(target, MockScenarios.succeed("ok"))
    const first = await driveStep({ definition: route, mock, sessionID: "s4" })
    expect(first.status).toBe("served")
    const walled = first.servedIndex!
    mock.set(targets[walled], MockScenarios.serverError())

    const second = await driveStep({ definition: route, mock, sessionID: "s4" })
    expect(second.status).toBe("served")
    expect(second.servedIndex).not.toBe(walled)
    expect(second.attempts).toHaveLength(2)
    expect(second.attempts[0]?.error?.reason._tag).toBe("ProviderInternal")
  })

  test("no-candidates only when every member is out", async () => {
    const a = ref("prov-a", "model-a")
    const b = ref("prov-b", "model-b")
    const route = poolOfTwo("all-walled", a, b)
    const mock = new MockProvider()
    mock.set(a, MockScenarios.quotaExceeded())
    mock.set(b, MockScenarios.quotaExceeded())
    const result = await driveStep({ definition: route, mock, sessionID: "s5" })
    expect(result.status).toBe("no-candidates")
    expect(result.attempts).toHaveLength(2)
  })

  test("an auth failure takes the long bench and the step rotates", async () => {
    const a = ref("prov-a", "model-a")
    const b = ref("prov-b", "model-b")
    const route = definition("auth-route", [a, b], [
      { selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
    ])
    const mock = new MockProvider()
    mock.set(a, MockScenarios.auth())
    mock.set(b, MockScenarios.succeed("from-b"))
    const before = Date.now()
    const result = await driveStep({ definition: route, mock, sessionID: "s6" })
    expect(result.status).toBe("served")
    expect(result.servedTarget).toBe(b)
    // Auth benches start from the quota-length bench (15 min by default), not the 60 s
    // ordinary-failure bench.
    expect(ModelRoute.cooldownUntil(a, before) - before).toBeGreaterThanOrEqual(899_000)
  })

  test("a DNS failure rotates and benches the leaf as a network failure", async () => {
    const a = ref("prov-a", "model-a")
    const b = ref("prov-b", "model-b")
    const route = definition("dns-route", [a, b], [
      { selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
    ])
    const mock = new MockProvider()
    mock.set(a, MockScenarios.dnsFailure())
    mock.set(b, MockScenarios.succeed("from-b"))
    const result = await driveStep({ definition: route, mock, sessionID: "s7" })
    expect(result.status).toBe("served")
    expect(result.servedTarget).toBe(b)
    expect(SessionStep.failureHint(result.attempts[0]!.error!).network).toBe(true)
    expect(ModelRoute.coolingDown(a)).toBe(true)
  })

  test("a hung member times out in the runner's shape and the step rotates without wedging", async () => {
    const a = ref("prov-a", "model-a")
    const b = ref("prov-b", "model-b")
    const route = definition(
      "timeout-route",
      [a, b],
      [{ selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
      ModelRoute.policy({ firstTokenTimeoutMs: 50 }),
    )
    const mock = new MockProvider()
    mock.set(a, MockScenarios.timeout())
    mock.set(b, MockScenarios.succeed("from-b"))
    const result = await driveStep({ definition: route, mock, sessionID: "s8" })
    expect(result.status).toBe("served")
    expect(result.servedTarget).toBe(b)
    const reason = result.attempts[0]?.error?.reason
    expect(reason?._tag).toBe("Transport")
    expect(reason?._tag === "Transport" && reason.code).toBe("Timeout")
    expect(reason?.message).toBe("No response output within 50ms")
  })

  test("a quota-gated credential switches on the same leaf before the route moves on", async () => {
    const leaf = ref("multi-cred", "model-x")
    const route = definition("cred-route", [leaf], [{ selection: "ordered", weights: [1], children: [{ leaf: 0 }] }])
    const mock = new MockProvider()
    mock.set(leaf, MockScenarios.quotaExceeded(), "cred-full")
    mock.set(leaf, MockScenarios.succeed("served-on-cred-ok"))
    const result = await driveStep({
      definition: route,
      mock,
      sessionID: "s9",
      credentials: new Map([["multi-cred", ["cred-full", "cred-ok"]]]),
    })
    expect(result.status).toBe("served")
    expect(result.servedIndex).toBe(0)
    expect(result.servedCredentialID).toBe("cred-ok")
    expect(result.attempts).toHaveLength(2)
    expect(result.attempts[0]?.credentialID).toBe("cred-full")
    expect(result.attempts[0]?.error?.reason._tag).toBe("QuotaExceeded")
    expect(result.attempts[1]?.credentialID).toBe("cred-ok")
    // The failure belonged to the credential: the leaf itself is not benched, its gated
    // credential is.
    expect(ModelRoute.coolingDown(leaf)).toBe(false)
    expect(ModelRoute.credentialCoolingDown(leaf, "cred-full")).toBe(true)
  })

  test("a walled member serves again once its bench expires", async () => {
    const a = ref("prov-a", "model-a")
    const b = ref("prov-b", "model-b")
    const route = definition(
      "recover-route",
      [a, b],
      [{ selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
      ModelRoute.policy({ cooldownMs: 40 }),
    )
    const mock = new MockProvider()
    mock.script(a, [MockScenarios.serverError(), MockScenarios.succeed("a-again")])
    mock.set(b, MockScenarios.succeed("from-b"))
    const first = await driveStep({ definition: route, mock })
    expect(first.servedTarget).toBe(b)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const second = await driveStep({ definition: route, mock })
    expect(second.status).toBe("served")
    expect(second.servedTarget).toBe(a)
    expect(mock.attempts(MockProvider.key(a))).toBe(2)
  })

  test("a tool-call outcome completes the step as a success", async () => {
    const a = ref("prov-a", "model-a")
    const route = definition("tool-route", [a], [{ selection: "ordered", weights: [1], children: [{ leaf: 0 }] }])
    const mock = new MockProvider()
    mock.set(a, MockScenarios.toolCall("weather", { city: "Osseo" }))
    const result = await driveStep({ definition: route, mock, sessionID: "s10" })
    expect(result.status).toBe("served")
    expect(result.success?.type).toBe("tool-call")
    expect(result.success?.toolCalls[0]?.name).toBe("weather")
  })
})

describe("stated-reset cooldowns (#1806 mechanism 4)", () => {
  test("a stated reset under the day cap sets the bench itself", async () => {
    const a = ref("antigravity-direct", "claude-sonnet-5-5")
    const route = definition("reset-route", [a], [{ selection: "ordered", weights: [1], children: [{ leaf: 0 }] }])
    const mock = new MockProvider()
    mock.set(a, MockScenarios.antigravityQuotaWall("2h0m0s"))
    const before = Date.now()
    const result = await driveStep({ definition: route, mock, sessionID: "s11" })
    expect(result.status).toBe("no-candidates")
    const bench = ModelRoute.cooldownUntil(a, before) - before
    expect(Math.abs(bench - 2 * 3600_000)).toBeLessThan(60_000)
  })

  test("Antigravity's 81h reset: the bench caps at a day, the quota gate holds to the stated reset", async () => {
    const a = ref("antigravity-direct", "claude-sonnet-5-5")
    const route = definition("reset-route-81", [a], [{ selection: "ordered", weights: [1], children: [{ leaf: 0 }] }])
    const mock = new MockProvider()
    mock.set(a, MockScenarios.antigravityQuotaWall())
    const before = Date.now()
    const result = await driveStep({ definition: route, mock, sessionID: "s12" })
    expect(result.status).toBe("no-candidates")
    // The bench ladder caps any single bench at a day…
    const bench = ModelRoute.cooldownUntil(a, before) - before
    expect(Math.abs(bench - 86_400_000)).toBeLessThan(60_000)
    // …but the provider quota gate installed by the same failure holds the leaf out to the
    // stated reset, so a day later the member is still not a candidate, and after the
    // stated reset it is.
    const scope = ModelRoute.scopeOf(route, [])
    expect(ModelRoute.skipped(a, before + 25 * 3600_000, scope)).toBe(true)
    expect(ModelRoute.skipped(a, before + 82 * 3600_000, scope)).toBe(false)
  })

  // The incident's fatal resolution happened one altitude up: workhorse's cascade entered
  // the sonnet-plan route, and when the chain re-resolved the parent, the parent's tried
  // set — seeded by target ref from the chain — excluded the parent's untried healthy
  // member (Luna) as if its whole subtree had been attempted. That path is the resolver
  // service's cascade (model-resolver.ts), which this route-level driver deliberately does
  // not reproduce; the scenario needs a resolver-service harness (mocked Provider/Model
  // layers, as in session-runner-model.test.ts) and is the acceptance core of #1806.
  test.skip("route chains: a wall inside a nested route does not strand the parent route's untried members (#1806)", () => {
    throw new Error("pending #1806: needs the resolver-service cascade harness")
  })
})
