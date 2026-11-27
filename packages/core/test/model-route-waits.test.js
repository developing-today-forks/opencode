import { describe, expect, test } from "bun:test";
import FastCheck from "fast-check";
import { createRouteModel, firstTokenTimeout } from "@opencode/core/config/plugin/model-routes";
import { Model } from "@opencode/core/model";
import { ModelRoute } from "@opencode/core/model-route";
import { Provider } from "@opencode/core/provider";
// How long a pool waits for a model's first output (health.firstTokenTimeoutMs, nestedTimeout).
// Oracles: the rules stated on ConfigModelRoutes.Route.nestedTimeout and Health.firstTokenTimeoutMs,
// checked as invariants that relate a pool's wait to the waits of the pools it nests.
const openai = Provider.ID.make("openai");
const catalog = new Map(["a", "b", "c", "d", "mini"].map((id) => [id, Model.Info.default(openai, Model.ID.make(id))]));
const editor = {
    provider: {
        list: () => [{ provider: Provider.Info.empty(openai), models: catalog }],
        get: () => undefined,
    },
    ids: () => [...catalog.keys()].map((id) => Model.ID.make(id)),
    get: (_providerID, modelID) => catalog.get(String(modelID)),
};
const pool = (spec) => ({
    ...(spec.targets
        ? {
            targets: spec.targets.map((target) => {
                const [providerID, model] = target.split("/");
                return { providerID, model };
            }),
        }
        : {}),
    ...(spec.include ? { include: spec.include } : {}),
    ...(spec.wait === undefined ? {} : { health: { firstTokenTimeoutMs: spec.wait } }),
    ...(spec.nestedTimeout ? { nestedTimeout: spec.nestedTimeout } : {}),
});
const routesOf = (specs) => new Map(Object.entries(specs).map(([id, spec]) => [id, pool(spec)]));
const definition = (id, routes) => {
    const built = createRouteModel(id, routes, editor);
    const result = built ? ModelRoute.definition(built) : undefined;
    if (!result)
        throw new Error(`pool ${id} must build`);
    return result;
};
const rank = (wait) => (wait === false ? Number.POSITIVE_INFINITY : wait);
describe("first-output wait of a pool", () => {
    test("a pool that names no wait and nests no pool waits the 30-second default", () => {
        const routes = routesOf({ p: { targets: ["openai/a"] } });
        expect(firstTokenTimeout("p", routes)).toBe(30000);
        expect(definition("p", routes).health.firstTokenTimeoutMs).toBe(30000);
    });
    test("a pool of pools waits as long as the slowest pool inside it, or the fastest when told shortest", () => {
        const base = {
            slow: { targets: ["openai/a"], wait: 120000 },
            fast: { targets: ["openai/b"], wait: 5000 },
        };
        const top = { targets: ["opencode-route/slow", "opencode-route/fast"] };
        expect(definition("top", routesOf({ ...base, top })).health.firstTokenTimeoutMs).toBe(120000);
        expect(firstTokenTimeout("top", routesOf({ ...base, top: { ...top, nestedTimeout: "shortest" } }))).toBe(5000);
        // A wait of its own without nestedTimeout is kept as written.
        expect(firstTokenTimeout("top", routesOf({ ...base, top: { ...top, wait: 7000 } }))).toBe(7000);
        // With nestedTimeout the derived wait replaces a stale written one, so a nested change reaches it.
        expect(firstTokenTimeout("top", routesOf({ ...base, top: { ...top, wait: 7000, nestedTimeout: "longest" } }))).toBe(120000);
        // No limit is the longest wait of all, and shortest passes over it.
        const open = { ...base, slow: { targets: ["openai/a"], wait: false } };
        expect(firstTokenTimeout("top", routesOf({ ...open, top }))).toBe(false);
        expect(firstTokenTimeout("top", routesOf({ ...open, top: { ...top, nestedTimeout: "shortest" } }))).toBe(5000);
    });
    test("a pool named in include counts as nested; one only excluded does not", () => {
        const routes = routesOf({
            slow: { targets: ["openai/a"], wait: 90000 },
            byname: { include: ["slow"] },
            prefixed: { include: ["opencode-route/SLOW"] },
        });
        expect(firstTokenTimeout("byname", routes)).toBe(90000);
        expect(firstTokenTimeout("prefixed", routes)).toBe(90000);
        const excluding = new Map([
            ...routes,
            ["other", { ...pool({ targets: ["openai/b"] }), exclude: ["slow"] }],
        ]);
        expect(firstTokenTimeout("other", excluding)).toBe(30000);
    });
    test("nestedTimeout own keeps the pool's wait for its own models and each nested pool's for its models", () => {
        const routes = routesOf({
            slow: { targets: ["openai/b"], wait: 120000 },
            quick: { targets: ["openai/c"] },
            top: { targets: ["openai/a", "opencode-route/slow", "opencode-route/quick"], wait: 20000, nestedTimeout: "own" },
        });
        const built = definition("top", routes);
        expect(built.health.firstTokenTimeoutMs).toBe(20000);
        const waits = built.targets.map((_, index) => ModelRoute.targetPolicy(built, index).firstTokenTimeoutMs);
        expect(Object.fromEntries(built.targets.map((target, index) => [String(target.id), waits[index]]))).toEqual({
            a: 20000,
            b: 120000,
            c: 30000,
        });
        // A pool around an own pool waits as long as the slowest model the own pool reaches.
        const outer = new Map([...routes, ["outer", pool({ targets: ["opencode-route/top"] })]]);
        expect(firstTokenTimeout("outer", outer)).toBe(120000);
    });
    test("a pool that applies one wait stores no per-target waits", () => {
        const built = definition("top", routesOf({
            slow: { targets: ["openai/b"], wait: 120000 },
            top: { targets: ["openai/a", "opencode-route/slow"] },
        }));
        expect(built.targetFirstTokenTimeouts).toBeUndefined();
        expect(built.targets.map((_, index) => ModelRoute.targetPolicy(built, index).firstTokenTimeoutMs)).toEqual([
            120000, 120000,
        ]);
    });
    // Pool i may nest only pools after it, so the graph has no cycle and each pool's wait stands on its own.
    const acyclic = FastCheck.integer({ min: 1, max: 8 }).chain((count) => FastCheck.tuple(...Array.from({ length: count }, (_, index) => FastCheck.record({
        wait: FastCheck.option(FastCheck.oneof(FastCheck.integer({ min: 1, max: 3600000 }), FastCheck.constant(false)), {
            nil: undefined,
        }),
        nestedTimeout: FastCheck.option(FastCheck.constantFrom("longest", "shortest"), {
            nil: undefined,
        }),
        nests: FastCheck.subarray(Array.from({ length: count - index - 1 }, (_, offset) => index + offset + 1)),
    }))));
    test("a pool's wait is its own when it names one, else the longest or shortest of the pools it nests (property)", () => {
        FastCheck.assert(FastCheck.property(acyclic, (pools) => {
            const routes = routesOf(Object.fromEntries(pools.map((spec, index) => [
                `p${index}`,
                {
                    targets: ["openai/a", ...spec.nests.map((nested) => `opencode-route/p${nested}`)],
                    ...(spec.wait === undefined ? {} : { wait: spec.wait }),
                    ...(spec.nestedTimeout ? { nestedTimeout: spec.nestedTimeout } : {}),
                },
            ])));
            pools.forEach((spec, index) => {
                const wait = firstTokenTimeout(`p${index}`, routes);
                const nested = spec.nests.map((child) => firstTokenTimeout(`p${child}`, routes));
                if (spec.wait !== undefined && spec.nestedTimeout === undefined)
                    return expect(wait).toBe(spec.wait);
                if (nested.length === 0)
                    return expect(wait).toBe(spec.wait ?? 30000);
                expect(nested).toContain(wait);
                const holds = nested.every((other) => spec.nestedTimeout === "shortest" ? rank(wait) <= rank(other) : rank(wait) >= rank(other));
                expect(holds).toBe(true);
            });
        }), { numRuns: 500 });
    });
    test("any graph of pools, cycles included, gives each pool a wait some pool names or the default (property)", () => {
        const graph = FastCheck.integer({ min: 1, max: 6 }).chain((count) => FastCheck.array(FastCheck.record({
            wait: FastCheck.option(FastCheck.integer({ min: 1, max: 3600000 }), { nil: undefined }),
            nestedTimeout: FastCheck.option(FastCheck.constantFrom("longest", "shortest", "own"), {
                nil: undefined,
            }),
            nests: FastCheck.subarray(Array.from({ length: count }, (_, index) => index)),
        }), { minLength: count, maxLength: count }));
        FastCheck.assert(FastCheck.property(graph, (pools) => {
            const routes = routesOf(Object.fromEntries(pools.map((spec, index) => [
                `p${index}`,
                {
                    targets: ["openai/a", ...spec.nests.map((nested) => `opencode-route/p${nested}`)],
                    ...(spec.wait === undefined ? {} : { wait: spec.wait }),
                    ...(spec.nestedTimeout ? { nestedTimeout: spec.nestedTimeout } : {}),
                },
            ])));
            const named = new Set([30000, ...pools.flatMap((spec) => (spec.wait === undefined ? [] : [spec.wait]))]);
            pools.forEach((_, index) => {
                const wait = firstTokenTimeout(`p${index}`, routes);
                expect(named.has(wait)).toBe(true);
                expect(firstTokenTimeout(`p${index}`, routes)).toBe(wait);
            });
        }), { numRuns: 500 });
    });
});
describe("how long the last target that can take a request may stay silent", () => {
    // Oracle: the rule stated on Config.ModelRoute.Health.lastTargetTimeoutMs — no limit when either
    // wait is off, otherwise the last-target limit (15 minutes unset), never shorter than the first-output wait.
    test("is the last-target limit, never shorter than the first-output wait (property)", () => {
        const wait = FastCheck.oneof(FastCheck.integer({ min: 1, max: 3600000 }), FastCheck.constant(false));
        FastCheck.assert(FastCheck.property(wait, FastCheck.option(wait, { nil: undefined }), (first, last) => {
            const policy = ModelRoute.policy({
                firstTokenTimeoutMs: first,
                ...(last === undefined ? {} : { lastTargetTimeoutMs: last }),
            });
            const limit = last ?? ModelRoute.DEFAULT_LAST_TARGET_TIMEOUT_MS;
            const expected = first === false || limit === false ? false : Math.max(limit, first);
            expect(ModelRoute.lastTargetTimeout(policy)).toBe(expected);
        }), { numRuns: 1000 });
        expect(ModelRoute.lastTargetTimeout(ModelRoute.policy())).toBe(900000);
    });
});
