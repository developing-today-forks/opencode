import { describe, expect } from "bun:test"
import {
  AIError,
  HttpRateLimitDetails,
  InvalidRequestError,
  LanguageModel,
  LLM,
  LLMEvent,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
  TimeoutError,
  UnknownProviderError,
} from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStep } from "@opencode/core/session/runner/step"
import { Model } from "@opencode/core/model"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { Snapshot } from "@opencode/core/snapshot"
import { ToolOutput } from "@opencode/core/tool-output"
import { Money } from "@opencode/schema/money"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteAutonomy } from "@opencode/core/model-route-autonomy"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { asc, eq } from "drizzle-orm"
import { Effect, Exit, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, ToolOutput.node]), [
      Bus.node.replace(Bus.configured({ persist: true })),
    ]),
    TestLLM.testLayer(),
  ),
)

for (const fixture of [
  { finish: "stop", toolChoice: undefined },
  { finish: "content-filter", toolChoice: undefined },
  { finish: "stop", toolChoice: "none" },
] as const) {
  it.effect(`settles ${fixture.finish} with tool choice ${fixture.toolChoice ?? "default"}`, () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const llm = yield* TestLLM.Test
      const sessionID = Session.ID.create()
      const assistantMessageID = SessionMessage.ID.create()
      const start = Snapshot.ID.make("before")
      const end = Snapshot.ID.make("after")
      const files = [RelativePath.make("changed.ts")]
      let captures = 0
      let executions = 0
      const steps = yield* SessionStep.make.pipe(
        Effect.provide(
          Layer.mock(Snapshot.Service)({
            capture: () => Effect.sync(() => (captures++ === 0 ? start : end)),
            files: (input) => {
              expect(input).toEqual({ from: start, to: end })
              return Effect.succeed(files)
            },
          }),
        ),
      )
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, slug: "step", directory: "/project", version: "test" })
        .run()
      const model = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
        {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 100_000, output: 1_000 },
          cost: [
            {
              input: Money.USDPerMillionTokens.make(1),
              output: Money.USDPerMillionTokens.make(2),
              cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
            },
          ],
        },
      )
      yield* llm.push(
        TestLLM.complete(
          {
            reason: { normalized: fixture.finish },
            usage: {
              inputTokens: 15,
              outputTokens: 6,
              nonCachedInputTokens: 10,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 2,
              reasoningTokens: 2,
            },
          },
          LLMEvent.toolCall({ id: "call-test", name: "test", input: {} }),
        ),
      )
      const result = yield* steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID,
          agent: Agent.defaultID,
          model,
          prepared: {
            retry: () => Effect.void,
            request: LLM.request({ model: model.model, prompt: "Run one tool", toolChoice: fixture.toolChoice }),
            options: {},
            executeTool: () =>
              Effect.sync(() => {
                executions++
                return { content: [{ type: "text", text: "Completed tool" }] }
              }),
          },
          retry: (_cause, _error, retry) =>
            Effect.succeed(retry ? { retry: true, attempt: 2, delay: 0 } : { retry: false }),
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(fixture.finish === "stop")
      expect(executions).toBe(fixture.toolChoice === "none" ? 0 : 1)
      if (Exit.isSuccess(result))
        expect(result.value).toEqual(
          SessionStep.Outcome.Completed({ needsContinuation: fixture.toolChoice !== "none" }),
        )
      expect(yield* llm.requests()).toHaveLength(1)
      expect(captures).toBe(2)
      const message = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
      expect(message?.data).toMatchObject({
        finish: fixture.finish,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
        snapshot: { start, end, files },
        content: [{ type: "tool", state: { status: fixture.toolChoice === "none" ? "error" : "completed" } }],
      })
      expect(message?.data).toHaveProperty("cost", expect.closeTo(0.0000233, 10))
      const events = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
      const types = events.map((event) => event.type)
      const terminal = fixture.finish === "stop" ? "session.step.ended.1" : "session.step.failed.1"
      expect(types.filter((type) => type === "session.step.streamed.1")).toHaveLength(1)
      expect(types.filter((type) => type === terminal)).toHaveLength(1)
      expect(types.indexOf("session.step.streamed.1")).toBeLessThan(types.indexOf(terminal))
      expect(
        types.indexOf(fixture.toolChoice === "none" ? "session.tool.failed.2" : "session.tool.success.2"),
      ).toBeLessThan(types.indexOf(terminal))
    }),
  )
}

it.effect("fails over a routed request before any output is committed", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-slow"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    yield* llm.push(
      TestLLM.failAfter(new AIError({ reason: new ProviderInternalError({ message: "primary unavailable" }) })),
    )

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result))
      expect(result.value).toEqual(SessionStep.Outcome.Failover({ model: fallback, error: expect.anything() }))
    expect(fallbackCalls).toBe(1)
    expect(ModelRoute.coolingDown(primary.ref)).toBe(true)
    expect(yield* llm.requests()).toHaveLength(1)
  }),
)

it.live("hedges to the next target when the first stays silent, and the faster answer wins", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    ModelRoute.resetHealth()
    const logged: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => void logged.push(event))
    yield* Effect.addFinalizer(() => Effect.sync(() => ModelRouteLog.setSink(undefined)))
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-slow"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        hedgeAfterMs: 60,
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    yield* llm.push(TestLLM.hangAfter())
    yield* llm.push(TestLLM.text("from the hedge", "t1"))

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        estimatedInputTokens: 1_234,
        prepareFor: (next) =>
          Effect.succeed({
            retry: () => Effect.void,
            request: LLM.request({ model: next.model, prompt: "Check the service" }),
            options: {},
            executeTool: () => Effect.die("not used"),
          }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) expect(result.value._tag).toBe("Completed")
    const requests = yield* llm.requests()
    expect(requests).toHaveLength(2)
    expect(String(requests[1].model.id)).toBe("backup")
    // The slow primary is counted as slow but not cooled by a single miss.
    expect(ModelRoute.coolingDown(primary.ref)).toBe(false)
    expect(fallbackCalls).toBe(1)
    // The cancelled primary still cost a request, charged at the prompt-size estimate.
    expect(ModelRoute.usageOf(primary.ref).day).toEqual({ requests: 1, tokens: 1_234 })
    const attempts = logged.flatMap((event) => (event.kind === "attempt" ? [event.row] : []))
    const lost = attempts.find((row) => row.outcome === "hedged-out")
    expect(lost).toMatchObject({
      provider_id: "openai",
      model_id: "primary",
      tokens_input: 1_234,
      tokens_estimated: true,
    })
    expect(attempts.find((row) => row.outcome === "success")).toMatchObject({
      provider_id: "anthropic",
      model_id: "backup",
      tokens_estimated: false,
    })
    // The race itself is named before either leg answers.
    const starts = logged.flatMap((event) =>
      event.kind === "decision" && event.row.reason === "hedge-started" ? [event.row] : [],
    )
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      selection: "hedge-race",
      candidates: ["openai/primary", "anthropic/backup"],
    })
  }),
)

it.live("does not hedge when the first target answers in time", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    ModelRoute.resetHealth()
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-slow"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        hedgeAfterMs: 60,
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    yield* llm.push(TestLLM.text("from the primary", "t1"))
    yield* llm.push(TestLLM.text("never used", "t2"))

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        prepareFor: (next) =>
          Effect.succeed({
            retry: () => Effect.void,
            request: LLM.request({ model: next.model, prompt: "Check the service" }),
            options: {},
            executeTool: () => Effect.die("not used"),
          }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) expect(result.value._tag).toBe("Completed")
    expect(yield* llm.requests()).toHaveLength(1)
    expect(fallbackCalls).toBe(0)
  }),
)

it.effect("cools a target that reports an exhausted quota for the quota cooldown", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    ModelRoute.resetHealth()
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-slow"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    yield* llm.push(TestLLM.failAfter(new AIError({ reason: new QuotaExceededError({ message: "out of quota" }) })))

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result))
      expect(result.value).toEqual(SessionStep.Outcome.Failover({ model: fallback, error: expect.anything() }))
    expect(fallbackCalls).toBe(1)
    const cooldown = ModelRoute.cooldownUntil(primary.ref) - Date.now()
    expect(cooldown).toBeGreaterThan(840000)
    expect(cooldown).toBeLessThanOrEqual(900000)
    expect(yield* llm.requests()).toHaveLength(1)
  }),
)

it.effect("benches a routed target after repeated non-retryable timeout failures", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    ModelRoute.resetHealth()
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-timeout",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "timeout-model", provider: "timeout-provider", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("timeout-route"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ cooldownMs: 30_000, firstTokenTimeoutMs: false }),
        fallback: () => Effect.succeed(primary),
      },
    })
    const attempt = () =>
      steps.attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) => Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })

    const fail = () =>
      TestLLM.failAfter(
        new AIError({ reason: new TimeoutError({ message: "request deadline elapsed", timeoutMs: 1_000 }) }),
      )
    yield* llm.push(fail())
    yield* attempt().pipe(Effect.exit)
    const first = ModelRoute.cooldownUntil(primary.ref)
    expect(first).toBeGreaterThan(Date.now())

    yield* llm.push(fail())
    yield* attempt().pipe(Effect.exit)
    expect(ModelRoute.cooldownUntil(primary.ref) - first).toBeGreaterThan(25_000)
    ModelRoute.resetHealth()
  }),
)

it.effect("benches a routed target after repeated non-retryable 402 billing failures", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    ModelRoute.resetHealth()
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-billing",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "billing-model", provider: "billing-provider", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("billing-route"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ cooldownMs: 30_000, firstTokenTimeoutMs: false }),
        fallback: () => Effect.succeed(primary),
      },
    })
    const attempt = () =>
      steps.attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) => Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })

    const fail = () =>
      TestLLM.failAfter(
        new AIError({ reason: new UnknownProviderError({ message: "Payment Required (HTTP 402)" }) }),
      )
    yield* llm.push(fail())
    yield* attempt().pipe(Effect.exit)
    const first = ModelRoute.cooldownUntil(primary.ref)
    expect(first).toBeGreaterThan(Date.now())

    yield* llm.push(fail())
    yield* attempt().pipe(Effect.exit)
    expect(ModelRoute.cooldownUntil(primary.ref) - first).toBeGreaterThan(25_000)
    ModelRoute.resetHealth()
  }),
)

it.effect("fails over to the next target when the retry hook declines a route failure", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    ModelRoute.resetHealth()
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-slow"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    yield* llm.push(TestLLM.failAfter(new AIError({ reason: new QuotaExceededError({ message: "out of quota" }) })))

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        // The hook declines another request to the SAME target; that must not veto the route
        // moving on to an eligible candidate (#1014).
        retry: () => Effect.succeed({ retry: false as const }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result))
      expect(result.value).toEqual(SessionStep.Outcome.Failover({ model: fallback, error: expect.anything() }))
    expect(fallbackCalls).toBe(1)
    expect(yield* llm.requests()).toHaveLength(1)
  }),
)

it.effect("switches to the next credential again on a second quota failure in the same message", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    ModelRoute.resetHealth()
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const otherTarget = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let routeFallbackCalls = 0
    const credentialModel = (credentialID: string, next?: ReturnType<typeof SessionRunnerModel.resolved>) =>
      SessionRunnerModel.resolved(primary.model, {
        capabilities,
        cost,
        limit,
        routing: {
          routeID: Model.ID.make("smart-slow"),
          target: primary.ref,
          attempts: 1,
          policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
          credentialID: Credential.ID.make(credentialID),
          ...(next ? { credentialFallback: () => Effect.succeed(next) } : {}),
          fallback: () => {
            routeFallbackCalls++
            return Effect.succeed(otherTarget)
          },
        },
      })
    const modelC = credentialModel("cred-c")
    const modelB = credentialModel("cred-b", modelC)
    const modelA = credentialModel("cred-a", modelB)
    const attempt = (model: ReturnType<typeof SessionRunnerModel.resolved>) =>
      steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID,
          agent: Agent.defaultID,
          model,
          prepared: {
            retry: () => Effect.void,
            request: LLM.request({ model: model.model, prompt: "Check the service" }),
            options: {},
            executeTool: () => Effect.die("not used"),
          },
          retry: (_cause, _error, retry) =>
            Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
        })
        .pipe(Effect.exit)

    yield* llm.push(TestLLM.failAfter(new AIError({ reason: new QuotaExceededError({ message: "out of quota" }) })))
    const first = yield* attempt(modelA)
    expect(Exit.isSuccess(first)).toBe(true)
    if (Exit.isSuccess(first))
      expect(first.value).toEqual(SessionStep.Outcome.Failover({ model: modelB, error: expect.anything() }))

    // A second quota failure on the switched credential, in the same assistant message, tries
    // the next credential on the same provider before any different target (proximity order:
    // credential -> leaf -> sibling plan -> next route, #1014).
    yield* llm.push(TestLLM.failAfter(new AIError({ reason: new QuotaExceededError({ message: "out of quota" }) })))
    const second = yield* attempt(modelB)
    expect(Exit.isSuccess(second)).toBe(true)
    if (Exit.isSuccess(second))
      expect(second.value).toEqual(SessionStep.Outcome.Failover({ model: modelC, error: expect.anything() }))
    expect(routeFallbackCalls).toBe(0)
    expect(yield* llm.requests()).toHaveLength(2)
  }),
)

it.effect("does not fail over within the same message when a quota failure follows partial output", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    ModelRoute.resetHealth()
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-slow"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    yield* llm.push(
      TestLLM.failAfter(
        new AIError({ reason: new QuotaExceededError({ message: "out of quota" }) }),
        LLMEvent.textStart({ id: "answer" }),
        LLMEvent.textDelta({ id: "answer", text: "partial" }),
      ),
    )

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    // Pinned gate (#1014): partial output is already published on this assistant message, so a
    // different model must not append to it via Failover; the post-output cascade is the
    // Continue outcome on a new message when a retry is authorized. The target is still
    // marked failed, so a later re-selection sees it cooling.
    expect(Exit.isSuccess(result) ? result.value._tag : undefined).not.toBe("Failover")
    expect(fallbackCalls).toBe(0)
    expect(ModelRoute.coolingDown(primary.ref)).toBe(true)
    expect(yield* llm.requests()).toHaveLength(1)
  }),
)

it.effect("cools a rate-limited target for exactly what the provider asked", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    ModelRoute.resetHealth()
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-slow"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    yield* llm.push(
      TestLLM.failAfter(new AIError({ reason: new RateLimitError({ message: "slow down", retryAfterMs: 5_000 }) })),
    )

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result))
      expect(result.value).toEqual(SessionStep.Outcome.Failover({ model: fallback, error: expect.anything() }))
    expect(fallbackCalls).toBe(1)
    const cooldown = ModelRoute.cooldownUntil(primary.ref) - Date.now()
    expect(cooldown).toBeGreaterThan(3000)
    expect(cooldown).toBeLessThanOrEqual(5000)
    expect(yield* llm.requests()).toHaveLength(1)
  }),
)

it.effect("holds a rate-limited target until the window the provider reported resets", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    ModelRoute.resetHealth()
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-slow"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    yield* llm.push(
      TestLLM.failAfter(
        new AIError({
          reason: new RateLimitError({
            message: "slow down",
            rateLimit: new HttpRateLimitDetails({
              limit: { requests: "60" },
              remaining: { requests: "0" },
              reset: { requests: "90s" },
            }),
          }),
        }),
      ),
    )

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result))
      expect(result.value).toEqual(SessionStep.Outcome.Failover({ model: fallback, error: expect.anything() }))
    expect(fallbackCalls).toBe(1)
    // The default cooldown is a minute; the provider said the window resets in 90 seconds.
    const held = ModelRoute.limitedUntil(primary.ref) - Date.now()
    expect(held).toBeGreaterThan(80_000)
    expect(held).toBeLessThanOrEqual(90_000)
    expect(ModelRoute.rateLimitOf(primary.ref)?.remaining).toEqual({ requests: "0" })
    expect(yield* llm.requests()).toHaveLength(1)
  }),
)

it.effect("retries the same target before failing over when a route allows more attempts", () =>
  Effect.gen(function* () {
    ModelRoute.resetHealth()
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-slow"),
        target: primary.ref,
        attempts: 2,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    for (let index = 0; index < 2; index++)
      yield* llm.push(
        TestLLM.failAfter(new AIError({ reason: new ProviderInternalError({ message: "primary unavailable" }) })),
      )

    const run = () =>
      steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID,
          agent: Agent.defaultID,
          model,
          prepared: {
            retry: () => Effect.void,
            request: LLM.request({ model: model.model, prompt: "Check the service" }),
            options: {},
            executeTool: () => Effect.die("not used"),
          },
          retry: (_cause, _error, retry) =>
            Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
        })
        .pipe(Effect.exit)

    const first = yield* run()
    expect(Exit.isSuccess(first)).toBe(true)
    if (Exit.isSuccess(first)) expect(first.value._tag).toBe("Retry")
    expect(fallbackCalls).toBe(0)
    expect(ModelRoute.coolingDown(primary.ref)).toBe(false)

    const result = yield* run()
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result))
      expect(result.value).toEqual(SessionStep.Outcome.Failover({ model: fallback, error: expect.anything() }))
    expect(fallbackCalls).toBe(1)
    expect(ModelRoute.coolingDown(primary.ref)).toBe(true)
    expect(yield* llm.requests()).toHaveLength(2)
  }),
)

it.live("fails over when a routed provider misses the first-output deadline", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-timeout",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "slow-primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "fast-backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("cheap-fast"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: 10 }),
        fallback: () => Effect.succeed(fallback),
      },
    })
    yield* llm.push(TestLLM.hangAfter())

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Quick check" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) expect(result.value._tag).toBe("Failover")
    expect(ModelRoute.coolingDown(primary.ref)).toBe(true)
    // The failover completes on the deadline, not on the provider stream: wait for the
    // request to actually be recorded before snapshotting llm.requests() (issue #488).
    yield* llm.wait(1)
    expect(yield* llm.requests()).toHaveLength(1)
  }),
)

it.effect("records the failed attempt that fails over, with the exact error", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    ModelRoute.resetHealth()
    const logged: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => void logged.push(event))
    yield* Effect.addFinalizer(() => Effect.sync(() => ModelRouteLog.setSink(undefined)))
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-slow"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    yield* llm.push(
      TestLLM.failAfter(new AIError({ reason: new ProviderInternalError({ message: "primary unavailable" }) })),
    )

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result))
      expect(result.value).toEqual(SessionStep.Outcome.Failover({ model: fallback, error: expect.anything() }))
    expect(fallbackCalls).toBe(1)
    const attempts = logged.flatMap((event) => (event.kind === "attempt" ? [event.row] : []))
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      route_id: "smart-slow",
      provider_id: "openai",
      model_id: "primary",
      outcome: "failure",
      error_tag: "ProviderInternal",
      error_message: "primary unavailable",
      retryable: true,
      output_started: false,
    })
    expect(yield* llm.requests()).toHaveLength(1)
  }),
)

it.effect("records every failed attempt, including the ones that are retried", () =>
  Effect.gen(function* () {
    ModelRoute.resetHealth()
    const logged: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => void logged.push(event))
    yield* Effect.addFinalizer(() => Effect.sync(() => ModelRouteLog.setSink(undefined)))
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-slow"),
        target: primary.ref,
        attempts: 2,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    for (let index = 0; index < 2; index++)
      yield* llm.push(
        TestLLM.failAfter(new AIError({ reason: new ProviderInternalError({ message: "primary unavailable" }) })),
      )

    const run = () =>
      steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID,
          agent: Agent.defaultID,
          model,
          prepared: {
            retry: () => Effect.void,
            request: LLM.request({ model: model.model, prompt: "Check the service" }),
            options: {},
            executeTool: () => Effect.die("not used"),
          },
          retry: (_cause, _error, retry) =>
            Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
        })
        .pipe(Effect.exit)

    const first = yield* run()
    expect(Exit.isSuccess(first)).toBe(true)
    if (Exit.isSuccess(first)) expect(first.value._tag).toBe("Retry")
    expect(fallbackCalls).toBe(0)
    expect(ModelRoute.coolingDown(primary.ref)).toBe(false)

    const result = yield* run()
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result))
      expect(result.value).toEqual(SessionStep.Outcome.Failover({ model: fallback, error: expect.anything() }))
    expect(fallbackCalls).toBe(1)
    expect(ModelRoute.coolingDown(primary.ref)).toBe(true)
    expect(yield* llm.requests()).toHaveLength(2)
    const attempts = logged.flatMap((event) => (event.kind === "attempt" ? [event.row] : []))
    expect(attempts.map((row) => row.outcome)).toEqual(["failure", "failure"])
    expect(attempts.every((row) => row.error_message === "primary unavailable")).toBe(true)
  }),
)

it.effect("does not fail over after routed output has started", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-partial",
        directory: "/project",
        version: "test",
      })
      .run()

    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary-partial", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup-partial", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-slow"),
        target: primary.ref,
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    yield* llm.push(
      TestLLM.failAfter(
        new AIError({ reason: new ProviderInternalError({ message: "failed after partial output" }) }),
        LLMEvent.textStart({ id: "answer" }),
        LLMEvent.textDelta({ id: "answer", text: "partial" }),
      ),
    )

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) expect(result.value._tag).not.toBe("Failover")
    expect(fallbackCalls).toBe(0)
    expect(ModelRoute.coolingDown(primary.ref)).toBe(true)
    expect(yield* llm.requests()).toHaveLength(1)
  }),
)

it.effect("a rate limit moves the turn to the next target without retrying the same one", () =>
  Effect.gen(function* () {
    ModelRoute.resetHealth()
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()
    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-continuity"),
        target: primary.ref,
        attempts: 2,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(fallback)
        },
      },
    })
    yield* llm.push(
      TestLLM.failAfter(new AIError({ reason: new RateLimitError({ message: "slow down", retryAfterMs: 30_000 }) })),
    )

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID: SessionMessage.ID.create(),
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result))
      expect(result.value).toEqual(SessionStep.Outcome.Failover({ model: fallback, error: expect.anything() }))
    expect(fallbackCalls).toBe(1)
    expect(yield* llm.requests()).toHaveLength(1)
  }),
)

it.effect("a target that has already given up twice recently is not retried", () =>
  Effect.gen(function* () {
    ModelRoute.resetHealth()
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()
    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const policy = ModelRoute.policy({ firstTokenTimeoutMs: false, cooldownMs: 1 })
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    // Two recent give-ups make the primary unsteady: a third transient miss should move the turn, not retry.
    ModelRoute.failed(primary.ref, policy)
    ModelRoute.failed(primary.ref, policy)
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-unsteady"),
        target: primary.ref,
        attempts: 2,
        policy,
        fallback: () => Effect.succeed(fallback),
      },
    })
    yield* llm.push(TestLLM.failAfter(new AIError({ reason: new ProviderInternalError({ message: "blip" }) })))

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID: SessionMessage.ID.create(),
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) expect(result.value._tag).toBe("Failover")
    expect(yield* llm.requests()).toHaveLength(1)
  }),
)

it.live("a session that failed over hedges back to its origin, not the next fallback", () =>
  Effect.gen(function* () {
    ModelRoute.resetHealth()
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()
    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const origin = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const current = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const other = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "third", provider: "google", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    // The session failed over from the origin a moment ago and is now answered by the backup.
    ModelRoute.moved("smart-home", sessionID, origin.ref)
    let fallbackCalls = 0
    const model = SessionRunnerModel.resolved(current.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-home"),
        target: current.ref,
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        hedgeAfterMs: 60,
        origin: () => Effect.succeed(origin),
        fallback: () => {
          fallbackCalls++
          return Effect.succeed(other)
        },
      },
    })
    yield* llm.push(TestLLM.hangAfter())
    yield* llm.push(TestLLM.text("back home", "t1"))

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID: SessionMessage.ID.create(),
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        estimatedInputTokens: 1,
        prepareFor: (next) =>
          Effect.succeed({
            retry: () => Effect.void,
            request: LLM.request({ model: next.model, prompt: "Check the service" }),
            options: {},
            executeTool: () => Effect.die("not used"),
          }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) expect(result.value._tag).toBe("Completed")
    const requests = yield* llm.requests()
    expect(requests).toHaveLength(2)
    expect(String(requests[1].model.id)).toBe("primary")
    expect(fallbackCalls).toBe(0)
    expect(ModelRoute.continuityOf("smart-home", sessionID)).toMatchObject({ current: "openai/primary" })
  }),
)

describe("escalation follows the route's autonomy", () => {
  for (const autonomy of [undefined, ...ModelRouteAutonomy.LEVELS]) {
    const races = ModelRouteAutonomy.races(autonomy)
    it.live(
      `a route at ${autonomy ?? "no level"} ${races ? "races" : "does not race"} its next target after two give-ups`,
      () =>
        Effect.gen(function* () {
          ModelRoute.resetHealth()
          const db = (yield* Database.Service).db
          const llm = yield* TestLLM.Test
          const logged: ModelRouteLog.Event[] = []
          ModelRouteLog.setSink((event) => void logged.push(event))
          yield* Effect.addFinalizer(() => Effect.sync(() => ModelRouteLog.setSink(undefined)))
          const sessionID = Session.ID.create()
          const steps = yield* SessionStep.make.pipe(
            Effect.provide(
              Layer.mock(Snapshot.Service)({
                capture: () => Effect.succeed(undefined),
                files: () => Effect.succeed([]),
              }),
            ),
          )
          yield* db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
            .run()
          yield* db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: Project.ID.global,
              slug: `route-level-${autonomy ?? "unset"}`,
              directory: "/project",
              version: "test",
            })
            .run()
          const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
          const cost = [
            {
              input: Money.USDPerMillionTokens.make(1),
              output: Money.USDPerMillionTokens.make(2),
              cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
            },
          ]
          const limit = { context: 100_000, output: 1_000 }
          const primary = SessionRunnerModel.resolved(
            LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
            { capabilities, cost, limit },
          )
          const fallback = SessionRunnerModel.resolved(
            LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
            { capabilities, cost, limit },
          )
          // A first-output deadline makes the silent primary give up, so failover and the race both show.
          const policy = ModelRoute.policy({ firstTokenTimeoutMs: 50 })
          ModelRoute.failed(primary.ref, policy)
          ModelRoute.failed(primary.ref, policy)
          const model = SessionRunnerModel.resolved(primary.model, {
            capabilities,
            cost,
            limit,
            routing: {
              routeID: Model.ID.make("leveled"),
              target: primary.ref,
              attempts: 1,
              policy,
              autonomy,
              fallback: () => Effect.succeed(fallback),
            },
          })
          yield* llm.push(TestLLM.hangAfter())
          yield* llm.push(TestLLM.text("from the fallback", "t1"))

          const result = yield* steps
            .attempt({
              isLocationClosed: () => false,
              sessionID,
              assistantMessageID: SessionMessage.ID.create(),
              agent: Agent.defaultID,
              model,
              prepared: {
                retry: () => Effect.void,
                request: LLM.request({ model: model.model, prompt: "Check the service" }),
                options: {},
                executeTool: () => Effect.die("not used"),
              },
              retry: (_cause, _error, retry) =>
                Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
              estimatedInputTokens: 1,
              prepareFor: (next) =>
                Effect.succeed({
                  retry: () => Effect.void,
                  request: LLM.request({ model: next.model, prompt: "Check the service" }),
                  options: {},
                  executeTool: () => Effect.die("not used"),
                }),
              recoverContinuation: true,
              recoverOverflow: Effect.succeed(false),
            })
            .pipe(Effect.exit)

          // A racing route answers from the next target at once; one that only fails over hands the turn back.
          expect(Exit.isSuccess(result) ? result.value._tag : undefined).toBe(races ? "Completed" : "Failover")
          // The non-racing branch ends on the first-output deadline, which does not wait
          // for the provider stream fiber that records the request (issue #488 audit).
          yield* llm.wait(races ? 2 : 1)
          expect(yield* llm.requests()).toHaveLength(races ? 2 : 1)
          const starts = logged.filter((event) => event.kind === "decision" && event.row.reason === "hedge-started")
          expect(starts).toHaveLength(races ? 1 : 0)
        }),
    )
  }
})

it.live("an escalated route races its next target at once, without a configured hedge delay", () =>
  Effect.gen(function* () {
    ModelRoute.resetHealth()
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({
          capture: () => Effect.succeed(undefined),
          files: () => Effect.succeed([]),
        }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "route-step",
        directory: "/project",
        version: "test",
      })
      .run()
    const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
    const cost = [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ]
    const limit = { context: 100_000, output: 1_000 }
    const primary = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const fallback = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "backup", provider: "anthropic", route: OpenAIChat.route }),
      { capabilities, cost, limit },
    )
    const policy = ModelRoute.policy({ firstTokenTimeoutMs: false })
    ModelRoute.failed(primary.ref, policy)
    ModelRoute.failed(primary.ref, policy)
    const model = SessionRunnerModel.resolved(primary.model, {
      capabilities,
      cost,
      limit,
      routing: {
        routeID: Model.ID.make("smart-escalate"),
        target: primary.ref,
        attempts: 1,
        policy,
        // No hedgeAfterMs: only the escalation can start the second request.
        fallback: () => Effect.succeed(fallback),
      },
    })
    yield* llm.push(TestLLM.hangAfter())
    yield* llm.push(TestLLM.text("from the escalation", "t1"))

    const result = yield* steps
      .attempt({
        isLocationClosed: () => false,
        sessionID,
        assistantMessageID: SessionMessage.ID.create(),
        agent: Agent.defaultID,
        model,
        prepared: {
          retry: () => Effect.void,
          request: LLM.request({ model: model.model, prompt: "Check the service" }),
          options: {},
          executeTool: () => Effect.die("not used"),
        },
        retry: (_cause, _error, retry) =>
          Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
        estimatedInputTokens: 1,
        prepareFor: (next) =>
          Effect.succeed({
            retry: () => Effect.void,
            request: LLM.request({ model: next.model, prompt: "Check the service" }),
            options: {},
            executeTool: () => Effect.die("not used"),
          }),
        recoverContinuation: true,
        recoverOverflow: Effect.succeed(false),
      })
      .pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) expect(result.value._tag).toBe("Completed")
    const requests = yield* llm.requests()
    expect(requests).toHaveLength(2)
    expect(String(requests[1].model.id)).toBe("backup")
  }),
)

describe("the route log and pool health time the model's response, not the step after it", () => {
  // Real time, because the step reads performance.now(): TestClock cannot make a tool run long or a stream
  // slow. WAIT_MS is how long the tool, the pause in the stream or the compaction takes. A slow stream must
  // be slow by both thresholds, so they sit below WAIT_MS. Nothing asserts how fast a fast reply is: those
  // tests compare the response with the step's own span, so a loaded runner cannot fail them.
  const WAIT_MS = 300
  const MAX_RESPONSE_MS = 200
  const OUTPUT_TOKENS = 1_000
  // 1,000 output tokens over 300ms or more is at most 3,333 tokens per second.
  const MIN_TOKENS_PER_SECOND = 5_000
  // `slow` is what pool health makes of the attempt the route log recorded, by that one threshold.
  const thresholds = [
    {
      name: "maxResponseTimeMs",
      health: { maxResponseTimeMs: MAX_RESPONSE_MS },
      slow: (attempt: ModelRouteLog.Attempt) => (attempt.response_ms ?? Number.NaN) > MAX_RESPONSE_MS,
    },
    {
      name: "minOutputTokensPerSecond",
      health: { minOutputTokensPerSecond: MIN_TOKENS_PER_SECOND },
      slow: (attempt: ModelRouteLog.Attempt) => (attempt.tokens_per_second ?? Number.NaN) < MIN_TOKENS_PER_SECOND,
    },
  ] as const

  /** Runs one routed step whose first slow sample cools its target, and returns the attempt it recorded. */
  const timedStep = (input: {
    readonly health: { readonly maxResponseTimeMs?: number; readonly minOutputTokensPerSecond?: number }
    readonly response: TestLLM.Response
    /** What the step's tool call does before it returns. */
    readonly tool?: Effect.Effect<void>
    readonly recoverOverflow?: Effect.Effect<boolean>
  }) =>
    Effect.gen(function* () {
      ModelRoute.resetHealth()
      const db = (yield* Database.Service).db
      const llm = yield* TestLLM.Test
      const logged: ModelRouteLog.Event[] = []
      ModelRouteLog.setSink((event) => void logged.push(event))
      yield* Effect.addFinalizer(() => Effect.sync(() => ModelRouteLog.setSink(undefined)))
      const sessionID = Session.ID.create()
      const steps = yield* SessionStep.make.pipe(
        Effect.provide(
          Layer.mock(Snapshot.Service)({
            capture: () => Effect.succeed(undefined),
            files: () => Effect.succeed([]),
          }),
        ),
      )
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "route-timing",
          directory: "/project",
          version: "test",
        })
        .run()
      const capabilities = { tools: true, input: ["text"], output: ["text"] } as const
      const cost = [
        {
          input: Money.USDPerMillionTokens.make(1),
          output: Money.USDPerMillionTokens.make(2),
          cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
        },
      ]
      const limit = { context: 100_000, output: 1_000 }
      const primary = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "primary", provider: "openai", route: OpenAIChat.route }),
        { capabilities, cost, limit },
      )
      const model = SessionRunnerModel.resolved(primary.model, {
        capabilities,
        cost,
        limit,
        routing: {
          routeID: Model.ID.make("timed"),
          target: primary.ref,
          attempts: 1,
          policy: ModelRoute.policy({ firstTokenTimeoutMs: false, sampleWindow: 1, slowThreshold: 1, ...input.health }),
          fallback: () => Effect.succeed(undefined),
        },
      })
      yield* llm.push(input.response)

      const result = yield* steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID: SessionMessage.ID.create(),
          agent: Agent.defaultID,
          model,
          prepared: {
            retry: () => Effect.void,
            request: LLM.request({ model: model.model, prompt: "Build the project" }),
            options: {},
            executeTool: () =>
              (input.tool ?? Effect.die("not used")).pipe(
                Effect.as({ content: [{ type: "text" as const, text: "Build finished" }] }),
              ),
          },
          retry: (_cause, _error, retry) =>
            Effect.succeed(retry ? { retry: true, attempt: 1, delay: 0 } : { retry: false }),
          recoverContinuation: true,
          recoverOverflow: input.recoverOverflow ?? Effect.succeed(false),
        })
        .pipe(Effect.exit)
      const attempts = logged.flatMap((event) => (event.kind === "attempt" ? [event.row] : []))
      expect(attempts).toHaveLength(1)
      return { result, attempt: attempts[0], target: primary.ref }
    })

  for (const threshold of thresholds) {
    it.live(`a long tool run after a fast reply does not count against the model by ${threshold.name}`, () =>
      Effect.gen(function* () {
        const step = yield* timedStep({
          health: threshold.health,
          response: TestLLM.complete(
            { reason: { normalized: "tool-calls" }, usage: { outputTokens: OUTPUT_TOKENS } },
            LLMEvent.toolCall({ id: "call-build", name: "build", input: {} }),
          ),
          tool: Effect.sleep(WAIT_MS),
        })
        const response = step.attempt.response_ms ?? Number.NaN

        expect(Exit.isSuccess(step.result) ? step.result.value._tag : undefined).toBe("Completed")
        // The step's span still holds the tool run, and the response time ends before most of it. Half the
        // wait leaves room for the part of the tool run that overlaps the end of the stream.
        expect(step.attempt.time_ended - step.attempt.time_started - response).toBeGreaterThanOrEqual(WAIT_MS / 2)
        // Speed is measured over the response, so its output time fits inside the response time.
        expect((OUTPUT_TOKENS * 1_000) / (step.attempt.tokens_per_second ?? Number.NaN)).toBeLessThanOrEqual(
          response + 1,
        )
        // Pool health judged the same measurement the route log recorded.
        expect(ModelRoute.coolingDown(step.target)).toBe(threshold.slow(step.attempt))
      }),
    )

    it.live(`a slow stream is slow by ${threshold.name}`, () =>
      Effect.gen(function* () {
        const reason = { normalized: "stop" } as const
        const step = yield* timedStep({
          health: threshold.health,
          response: Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "t1" }),
            LLMEvent.textDelta({ id: "t1", text: "A slow" }),
          ]).pipe(
            Stream.concat(Stream.fromEffect(Effect.sleep(WAIT_MS)).pipe(Stream.drain)),
            Stream.concat(
              Stream.fromIterable([
                LLMEvent.textDelta({ id: "t1", text: " answer" }),
                LLMEvent.textEnd({ id: "t1" }),
                LLMEvent.stepFinish({ index: 0, reason, usage: { outputTokens: OUTPUT_TOKENS } }),
                LLMEvent.finish({ reason }),
              ]),
            ),
          ),
        })

        expect(Exit.isSuccess(step.result) ? step.result.value._tag : undefined).toBe("Completed")
        expect(ModelRoute.coolingDown(step.target)).toBe(true)
        expect(step.attempt.response_ms).toBeGreaterThanOrEqual(WAIT_MS - 5)
        expect(step.attempt.tokens_per_second).toBeLessThan(MIN_TOKENS_PER_SECOND)
      }),
    )
  }

  it.live("an overflow attempt's response time leaves out the compaction it triggers", () =>
    Effect.gen(function* () {
      const step = yield* timedStep({
        health: thresholds[0].health,
        response: TestLLM.failAfter(
          new AIError({ reason: new InvalidRequestError({ message: "Too long", classification: "context-overflow" }) }),
        ),
        recoverOverflow: Effect.sleep(WAIT_MS).pipe(Effect.as(true)),
      })

      expect(Exit.isSuccess(step.result) ? step.result.value._tag : undefined).toBe("Compacted")
      expect(step.attempt).toMatchObject({ outcome: "failure", error_tag: "ContextOverflow" })
      // The compaction starts after the stream has ended, so all of it lies between the two ends.
      expect(
        step.attempt.time_ended - step.attempt.time_started - (step.attempt.response_ms ?? Number.NaN),
      ).toBeGreaterThanOrEqual(WAIT_MS / 2)
    }),
  )
})
