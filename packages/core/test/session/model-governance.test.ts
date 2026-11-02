import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Info } from "@opencode/schema/config"
import { Model } from "@opencode/schema/model"
import { Agent } from "@opencode/core/agent"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { NotFoundError } from "@opencode/core/session"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ModelGovernance } from "@opencode/core/session/model-governance"
import { SessionSchema } from "@opencode/core/session/schema"
import { Money } from "@opencode/schema/money"

const decodeInfo = Schema.decodeUnknownSync(Info)

const ref = (input: string) => Model.Ref.parse(input)

const info = (
  id: string,
  options: {
    parentID?: string
    agent?: string
    model?: string
    subagentPolicy?: SessionSchema.SubagentPolicy
  } = {},
): SessionSchema.Info =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.make(id),
    parentID: options.parentID ? SessionSchema.ID.make(options.parentID) : undefined,
    projectID: Project.ID.global,
    agent: options.agent ? Agent.ID.make(options.agent) : undefined,
    model: options.model ? ref(options.model) : undefined,
    subagentPolicy: options.subagentPolicy,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
  })

const sessions = (list: SessionSchema.Info[]) => {
  const byID = new Map(list.map((session) => [session.id, session]))
  return {
    get: (sessionID: SessionSchema.ID) => {
      const session = byID.get(sessionID)
      return session ? Effect.succeed(session) : Effect.fail(new NotFoundError({ sessionID }))
    },
  }
}

type Input = Parameters<typeof ModelGovernance.assertAllowed>[2] & {
  all: SessionSchema.Info[]
  configInput?: Record<string, unknown>
  catalogInput?: Record<string, Record<string, { enabled?: boolean; variants?: readonly string[] }>>
}

// Entries in production are the normalizer's output, so fixtures go through the same
// seam: flat `experimental.model_routes` inputs fold into the canonical nested
// `experimental.routes.models` shape governance now reads (#1140).
const normalizedInfo = (input: Record<string, unknown>) => {
  const result = ConfigNormalize.normalize(input)
  if (result.type !== "normalized") throw new Error("expected normalized config")
  return decodeInfo(result.encoded)
}

const entriesConfig = (input: Input) => ({
  entries: () =>
    Effect.succeed([
      {
        type: "document" as const,
        info: normalizedInfo(input.configInput ?? {}),
      } as never,
    ]),
  catalog: () =>
    Effect.succeed(
      input.catalogInput === undefined
        ? undefined
        : new Map(
            Object.entries(input.catalogInput).map(([providerID, models]) => [
              providerID,
              new Map(
                Object.entries(models).map(([id, model]) => [
                  id,
                  { enabled: model.enabled ?? true, variants: (model.variants ?? []).map((id) => ({ id })) },
                ]),
              ),
            ]),
          ),
    ),
})

const run = (input: Input) =>
  Effect.runPromise(ModelGovernance.assertAllowed(sessions(input.all), entriesConfig(input), input))

const runDenied = async (input: Input) => {
  const error = await Effect.runPromise(
    ModelGovernance.assertAllowed(sessions(input.all), entriesConfig(input), input).pipe(Effect.flip),
  )
  expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
  return (error as ModelGovernance.DeniedError).message
}

describe("ModelGovernance.assertAllowed", () => {
  test("composes ancestor policies by intersection (the Haiku example)", async () => {
    const primary = info("ses_primary", {
      subagentPolicy: { models: ["cline-pass/*", "anthropic/claude-haiku-5-5"] },
    })
    const child = info("ses_child", {
      parentID: "ses_primary",
      subagentPolicy: { models: ["anthropic/claude-opus-5-5", "anthropic/claude-haiku-5-5"] },
    })
    const all = [primary, child]

    await run({ all, parent: child, model: ref("anthropic/claude-haiku-5-5") })
    const message = await runDenied({ all, parent: child, model: ref("anthropic/claude-opus-5-5") })
    expect(message).toContain("anthropic/claude-opus-5-5")
    expect(message).toContain("anthropic/claude-haiku-5-5")
    expect(message).not.toContain("cline-pass")
    const pooled = await runDenied({ all, parent: child, model: ref("cline-pass/pool-model") })
    expect(pooled).toContain("anthropic/claude-haiku-5-5")
  })

  test("excluded selectors beat allowed selectors", async () => {
    const parent = info("ses_parent", {
      subagentPolicy: { models: ["anthropic/*"], excludedModels: ["anthropic/claude-opus-5-5"] },
    })
    await run({ all: [parent], parent, model: ref("anthropic/claude-sonnet-5") })
    const message = await runDenied({ all: [parent], parent, model: ref("anthropic/claude-opus-5-5") })
    expect(message).toContain("excluded")
    expect(message).toContain("anthropic/claude-opus-5-5")
  })

  test("a definition whose list holds only its default locks the agent to it", async () => {
    const parent = info("ses_parent")
    const configInput = { agents: { locked: { model: "test/only", models: ["test/only"] } } }
    await run({ all: [parent], parent, configInput, agent: Agent.ID.make("locked") })
    await run({ all: [parent], parent, configInput, agent: Agent.ID.make("locked"), model: ref("test/only") })
    const message = await runDenied({
      all: [parent],
      parent,
      configInput,
      agent: Agent.ID.make("locked"),
      model: ref("test/other"),
    })
    expect(message).toContain("test/only")
  })

  test("the launching agent's subagent lists bind its direct children only", async () => {
    const parent = info("ses_parent", { agent: "reasoner" })
    const child = info("ses_child", { parentID: "ses_parent", agent: "worker" })
    const configInput = { agents: { reasoner: { subagent_models: ["anthropic/claude-haiku-5-5"] } } }
    const all = [parent, child]
    await run({ all, parent, configInput, model: ref("anthropic/claude-haiku-5-5") })
    await runDenied({ all, parent, configInput, model: ref("anthropic/claude-opus-5-5") })
    // The grandchild's launch is governed by its own parent's definition, not Reasoner's.
    await run({ all, parent: child, configInput, model: ref("anthropic/claude-opus-5-5") })
  })

  test("a policy override's subagent lists narrow the launching agent's subagent lists", async () => {
    const parent = info("ses_parent", {
      agent: "reasoner",
      subagentPolicy: { agentOverrides: { worker: { subagentModels: ["test/a"] } } },
    })
    const configInput = { agents: { reasoner: { subagent_models: ["test/a", "test/b"] } } }
    const all = [parent]
    await run({ all, parent, configInput, agent: Agent.ID.make("worker"), model: ref("test/a") })
    const message = await runDenied({
      all,
      parent,
      configInput,
      agent: Agent.ID.make("worker"),
      model: ref("test/b"),
    })
    expect(message).toContain("subagent models of agent reasoner")
    expect(message).toContain("test/a")
  })

  test("a per-call override's subagent lists bind even without a launching definition", async () => {
    const parent = info("ses_parent", { agent: "plugin-agent" })
    const all = [parent]
    await run({ all, parent, override: { subagentModels: ["test/a"] }, model: ref("test/a") })
    await runDenied({ all, parent, override: { subagentModels: ["test/a"] }, model: ref("test/b") })
    await runDenied({
      all,
      parent,
      override: { subagentExcludedModels: ["test/b"] },
      model: ref("test/b"),
    })
    await run({ all, parent, override: { subagentExcludedModels: ["test/b"] }, model: ref("test/a") })
  })

  test("a forced override's subagent lists replace the launching agent's subagent lists", async () => {
    const parent = info("ses_parent", { agent: "reasoner" })
    const configInput = { agents: { reasoner: { subagent_models: ["test/a", "test/b"] } } }
    const all = [parent]
    await run({
      all,
      parent,
      configInput,
      override: { force: true, subagentModels: ["test/c"] },
      model: ref("test/c"),
    })
    await runDenied({
      all,
      parent,
      configInput,
      override: { force: true, subagentModels: ["test/c"] },
      model: ref("test/a"),
    })
  })

  test("a policy override with models and force leaves the launching agent's subagent lists in force", async () => {
    const parent = info("ses_parent", {
      agent: "reasoner",
      subagentPolicy: { agentOverrides: { worker: { models: ["test/a", "test/c"], force: true } } },
    })
    const configInput = {
      agents: {
        reasoner: { subagent_models: ["test/a", "test/b"] },
        worker: { models: ["test/a"] },
      },
    }
    const all = [parent]
    // The forced list replaces the worker's own lists, and test/a is in both layers.
    await run({ all, parent, configInput, agent: Agent.ID.make("worker"), model: ref("test/a") })
    // test/c is in the forced own list but outside the launcher's subagent lists,
    // which the override never mentions and so must not clear.
    const message = await runDenied({
      all,
      parent,
      configInput,
      agent: Agent.ID.make("worker"),
      model: ref("test/c"),
    })
    expect(message).toContain("subagent models of agent reasoner")
  })

  test("a per-call force override with no subagent lists keeps the launching agent's subagent exclusions", async () => {
    const parent = info("ses_parent", { agent: "reasoner" })
    const configInput = {
      agents: {
        reasoner: { subagent_excluded_models: ["test/b"] },
        worker: { models: ["test/c"] },
      },
    }
    const all = [parent]
    // The Task tool's { model, force } shape: force clears the worker's own lists,
    // so a model outside them passes...
    await run({ all, parent, configInput, agent: Agent.ID.make("worker"), model: ref("test/a"), override: { force: true } })
    // ...but the launcher's subagent exclusions, which the override never mentions, still bind.
    const message = await runDenied({
      all,
      parent,
      configInput,
      agent: Agent.ID.make("worker"),
      model: ref("test/b"),
      override: { force: true },
    })
    expect(message).toContain("excluded")
    expect(message).toContain("subagent models of agent reasoner")
  })

  test("an override with only subagent lists and force leaves the child agent's own lists in force", async () => {
    const parent = info("ses_parent")
    const configInput = { agents: { worker: { models: ["test/a"] } } }
    const all = [parent]
    await run({
      all,
      parent,
      configInput,
      agent: Agent.ID.make("worker"),
      model: ref("test/a"),
      override: { subagentModels: ["test/c"], force: true },
    })
    const message = await runDenied({
      all,
      parent,
      configInput,
      agent: Agent.ID.make("worker"),
      model: ref("test/c"),
      override: { subagentModels: ["test/c"], force: true },
    })
    expect(message).toContain("models of agent worker")
  })

  test("an override without force can narrow but not widen a definition", async () => {
    const parent = info("ses_parent", {
      subagentPolicy: { agentOverrides: { worker: { models: ["test/a", "test/b"] } } },
    })
    const configInput = { agents: { worker: { models: ["test/a"] } } }
    const all = [parent]
    await run({ all, parent, configInput, agent: Agent.ID.make("worker"), model: ref("test/a") })
    await runDenied({ all, parent, configInput, agent: Agent.ID.make("worker"), model: ref("test/b") })
  })

  test("an override with force replaces the definition's lists", async () => {
    const parent = info("ses_parent", {
      subagentPolicy: { agentOverrides: { worker: { models: ["test/b"], force: true } } },
    })
    const configInput = { agents: { worker: { models: ["test/a"] } } }
    const all = [parent]
    await run({ all, parent, configInput, agent: Agent.ID.make("worker"), model: ref("test/b") })
    await runDenied({ all, parent, configInput, agent: Agent.ID.make("worker"), model: ref("test/a") })
  })

  test("a per-call force override replaces definition lists but cannot force past ancestor policy", async () => {
    const parent = info("ses_parent", { subagentPolicy: { models: ["test/a"] } })
    const configInput = { agents: { worker: { models: ["test/c"] } } }
    const all = [parent]
    // Force clears the definition's list, so the policy-allowed model passes.
    await run({
      all,
      parent,
      configInput,
      agent: Agent.ID.make("worker"),
      model: ref("test/a"),
      override: { force: true },
    })
    // But the ancestor policy is hard: even a forced override naming it cannot widen past it.
    const message = await runDenied({
      all,
      parent,
      configInput,
      agent: Agent.ID.make("worker"),
      model: ref("test/b"),
      override: { force: true, models: ["test/b"] },
    })
    // The ancestor policy (test/a only) intersected with the forced list leaves nothing.
    expect(message).toContain("Allowed models: none")
    expect(message).toContain("session policy")
  })

  test("an override model replaces the definition default in the checked chain", async () => {
    const parent = info("ses_parent", { subagentPolicy: { models: ["test/b"] } })
    const configInput = { agents: { worker: { model: "test/a", models: ["test/a", "test/b"] } } }
    const all = [parent]
    // The agent default (test/a) is outside the policy, so the default chain is denied.
    await runDenied({ all, parent, configInput, agent: Agent.ID.make("worker") })
    // Naming test/b explicitly is the override: it replaces the default outright.
    await run({ all, parent, configInput, agent: Agent.ID.make("worker"), override: { model: ref("test/b") } })
  })

  test("a route-named model passes only when every route target passes", async () => {
    const open = info("ses_open")
    const configInput = {
      experimental: { model_routes: { main: { targets: ["test/a", "test/b"] } } },
    }
    const route = ref("opencode-route/main")
    await run({ all: [open], parent: open, configInput, model: route })
    const restricted = info("ses_restricted", { subagentPolicy: { models: ["test/a"] } })
    const message = await runDenied({ all: [restricted], parent: restricted, configInput, model: route })
    expect(message).toContain("test/b")
    expect(message).toContain("route")
  })

  test("an agent default naming a route is judged by all of the route's targets", async () => {
    const configInput = {
      agents: { routed: { model: "opencode-route/main" } },
      experimental: { model_routes: { main: { targets: ["test/a", "test/c"] } } },
    }
    // Every target allowed and none excluded: the route default passes.
    const open = info("ses_open", {
      subagentPolicy: { models: ["test/*"], excludedModels: ["test/b"] },
    })
    await run({ all: [open], parent: open, configInput, agent: Agent.ID.make("routed") })
    // One target excluded: the same default fails, naming that target.
    const excluding = info("ses_excluding", {
      subagentPolicy: { models: ["test/*"], excludedModels: ["test/c"] },
    })
    const message = await runDenied({
      all: [excluding],
      parent: excluding,
      configInput,
      agent: Agent.ID.make("routed"),
    })
    expect(message).toContain("test/c")
    expect(message).toContain("route")
    // One target outside the allowed set also fails the route.
    const narrowing = info("ses_narrowing", { subagentPolicy: { models: ["test/a"] } })
    const narrowed = await runDenied({
      all: [narrowing],
      parent: narrowing,
      configInput,
      agent: Agent.ID.make("routed"),
    })
    expect(narrowed).toContain("test/c")
  })

  test("a route target is judged at its defaultVariant when the route is selected bare", async () => {
    const configInput = {
      experimental: { model_routes: { main: { targets: [{ model: "test/a", defaultVariant: "high" }] } } },
    }
    const route = ref("opencode-route/main")
    // The target runs at #high, so excluding #high denies the bare route.
    const excluding = info("ses_excluding", { subagentPolicy: { excludedModels: ["test/a#high"] } })
    const message = await runDenied({ all: [excluding], parent: excluding, configInput, model: route })
    expect(message).toContain("test/a#high")
    expect(message).toContain("route")
    // Excluding some other variant does not deny it.
    const other = info("ses_other", { subagentPolicy: { excludedModels: ["test/a#low"] } })
    await run({ all: [other], parent: other, configInput, model: route })
    // An allowed list naming only the effective variant passes the bare target.
    const allowing = info("ses_allowing", { subagentPolicy: { models: ["test/a#high"] } })
    await run({ all: [allowing], parent: allowing, configInput, model: route })
  })

  test("a route target is judged at the variant its variants remap makes of the requested variant", async () => {
    const configInput = {
      experimental: { model_routes: { main: { targets: [{ model: "test/a", variants: { low: "high" } }] } } },
    }
    // Requesting the route at #low runs the target at #high.
    const excluding = info("ses_excluding", { subagentPolicy: { excludedModels: ["test/a#high"] } })
    const message = await runDenied({
      all: [excluding],
      parent: excluding,
      configInput,
      model: ref("opencode-route/main#low"),
    })
    expect(message).toContain("test/a#high")
    // The same remap satisfies an allowed list naming only #high.
    const allowing = info("ses_allowing", { subagentPolicy: { models: ["test/a#high"] } })
    await run({ all: [allowing], parent: allowing, configInput, model: ref("opencode-route/main#low") })
    // An unremapped requested variant runs as-is and is judged as itself.
    const passthrough = info("ses_passthrough", { subagentPolicy: { excludedModels: ["test/a#max"] } })
    const passed = await runDenied({
      all: [passthrough],
      parent: passthrough,
      configInput,
      model: ref("opencode-route/main#max"),
    })
    expect(passed).toContain("test/a#max")
  })

  test("a provider-route member exclusion denies the route (#1419)", async () => {
    const parent = info("ses_excluding", { subagentPolicy: { excludedModels: ["openai/*"] } })
    const configInput = {
      experimental: {
        model_routes: { main: { targets: ["openai-plan/gpt-6.1-terra"] } },
        provider_routes: { "openai-plan": { providers: ["openai", "openai.alternate"] } },
      },
    }
    const catalogInput = {
      openai: { "gpt-6.1-terra": {} },
      "openai.alternate": { "gpt-6.1-terra": {} },
    }
    const message = await runDenied({
      all: [parent],
      parent,
      configInput,
      catalogInput,
      model: ref("opencode-route/main"),
    })
    expect(message).toContain("openai/gpt-6.1-terra")
  })

  test("a provider-route target passes an allowlist of its concrete members (#1419)", async () => {
    const parent = info("ses_allowing", {
      subagentPolicy: { models: ["openai/*", "openai.alternate/*"] },
    })
    const configInput = {
      experimental: {
        model_routes: { main: { targets: ["openai-plan/gpt-6.1-terra"] } },
        provider_routes: { "openai-plan": { providers: ["openai", "openai.alternate"] } },
      },
    }
    const catalogInput = {
      openai: { "gpt-6.1-terra": {} },
      "openai.alternate": { "gpt-6.1-terra": {} },
    }
    await run({
      all: [parent],
      parent,
      configInput,
      catalogInput,
      model: ref("opencode-route/main"),
    })
  })

  test("a provider route with only excluded members is denied (#1419)", async () => {
    const parent = info("ses_excluding", {
      subagentPolicy: { excludedModels: ["openai/*", "openai.alternate/*"] },
    })
    const configInput = {
      experimental: {
        model_routes: { main: { targets: ["openai-plan/gpt-6.1-terra"] } },
        provider_routes: { "openai-plan": { providers: ["openai", "openai.alternate"] } },
      },
    }
    const catalogInput = {
      openai: { "gpt-6.1-terra": {} },
      "openai.alternate": { "gpt-6.1-terra": {} },
    }
    const message = await runDenied({
      all: [parent],
      parent,
      configInput,
      catalogInput,
      model: ref("opencode-route/main"),
    })
    expect(message).toContain("openai/gpt-6.1-terra")
  })

  test("a provider-route member reachable only via a suffix-backed variant is still judged (#1428)", async () => {
    const parent = info("ses_excluding", { subagentPolicy: { excludedModels: ["proxy/*"] } })
    const configInput = {
      experimental: {
        model_routes: { main: { targets: ["pool/m#high"] } },
        provider_routes: { pool: { providers: ["allowed", "proxy"] } },
      },
    }
    const catalogInput = {
      allowed: { m: { variants: ["high"] } },
      proxy: { m: {}, "m-high": {} },
    }
    const message = await runDenied({
      all: [parent],
      parent,
      configInput,
      catalogInput,
      model: ref("opencode-route/main"),
    })
    expect(message).toContain("proxy/m#high")
  })

  test("a provider route whose id names a configured model route is dropped, not expanded (#1428)", async () => {
    const parent = info("ses_open", { subagentPolicy: { excludedModels: ["bad/*"] } })
    const configInput = {
      experimental: {
        model_routes: {
          main: { targets: ["pool/m", "safe/m"] },
          pool: { targets: ["safe/m"] },
        },
        provider_routes: { pool: { providers: ["bad"] } },
      },
    }
    const catalogInput = { safe: { m: {} }, bad: { m: {} } }
    await run({ all: [parent], parent, configInput, catalogInput, model: ref("opencode-route/main") })
  })

  test("a route named after an Object.prototype member is judged as an unknown route (#831)", async () => {
    const configInput = {
      experimental: { model_routes: { main: { targets: ["test/a"] } } },
    }
    // Before the fix, routes["constructor"] read through the prototype chain
    // and route.targets.flatMap threw a TypeError.
    const open = info("ses_open")
    await run({ all: [open], parent: open, configInput, model: ref("opencode-route/constructor") })
    await run({ all: [open], parent: open, configInput, model: ref("opencode-route/toString") })
  })

  test("a requested variant named after an Object.prototype member runs as-is (#831)", async () => {
    const configInput = {
      experimental: { model_routes: { main: { targets: [{ model: "test/a", variants: { low: "high" } }] } } },
    }
    // Unremapped, so it is judged as itself: excluding #constructor denies it.
    // Before the fix, VariantID.make received the inherited Object constructor.
    const excluding = info("ses_excluding", { subagentPolicy: { excludedModels: ["test/a#constructor"] } })
    const message = await runDenied({
      all: [excluding],
      parent: excluding,
      configInput,
      model: ref("opencode-route/main#constructor"),
    })
    expect(message).toContain("test/a#constructor")
    const open = info("ses_open")
    await run({ all: [open], parent: open, configInput, model: ref("opencode-route/main#constructor") })
  })

  test("a plain route target is judged at the requested variant", async () => {
    const configInput = {
      experimental: { model_routes: { main: { targets: ["test/a"] } } },
    }
    const excluding = info("ses_excluding", { subagentPolicy: { excludedModels: ["test/a#low"] } })
    const message = await runDenied({
      all: [excluding],
      parent: excluding,
      configInput,
      model: ref("opencode-route/main#low"),
    })
    expect(message).toContain("test/a#low")
    await run({ all: [excluding], parent: excluding, configInput, model: ref("opencode-route/main#high") })
  })

  test("a wildcard route target expanding to an excluded model denies (#530a)", async () => {
    const parent = info("ses_parent", { subagentPolicy: { excludedModels: ["test/b"] } })
    const configInput = { experimental: { model_routes: { main: { targets: [{ model: "test/*" }] } } } }
    const catalogInput = { test: { a: {}, b: {} } }
    const message = await runDenied({
      all: [parent],
      parent,
      configInput,
      catalogInput,
      model: ref("opencode-route/main"),
    })
    expect(message).toContain("test/b")
    expect(message).toContain("route")
  })

  test("a door-set route target expanding to an excluded model on a non-excluded door denies (#637)", async () => {
    const parent = info("ses_parent", { subagentPolicy: { excludedModels: ["other/a"] } })
    const configInput = { experimental: { model_routes: { main: { targets: [{ model: "*/a" }] } } } }
    const catalogInput = { test: { a: {} }, other: { a: {} } }
    const message = await runDenied({
      all: [parent],
      parent,
      configInput,
      catalogInput,
      model: ref("opencode-route/main"),
    })
    expect(message).toContain("other/a")
    expect(message).toContain("route")
  })

  test("a door-set route target's exclusions win in governance too (#637)", async () => {
    const parent = info("ses_parent", { subagentPolicy: { excludedModels: ["other/a"] } })
    const configInput = {
      experimental: { model_routes: { main: { targets: [{ model: "*/a", exclude: ["other"] }] } } },
    }
    const catalogInput = { test: { a: {} }, other: { a: {} } }
    await run({ all: [parent], parent, configInput, catalogInput, model: ref("opencode-route/main") })
  })

  test("a door-set route target expanding only to allowed models passes (#637)", async () => {
    const parent = info("ses_parent", { subagentPolicy: { models: ["test/a", "other/a"] } })
    const configInput = { experimental: { model_routes: { main: { targets: [{ model: "*/a" }] } } } }
    const catalogInput = { test: { a: {} }, other: { a: {}, b: {} } }
    await run({ all: [parent], parent, configInput, catalogInput, model: ref("opencode-route/main") })
  })

  test("a door-set target pinned to a variant is judged at its remapped variant (#869)", async () => {
    const configInput = {
      experimental: { model_routes: { main: { targets: [{ model: "*/a#low", variants: { low: "high" } }] } } },
    }
    const catalogInput = { test: { a: { variants: ["high"] } }, other: { a: { variants: ["low", "high"] } } }
    // Both doors run the target at #high: the test door offers only #high, so judging
    // the pinned #low literally would drop that door from the judged set entirely and
    // judge the other door at a variant it never runs.
    const excluding = info("ses_excluding", { subagentPolicy: { excludedModels: ["test/a#high"] } })
    const message = await runDenied({
      all: [excluding],
      parent: excluding,
      configInput,
      catalogInput,
      model: ref("opencode-route/main"),
    })
    expect(message).toContain("test/a#high")
    // An allowed list naming the remapped variant on both doors passes.
    const allowing = info("ses_allowing", { subagentPolicy: { models: ["test/a#high", "other/a#high"] } })
    await run({ all: [allowing], parent: allowing, configInput, catalogInput, model: ref("opencode-route/main") })
  })

  test("a leaf that cannot produce the requested variant is pruned from governance, as in expansion (#869)", async () => {
    const configInput = {
      experimental: { model_routes: { main: { targets: ["test/a", "test/b"] } } },
    }
    const catalogInput = { test: { a: { variants: ["low"] }, b: { variants: ["max"] } } }
    // Requested at #max, test/a offers only #low, so expansion prunes it: excluding
    // the bare test/a must not deny the route through a leaf that never runs.
    const excluding = info("ses_excluding", { subagentPolicy: { excludedModels: ["test/a"] } })
    await run({
      all: [excluding],
      parent: excluding,
      configInput,
      catalogInput,
      model: ref("opencode-route/main#max"),
    })
    // The surviving leaf is judged at the requested variant.
    const surviving = info("ses_surviving", { subagentPolicy: { excludedModels: ["test/b#max"] } })
    const message = await runDenied({
      all: [surviving],
      parent: surviving,
      configInput,
      catalogInput,
      model: ref("opencode-route/main#max"),
    })
    expect(message).toContain("test/b#max")
  })

  test("a wildcard route target expanding only to allowed models passes (#530b)", async () => {
    const parent = info("ses_parent", { subagentPolicy: { models: ["test/a", "test/b"] } })
    const configInput = { experimental: { model_routes: { main: { targets: [{ model: "test/*" }] } } } }
    const catalogInput = { test: { a: {}, b: {} } }
    await run({ all: [parent], parent, configInput, catalogInput, model: ref("opencode-route/main") })
  })

  test("an expired route target is not judged (#530c)", async () => {
    const parent = info("ses_parent", { subagentPolicy: { excludedModels: ["test/b"] } })
    const configInput = {
      experimental: { model_routes: { main: { targets: [{ model: "test/b", until: 1 }, "test/a"] } } },
    }
    const catalogInput = { test: { a: {}, b: {} } }
    await run({ all: [parent], parent, configInput, catalogInput, model: ref("opencode-route/main") })
  })

  test("an expired nested-route target is not judged and a live one is (#580)", async () => {
    const parent = info("ses_parent", { subagentPolicy: { excludedModels: ["test/b"] } })
    const catalogInput = { test: { a: {}, b: {} } }
    const expiredConfig = {
      experimental: {
        model_routes: {
          main: { targets: [{ model: "opencode-route/pool", until: 1 }, "test/a"] },
          pool: { targets: ["test/b"] },
        },
      },
    }
    await run({ all: [parent], parent, configInput: expiredConfig, catalogInput, model: ref("opencode-route/main") })
    const liveConfig = {
      experimental: {
        model_routes: {
          main: { targets: [{ model: "opencode-route/pool", until: Date.now() + 60_000 }, "test/a"] },
          pool: { targets: ["test/b"] },
        },
      },
    }
    const message = await runDenied({
      all: [parent],
      parent,
      configInput: liveConfig,
      catalogInput,
      model: ref("opencode-route/main"),
    })
    expect(message).toContain("test/b")
  })

  test("a disabled route target is not judged (#530d)", async () => {
    const parent = info("ses_parent", { subagentPolicy: { excludedModels: ["test/b"] } })
    const configInput = { experimental: { model_routes: { main: { targets: ["test/a", "test/b"] } } } }
    const catalogInput = { test: { a: {}, b: { enabled: false } } }
    await run({ all: [parent], parent, configInput, catalogInput, model: ref("opencode-route/main") })
  })

  test("a wildcard route target expanding outside the allowed list denies (#530e)", async () => {
    const parent = info("ses_parent", { subagentPolicy: { models: ["test/a"] } })
    const configInput = { experimental: { model_routes: { main: { targets: [{ model: "test/*" }] } } } }
    const catalogInput = { test: { a: {}, c: {} } }
    const message = await runDenied({
      all: [parent],
      parent,
      configInput,
      catalogInput,
      model: ref("opencode-route/main"),
    })
    expect(message).toContain("test/c")
  })

  test("an expanded leaf is judged at a defaultVariant only when it offers it (#530)", async () => {
    const configInput = {
      experimental: { model_routes: { main: { targets: [{ model: "test/*", defaultVariant: "high" }] } } },
    }
    const catalogInput = { test: { a: {}, b: { variants: ["high"] } } }
    // test/a does not offer #high, so it runs bare and excluding #high must not deny it via test/a;
    // test/b does offer #high, so excluding test/a#high alone passes the route.
    const other = info("ses_other", { subagentPolicy: { excludedModels: ["test/a#high"] } })
    await run({ all: [other], parent: other, configInput, catalogInput, model: ref("opencode-route/main") })
    // Excluding the variant test/b actually runs at denies the route, naming test/b.
    const excluding = info("ses_excluding", { subagentPolicy: { excludedModels: ["test/b#high"] } })
    const message = await runDenied({
      all: [excluding],
      parent: excluding,
      configInput,
      catalogInput,
      model: ref("opencode-route/main"),
    })
    expect(message).toContain("test/b#high")
  })

  test("a concrete route target is judged at a defaultVariant only when it offers it (#519)", async () => {
    const configInput = {
      experimental: { model_routes: { main: { targets: [{ model: "test/b", defaultVariant: "high" }] } } },
    }
    const catalogInput = { test: { b: { variants: ["low"] } } }
    // test/b does not offer #high, so it runs bare: excluding #high must not deny it via test/b.
    const other = info("ses_other", { subagentPolicy: { excludedModels: ["test/b#high"] } })
    await run({ all: [other], parent: other, configInput, catalogInput, model: ref("opencode-route/main") })
    // Excluding the bare target it actually runs as denies the route, naming test/b without #high.
    const excluding = info("ses_excluding", { subagentPolicy: { excludedModels: ["test/b"] } })
    const message = await runDenied({
      all: [excluding],
      parent: excluding,
      configInput,
      catalogInput,
      model: ref("opencode-route/main"),
    })
    expect(message).toContain("test/b")
    expect(message).not.toContain("test/b#high")
  })

  test("a concrete route target pinned to a variant it does not offer is dropped, not judged (#519)", async () => {
    const configInput = {
      experimental: { model_routes: { main: { targets: ["test/a", "test/b#high"] } } },
    }
    const catalogInput = { test: { a: {}, b: { variants: ["low"] } } }
    // test/b is pinned to #high, which it does not offer, so expansion drops it:
    // excluding test/b#high must not deny the route via the dropped target.
    const excluding = info("ses_excluding", { subagentPolicy: { excludedModels: ["test/b#high"] } })
    await run({ all: [excluding], parent: excluding, configInput, catalogInput, model: ref("opencode-route/main") })
    // The surviving target is still judged as itself.
    const surviving = info("ses_surviving", { subagentPolicy: { excludedModels: ["test/a"] } })
    const message = await runDenied({
      all: [surviving],
      parent: surviving,
      configInput,
      catalogInput,
      model: ref("opencode-route/main"),
    })
    expect(message).toContain("test/a")
  })

  test("a concrete route target's remap to a variant it does not offer falls back to the requested variant (#519)", async () => {
    const configInput = {
      experimental: { model_routes: { main: { targets: [{ model: "test/b", variants: { low: "high" } }] } } },
    }
    const catalogInput = { test: { b: { variants: ["low"] } } }
    // Requested at #low, the remap to #high cannot run (test/b does not offer it), so the
    // target runs at the requested #low: excluding #high must not deny it.
    const other = info("ses_other", { subagentPolicy: { excludedModels: ["test/b#high"] } })
    await run({ all: [other], parent: other, configInput, catalogInput, model: ref("opencode-route/main#low") })
    // Excluding the variant it actually runs at denies the route, naming test/b#low.
    const excluding = info("ses_excluding", { subagentPolicy: { excludedModels: ["test/b#low"] } })
    const message = await runDenied({
      all: [excluding],
      parent: excluding,
      configInput,
      catalogInput,
      model: ref("opencode-route/main#low"),
    })
    expect(message).toContain("test/b#low")
  })

  test("with no explicit choice the inherited parent model is what gets checked", async () => {
    const parent = info("ses_parent", { model: "test/parent", subagentPolicy: { models: ["test/parent"] } })
    await run({ all: [parent], parent })
    const restricted = info("ses_restricted", {
      model: "test/parent",
      subagentPolicy: { models: ["test/other"] },
    })
    const message = await runDenied({ all: [restricted], parent: restricted })
    expect(message).toContain("test/parent")
  })

  test("an unrestricted launch passes any model", async () => {
    const parent = info("ses_parent")
    await run({ all: [parent], parent, model: ref("anything/at-all") })
  })

  test("a missing ancestor fails instead of silently passing", async () => {
    const child = info("ses_child", { parentID: "ses_gone" })
    const message = await runDenied({ all: [child], parent: child, model: ref("test/a") })
    expect(message).toContain("Parent session not found: ses_gone")
  })
})
