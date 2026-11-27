import { describe, expect } from "bun:test";
import { LanguageModel } from "@opencode/ai/effect";
import { OpenAIChat } from "@opencode/ai/protocols";
import { Agent } from "@opencode/core/agent";
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder";
import { Bus } from "@opencode/core/bus";
import { Database } from "@opencode/core/database/database";
import { FileMutation } from "@opencode/core/file-mutation";
import { FileWrite } from "@opencode/core/file-write";
import { Flag } from "@opencode/core/flag";
import { Formatter } from "@opencode/core/formatter";
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins";
import { InstructionDiscovery } from "@opencode/core/instruction-discovery";
import { Instructions } from "@opencode/core/instructions/index";
import { Location } from "@opencode/core/location";
import { Mcp } from "@opencode/core/mcp/index";
import { Model } from "@opencode/core/model";
import { ModelRoute } from "@opencode/core/model-route";
import { Provider } from "@opencode/core/provider";
import { ReferenceInstructions } from "@opencode/core/reference/instructions";
import { AbsolutePath } from "@opencode/core/schema";
import { Session } from "@opencode/core/session";
import { SessionContext } from "@opencode/core/session/context";
import { InstructionState } from "@opencode/core/session/instruction-state";
import { SessionMessage } from "@opencode/core/session/message";
import { SessionRunnerModel } from "@opencode/core/session/runner/model";
import { SessionMessageTable } from "@opencode/core/session/sql";
import { SkillInstructions } from "@opencode/core/skill/instructions";
import { Money } from "@opencode/schema/money";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { DateTime, Effect, Layer, Schema } from "effect";
import { testEffect } from "./lib/effect";
import { PluginTestLayer } from "./plugin/fixture";
// #2680: a turn that fails after output continues on the route's next member, picked by
// the failed step's fallback with the request size captured when the failed member was
// resolved. SessionContext.load used that member as is, so a member whose per-target
// context ceiling the grown history exceeds received the oversized continuation. These
// tests drive load's chosen path against a route whose first two leaves have small
// ceilings and whose third leaf fits the history.
const routeID = Model.ID.make("continuation-route");
const leafRef = (id) => Model.Ref.make({ providerID: Provider.ID.make("leaf"), id: Model.ID.make(id) });
const definition = (ceilings) => ({
    id: routeID,
    targets: [leafRef("small-a"), leafRef("small-b"), leafRef("large")],
    targetVariants: [],
    health: ModelRoute.policy(),
    targetLimits: ceilings.map((context) => ({ context })),
    nodes: [{ selection: "ordered", weights: [1, 1, 1], children: [{ leaf: 0 }, { leaf: 1 }, { leaf: 2 }] }],
});
const capabilities = { tools: true, input: ["text"], output: ["text"] };
const cost = [
    {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
    },
];
const limit = { context: 100000, output: 1000 };
const member = (id, fallback) => SessionRunnerModel.resolved(LanguageModel.make({ id, provider: "leaf", route: OpenAIChat.route }), {
    capabilities,
    cost,
    limit,
    routing: {
        routeID,
        target: leafRef(id),
        attempts: 1,
        policy: ModelRoute.policy({ firstTokenTimeoutMs: false }),
        fallback,
    },
});
/** The continuation chain the failed step's fallback would hand load: small-a (the
 * chosen member) -> small-b -> large, counting every fallback call. */
const chain = () => {
    const calls = { a: 0, b: 0, c: 0 };
    const large = member("large", () => Effect.sync(() => {
        calls.c++;
        return undefined;
    }));
    const smallB = member("small-b", () => Effect.sync(() => {
        calls.b++;
        return large;
    }));
    const smallA = member("small-a", () => Effect.sync(() => {
        calls.a++;
        return smallB;
    }));
    return { calls, smallA, smallB, large };
};
const emptyInstructions = () => Effect.succeed(Instructions.empty);
const layer = Layer.mergeAll(PluginTestLayer, AppNodeBuilder.build(LayerNode.group([SessionContext.node, FileMutation.node, FileWrite.node, Formatter.node]), [
    Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    Mcp.node.replace(Layer.mock(Mcp.Service, {
        awaitStartup: () => Effect.void,
        instructions: () => Effect.succeed([]),
        tools: () => Effect.succeed([]),
    })),
    InstructionBuiltIns.node.replace(Layer.mock(InstructionBuiltIns.Service, { load: emptyInstructions })),
    InstructionDiscovery.node.replace(Layer.mock(InstructionDiscovery.Service, {
        project: true,
        global: true,
        claude: true,
        load: emptyInstructions,
    })),
    SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, { load: emptyInstructions })),
    ReferenceInstructions.node.replace(Layer.mock(ReferenceInstructions.Service, { load: emptyInstructions })),
])).pipe(Layer.provide(Layer.succeed(Flag.Overrides, undefined)));
const it = testEffect(layer);
/** A session on the route model (openai/gpt-5 carrying the route definition in its
 * settings), selected through the real context service. */
const setup = (ceilings) => Effect.gen(function* () {
    const agents = yield* Agent.Service;
    const providers = yield* Provider.Service;
    const models = yield* Model.Service;
    const sessions = yield* Session.Service;
    const context = yield* SessionContext.Service;
    yield* agents.transform((editor) => editor.update(Agent.defaultID, (agent) => {
        agent.mode = "primary";
    }));
    yield* providers.transform((editor) => editor.update(Provider.ID.make("openai"), (provider) => {
        provider.activation = "enabled";
    }));
    yield* models.transform((editor) => editor.update(Provider.ID.make("openai"), Model.ID.make("gpt-5"), (model) => {
        model.package = Provider.aisdk("@ai-sdk/openai");
        model.settings = { [ModelRoute.SETTING]: definition(ceilings) };
    }));
    const session = yield* sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
        model: Model.Ref.make({ providerID: Provider.ID.make("openai"), id: Model.ID.make("gpt-5") }),
    });
    // The projector initializes a session's instruction state from its created event;
    // this layer does not run it, so initialize the state the way the projector does.
    const db = (yield* Database.Service).db;
    yield* InstructionState.initialize(db, session.id, 0, {});
    const selection = yield* context.select(session.id);
    return { context, selection };
});
/** Seeds a history whose measured size is the anchor's token count (~5,010 tokens):
 * a user message plus a completed assistant message carrying its usage. */
const seedHistory = (sessionID, anchorInputTokens) => Effect.gen(function* () {
    const db = (yield* Database.Service).db;
    const messages = [
        SessionMessage.User.make({
            id: SessionMessage.ID.create(),
            type: "user",
            text: "Continue the work",
            time: { created: DateTime.makeUnsafe(0) },
        }),
        Schema.decodeUnknownSync(SessionMessage.Assistant)({
            id: SessionMessage.ID.create(),
            type: "assistant",
            agent: Agent.defaultID,
            model: { id: "small-a", providerID: "leaf" },
            content: [{ type: "text", text: "Partial answer" }],
            tokens: { input: anchorInputTokens, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, completed: 0 },
        }),
    ];
    yield* db
        .insert(SessionMessageTable)
        .values(messages.map((message, index) => {
        const { id, type, ...data } = Schema.encodeSync(SessionMessage.Info)(message);
        return { id: SessionMessage.ID.make(id), session_id: sessionID, type, seq: index + 1, time_created: 0, data };
    }))
        .run()
        .pipe(Effect.orDie);
    yield* Bus.reserveSequence(db, sessionID, messages.length);
});
describe("SessionContext.load continuation ceilings (#2680)", () => {
    it.effect("walks the fallback chain past members the grown history no longer fits", () => Effect.gen(function* () {
        const { context, selection } = yield* setup([100, 200, 100000]);
        yield* seedHistory(selection.session.id, 5000);
        const { calls, smallA } = chain();
        const loaded = yield* context.load(selection, smallA);
        expect(loaded.model.ref).toEqual(leafRef("large"));
        expect(calls).toEqual({ a: 1, b: 1, c: 0 });
        expect(loaded.messages).toHaveLength(2);
    }));
    it.effect("keeps the chosen member when the active history fits its ceiling", () => Effect.gen(function* () {
        const { context, selection } = yield* setup([100000, 200, 100000]);
        yield* seedHistory(selection.session.id, 5000);
        const { calls, smallA } = chain();
        const loaded = yield* context.load(selection, smallA);
        expect(loaded.model.ref).toEqual(leafRef("small-a"));
        expect(calls).toEqual({ a: 0, b: 0, c: 0 });
    }));
    it.effect("keeps the chosen member when the history size is unknown", () => Effect.gen(function* () {
        const { context, selection } = yield* setup([100, 200, 100000]);
        const { calls, smallA } = chain();
        const loaded = yield* context.load(selection, smallA);
        expect(loaded.model.ref).toEqual(leafRef("small-a"));
        expect(calls).toEqual({ a: 0, b: 0, c: 0 });
    }));
    it.effect("keeps the chosen member when no later member fits, so compaction gets its chance", () => Effect.gen(function* () {
        const { context, selection } = yield* setup([100, 200, 300]);
        yield* seedHistory(selection.session.id, 5000);
        const { calls, smallA } = chain();
        const loaded = yield* context.load(selection, smallA);
        expect(loaded.model.ref).toEqual(leafRef("small-a"));
        expect(calls).toEqual({ a: 1, b: 1, c: 1 });
    }));
});
