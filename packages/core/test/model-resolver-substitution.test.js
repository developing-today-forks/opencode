import { afterEach, describe, expect } from "bun:test";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { AISDKNative } from "@opencode/core/aisdk-native";
import { AISDK } from "@opencode/core/aisdk";
import { Integration } from "@opencode/core/integration";
import { ID, Info, Model } from "@opencode/core/model";
import { ModelResolver } from "@opencode/core/model-resolver";
import { ModelRoute } from "@opencode/core/model-route";
import { ModelRouteLog } from "@opencode/core/model-route-log";
import { Provider } from "@opencode/core/provider";
import { createRouteModel } from "@opencode/core/config/plugin/model-routes";
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes";
import { Global } from "@opencode/util/global";
import { Npm } from "@opencode/util/npm";
import { it } from "./lib/effect";
function model(packageName, options = {}) {
    const info = {
        id: ID.make(options.modelID ?? "api-test-model"),
        modelID: ID.make(options.modelID ?? "api-test-model"),
        providerID: options.providerID ?? Provider.ID.make("test-provider"),
        canonical: options.canonical,
        name: "Test model",
        package: packageName,
        settings: options.settings ?? {},
        headers: options.headers ?? { "x-test": "header" },
        body: options.body ?? { custom_extension: { enabled: true } },
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 100, output: 20 },
    };
    AISDKNative.rewrite(info, {
        builtins: Provider.builtinPackages,
        specifier: packageName,
        providerID: info.providerID,
        canonical: info.canonical,
        modelID: info.modelID,
    });
    return Info.make(info);
}
const leaf = (providerID) => model(Provider.aisdk("@ai-sdk/openai"), {
    providerID: Provider.ID.make(providerID),
    modelID: "luna",
    settings: { apiKey: "key" },
});
/** A single-door route model carrying a definition, as config expansion builds it. */
const route = (id, target, routeClass) => {
    const targetRef = ModelRoute.ref({ providerID: target.providerID, model: target.id });
    return Info.make({
        ...model(undefined),
        providerID: ModelRoute.PROVIDER_ID,
        id: ID.make(id),
        settings: {
            [ModelRoute.SETTING]: {
                id,
                targets: [targetRef],
                targetVariants: [{}],
                health: ModelRoute.policy(),
                attempts: 1,
                ...(routeClass ? { class: routeClass } : {}),
                nodes: [{ selection: "ordered", weights: [1], children: [{ leaf: 0 }] }],
            },
        },
    });
};
/** A route over several doors with an explicit node tree, as config expansion builds it. */
const routeTree = (id, targets, nodes, routeClass) => Info.make({
    ...model(undefined),
    providerID: ModelRoute.PROVIDER_ID,
    id: ID.make(id),
    settings: {
        [ModelRoute.SETTING]: {
            id,
            targets: targets.map((item) => ModelRoute.ref({ providerID: item.providerID, model: item.id })),
            targetVariants: targets.map(() => ({})),
            health: ModelRoute.policy(),
            attempts: 1,
            ...(routeClass ? { class: routeClass } : {}),
            nodes,
        },
    },
});
const withResolver = (models, run) => {
    const provider = Provider.Info.make({
        ...Provider.Info.empty(models[0].providerID),
        activation: "enabled",
        package: Provider.aisdk("@ai-sdk/openai"),
        settings: { apiKey: "key" },
    });
    const layer = ModelResolver.layer.pipe(Layer.provide(Layer.mergeAll(Layer.mock(Provider.Service, { get: () => Effect.succeed(provider) }), Layer.mock(Model.Service, {
        get: (providerID, id) => Effect.succeed(models.find((item) => item.providerID === providerID && item.id === id)),
        all: () => Effect.succeed(models),
        default: () => Effect.succeed(models[0]),
        available: () => Effect.succeed(models),
    }), Layer.mock(Integration.Service, {
        revision: () => 0,
        connection: { active: () => Effect.undefined },
    }), Layer.mock(Npm.Service, {}), Layer.mock(AISDK.Service, {}), Layer.succeed(Global.Service, Global.make({})))));
    return Effect.gen(function* () {
        return yield* run(yield* ModelResolver.Service);
    }).pipe(Effect.provide(layer), Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))));
};
const ref = (providerID) => ModelRoute.ref({ providerID, model: "luna" });
/** The runner's accounting for a quota wall that states its reset an hour out. */
const wall = (providerID) => ModelRoute.failed(ref(providerID), ModelRoute.policy(), Date.now(), {
    quota: true,
    quotaResetAtMs: Date.now() + 3600000,
});
const completions = (providerID, count) => {
    for (let index = 0; index < count; index++)
        ModelRoute.completed(ref(providerID), ModelRoute.policy(), {
            firstTokenMs: 100,
            responseMs: 500,
            tokensPerSecond: 30,
        });
};
const decisions = [];
afterEach(() => {
    ModelRouteLog.setSink(undefined);
    decisions.length = 0;
});
const captureDecisions = () => ModelRouteLog.setSink((event) => {
    if (event.kind === "decision")
        decisions.push(event.row);
});
const substitutions = () => decisions.filter((row) => row.reason === "cross-route-substitution");
describe("ModelResolver cross-route substitution (#12228)", () => {
    it.effect("substitutes into a same-class route when the whole route is walled", () => {
        ModelRoute.resetHealth();
        ModelRoute.resetSelection();
        captureDecisions();
        const a = leaf("pa");
        const b = leaf("pb");
        const c = leaf("pc");
        const origin = route("route-a", a, "frontier");
        const same = route("route-b", b, "frontier");
        const other = route("route-c", c, "bulk");
        // The cross-class door has the best measured record in the room: the class
        // gate precedes the measured order, so it must not be entered.
        completions("pc", 4);
        return withResolver([a, b, c, origin, same, other], (resolver) => Effect.gen(function* () {
            const first = yield* resolver.resolveModel(origin, undefined, "s-sub");
            expect(String(first.routing?.target.providerID)).toBe("pa");
            wall("pa");
            const next = yield* first.routing.fallback();
            expect(next?.routing?.routeID).toBe(ID.make("route-b"));
            expect(String(next?.routing?.target.providerID)).toBe("pb");
            // The substitution is on the session's record: which route it left,
            // which it entered, and the class that allowed it.
            expect(substitutions()).toHaveLength(1);
            expect(substitutions()[0].route_id).toBe("route-a");
            expect(substitutions()[0].session_id).toBe("s-sub");
            expect(substitutions()[0].chosen).toBe("route-b");
            expect(substitutions()[0].candidates).toEqual(["route-b"]);
            expect(substitutions()[0].detail).toEqual({ from: "route-a", to: "route-b", class: "frontier" });
        }));
    });
    it.effect("ends without substitution when only cross-class routes are open", () => {
        ModelRoute.resetHealth();
        ModelRoute.resetSelection();
        captureDecisions();
        const a = leaf("pa");
        const c = leaf("pc");
        const origin = route("route-a", a, "frontier");
        const other = route("route-c", c, "bulk");
        return withResolver([a, c, origin, other], (resolver) => Effect.gen(function* () {
            const first = yield* resolver.resolveModel(origin, undefined, "s-cross");
            wall("pa");
            // Nothing same-class is open: the structured ending stands (the
            // runner ends the step for the scheduler to re-launch elsewhere).
            expect(yield* first.routing.fallback()).toBeUndefined();
            expect(substitutions()).toHaveLength(0);
        }));
    });
    it.effect("orders same-class candidates by measured record, ahead of catalog order", () => {
        ModelRoute.resetHealth();
        ModelRoute.resetSelection();
        const a = leaf("pa");
        const b = leaf("pb");
        const d = leaf("pd");
        const origin = route("route-a", a, "frontier");
        const candB = route("route-b", b, "frontier");
        const candD = route("route-d", d, "frontier");
        completions("pb", 4);
        completions("pd", 1);
        // Catalog order puts route-d first; the measured order must overrule it.
        return withResolver([a, d, b, origin, candD, candB], (resolver) => Effect.gen(function* () {
            const first = yield* resolver.resolveModel(origin, undefined, "s-order");
            wall("pa");
            const next = yield* first.routing.fallback();
            expect(next?.routing?.routeID).toBe(ID.make("route-b"));
        }));
    });
    it.effect("the measured order follows the record when the record reverses", () => {
        ModelRoute.resetHealth();
        ModelRoute.resetSelection();
        const a = leaf("pa");
        const b = leaf("pb");
        const d = leaf("pd");
        const origin = route("route-a", a, "frontier");
        const candB = route("route-b", b, "frontier");
        const candD = route("route-d", d, "frontier");
        completions("pb", 1);
        completions("pd", 4);
        return withResolver([a, d, b, origin, candD, candB], (resolver) => Effect.gen(function* () {
            const first = yield* resolver.resolveModel(origin, undefined, "s-order-2");
            wall("pa");
            const next = yield* first.routing.fallback();
            expect(next?.routing?.routeID).toBe(ID.make("route-d"));
        }));
    });
    it.effect("continues past a same-class candidate whose doors are also walled", () => {
        ModelRoute.resetHealth();
        ModelRoute.resetSelection();
        captureDecisions();
        const a = leaf("pa");
        const b = leaf("pb");
        const d = leaf("pd");
        const origin = route("route-a", a, "frontier");
        const candB = route("route-b", b, "frontier");
        const candD = route("route-d", d, "frontier");
        // route-b has the better record but its door is walled too; the walk
        // tries it first (the record says so) and continues to route-d.
        completions("pb", 4);
        wall("pb");
        return withResolver([a, b, d, origin, candB, candD], (resolver) => Effect.gen(function* () {
            const first = yield* resolver.resolveModel(origin, undefined, "s-chain");
            wall("pa");
            const next = yield* first.routing.fallback();
            expect(next?.routing?.routeID).toBe(ID.make("route-d"));
            expect(substitutions()).toHaveLength(1);
            expect(substitutions()[0].candidates).toEqual(["route-b", "route-d"]);
            expect(substitutions()[0].chosen).toBe("route-d");
        }));
    });
    it.effect("the session's own route's class governs when a parent of another class nests it", () => {
        ModelRoute.resetHealth();
        ModelRoute.resetSelection();
        captureDecisions();
        const a = leaf("pa");
        const c = leaf("pc");
        const d = leaf("pd");
        const e = leaf("pe");
        const sub = route("sub", a, "frontier");
        const parent = routeTree("parent", [a, c], [
            { selection: "ordered", weights: [1, 1], children: [{ node: 1 }, { leaf: 1 }] },
            { routeID: "sub", selection: "ordered", weights: [1], children: [{ leaf: 0 }] },
        ], "bulk");
        const sibling = route("sibling", d, "frontier");
        const bulk = route("bulk-route", e, "bulk");
        return withResolver([a, c, d, e, sub, parent, sibling, bulk], (resolver) => Effect.gen(function* () {
            const first = yield* resolver.resolveModel(sub, undefined, "s-anchor");
            expect(String(first.routing?.target.providerID)).toBe("pa");
            wall("pa");
            wall("pc");
            const next = yield* first.routing.fallback();
            // The parent (bulk) could not serve either — its own door is walled —
            // and substitution is judged by the session's own route (frontier):
            // the frontier sibling is entered, never the bulk route the serving
            // parent's class would have named.
            expect(next?.routing?.routeID).toBe(ID.make("sibling"));
            expect(String(next?.routing?.target.providerID)).toBe("pd");
            expect(substitutions()).toHaveLength(1);
            expect(substitutions()[0].route_id).toBe("sub");
            expect(substitutions()[0].detail).toEqual({ from: "sub", to: "sibling", class: "frontier" });
        }));
    });
    it.effect("ACP routes substitute only within ACP", () => {
        ModelRoute.resetHealth();
        ModelRoute.resetSelection();
        const a = leaf("pa");
        const b = leaf("pb");
        const e = leaf("pe");
        const origin = route("route-a", a, "acp");
        const frontier = route("route-b", b, "frontier");
        const acp = route("route-e", e, "acp");
        // The frontier door is proven and the ACP door unmeasured: the class
        // boundary still governs — ACP traffic never fails over out of ACP.
        completions("pb", 4);
        return withResolver([a, b, e, origin, frontier, acp], (resolver) => Effect.gen(function* () {
            const first = yield* resolver.resolveModel(origin, undefined, "s-acp");
            wall("pa");
            const next = yield* first.routing.fallback();
            expect(next?.routing?.routeID).toBe(ID.make("route-e"));
            expect(String(next?.routing?.target.providerID)).toBe("pe");
        }));
    });
    it.effect("a non-ACP route never substitutes into an ACP route", () => {
        ModelRoute.resetHealth();
        ModelRoute.resetSelection();
        const a = leaf("pa");
        const e = leaf("pe");
        const origin = route("route-a", a, "frontier");
        const acp = route("route-e", e, "acp");
        return withResolver([a, e, origin, acp], (resolver) => Effect.gen(function* () {
            const first = yield* resolver.resolveModel(origin, undefined, "s-acp-2");
            wall("pa");
            expect(yield* first.routing.fallback()).toBeUndefined();
        }));
    });
    it.effect("a route with no class does not substitute, and is never substituted into", () => {
        ModelRoute.resetHealth();
        ModelRoute.resetSelection();
        const a = leaf("pa");
        const b = leaf("pb");
        const plainOrigin = route("route-a", a);
        const plainCandidate = route("route-b", b);
        return withResolver([a, b, plainOrigin, plainCandidate], (resolver) => Effect.gen(function* () {
            const first = yield* resolver.resolveModel(plainOrigin, undefined, "s-plain");
            wall("pa");
            expect(yield* first.routing.fallback()).toBeUndefined();
        }));
    });
    it.effect("a classed route never substitutes into a route with no class", () => {
        ModelRoute.resetHealth();
        ModelRoute.resetSelection();
        const a = leaf("pa");
        const b = leaf("pb");
        const origin = route("route-a", a, "frontier");
        const plain = route("route-b", b);
        return withResolver([a, b, origin, plain], (resolver) => Effect.gen(function* () {
            const first = yield* resolver.resolveModel(origin, undefined, "s-plain-2");
            wall("pa");
            expect(yield* first.routing.fallback()).toBeUndefined();
        }));
    });
});
describe("route class plumbing (#12228)", () => {
    it.effect("config decoding carries the class, and the built route model carries it into the definition", () => {
        const decoded = Schema.decodeUnknownSync(ConfigModelRoutes.Route)({
            targets: [{ providerID: "azure", model: "gpt-5-base" }],
            class: "Frontier",
        });
        expect(decoded.class).toBe("Frontier");
        const bare = Schema.decodeUnknownSync(ConfigModelRoutes.Route)({
            targets: [{ providerID: "azure", model: "gpt-5-base" }],
        });
        expect(bare.class).toBeUndefined();
        const azure = Provider.ID.make("azure");
        const catalogModel = Model.Info.default(azure, Model.ID.make("gpt-5-base"));
        const catalog = new Map([[azure, new Map([["gpt-5-base", catalogModel]])]]);
        const editor = {
            provider: {
                list: () => [...catalog].map(([providerID, models]) => ({ provider: Provider.Info.empty(providerID), models })),
                get: () => undefined,
            },
            ids: (providerID) => [...(catalog.get(providerID)?.keys() ?? [])].map((id) => Model.ID.make(id)),
            get: (providerID, modelID) => catalog.get(providerID)?.get(String(modelID)),
        };
        const routes = new Map([
            [
                "r",
                {
                    targets: [{ providerID: "azure", model: "gpt-5-base" }],
                    class: "Frontier",
                },
            ],
        ]);
        const created = createRouteModel("r", routes, editor);
        const definition = created ? ModelRoute.definition(created) : undefined;
        expect(definition?.class).toBe("Frontier");
        // Class names match in any case, as route references do throughout config.
        expect(definition ? ModelRoute.routeClass(definition) : undefined).toBe("frontier");
        return Effect.void;
    });
});
