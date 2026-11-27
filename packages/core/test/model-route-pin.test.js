import { beforeEach, describe, expect, test } from "bun:test";
import FastCheck from "fast-check";
import { ModelRoute } from "@opencode/core/model-route";
const build = (mode, weights, nested) => {
    const targets = weights.map((_, index) => ModelRoute.ref({ providerID: `p${index}`, model: "m" }));
    // Nested: the first two leaves sit in a round-robin group under the root, so a pin inside the
    // group has to lead at both levels of the walk.
    const nodes = nested && weights.length >= 3
        ? [
            {
                selection: mode,
                weights: [1, ...weights.slice(2)],
                children: [{ node: 1 }, ...weights.slice(2).map((_, index) => ({ leaf: index + 2 }))],
            },
            { selection: "round-robin", weights: weights.slice(0, 2), children: [{ leaf: 0 }, { leaf: 1 }] },
        ]
        : [{ selection: mode, weights: [...weights], children: weights.map((_, leaf) => ({ leaf })) }];
    return {
        id: "pool",
        targets,
        targetVariants: targets.map(() => ({})),
        health: ModelRoute.policy(),
        nodes,
    };
};
const walk = (definition, ready, tried, sessionID, draw, preferred) => ModelRoute.nextTarget(definition, ready, tried, sessionID, true, undefined, undefined, () => draw, undefined, undefined, preferred);
beforeEach(() => {
    ModelRoute.resetHealth();
    ModelRoute.resetSelection();
});
describe("a pinned pool member in the selection walk (#2671)", () => {
    test("leads while it can serve, and otherwise leaves the normal choice untouched", () => {
        const leafCount = FastCheck.integer({ min: 1, max: 5 });
        const scenario = leafCount.chain((count) => FastCheck.record({
            mode: FastCheck.constantFrom("ordered", "round-robin", "weighted"),
            weights: FastCheck.array(FastCheck.integer({ min: 1, max: 3 }), { minLength: count, maxLength: count }),
            nested: FastCheck.boolean(),
            ready: FastCheck.subarray([...Array(count).keys()]),
            tried: FastCheck.subarray([...Array(count).keys()]),
            preferred: FastCheck.integer({ min: 0, max: count - 1 }),
            draw: FastCheck.double({ min: 0, max: 0.999, noNaN: true }),
        }));
        let pinnedServed = 0;
        let pinnedIgnored = 0;
        FastCheck.assert(FastCheck.property(scenario, (input) => {
            const definition = build(input.mode, input.weights, input.nested);
            const ready = new Set(input.ready);
            const tried = new Set(input.tried);
            ModelRoute.resetSelection();
            const normal = walk(definition, ready, tried, "s", input.draw);
            ModelRoute.resetSelection();
            const pinned = walk(definition, ready, tried, "s", input.draw, input.preferred);
            const serves = ready.has(input.preferred) && !tried.has(input.preferred);
            if (serves)
                pinnedServed++;
            else
                pinnedIgnored++;
            expect(pinned).toBe(serves ? input.preferred : normal);
        }), { numRuns: 2000 });
        // Positive control: the generator reached both branches of the invariant.
        expect(pinnedServed).toBeGreaterThan(100);
        expect(pinnedIgnored).toBeGreaterThan(100);
    });
    test("a pinned pick spends no draw, so other sessions on the pool select exactly as before", () => {
        FastCheck.assert(FastCheck.property(FastCheck.constantFrom("ordered", "round-robin", "weighted"), FastCheck.array(FastCheck.integer({ min: 1, max: 3 }), { minLength: 2, maxLength: 5 }), FastCheck.nat(), (mode, weights, seed) => {
            const definition = build(mode, weights, false);
            const all = new Set(weights.keys());
            const others = ["a", "b", "c", "d"];
            ModelRoute.resetSelection();
            const alone = others.map((id) => walk(definition, all, new Set(), id, 0.5));
            ModelRoute.resetSelection();
            walk(definition, all, new Set(), "pinned", 0.5, seed % weights.length);
            const beside = others.map((id) => walk(definition, all, new Set(), id, 0.5));
            expect(beside).toEqual(alone);
        }), { numRuns: 300 });
    });
    test("the failover tail after a pinned member keeps the normal order", () => {
        const definition = build("ordered", [3, 2, 1], false);
        const all = new Set([0, 1, 2]);
        const tried = new Set();
        const order = [];
        for (;;) {
            const next = walk(definition, all, tried, "s", 0, 2);
            if (next === undefined)
                break;
            order.push(next);
            tried.add(next);
        }
        expect(order).toEqual([2, 0, 1]);
    });
});
describe("pin storage (#2671)", () => {
    const definition = {
        ...build("ordered", [1, 1, 1], false),
        targets: [
            ModelRoute.ref({ providerID: "a", model: "m" }),
            ModelRoute.ref({ providerID: "b", model: "m", variant: "high" }),
            ModelRoute.ref({ providerID: "b", model: "m", variant: "low" }),
        ],
    };
    test("names the member by provider/model, and by variant when one is given", () => {
        expect(ModelRoute.memberIndex(definition, ModelRoute.ref({ providerID: "a", model: "m" }))).toBe(0);
        expect(ModelRoute.memberIndex(definition, ModelRoute.ref({ providerID: "b", model: "m", variant: "low" }))).toBe(2);
        expect(ModelRoute.memberIndex(definition, ModelRoute.ref({ providerID: "b", model: "m" }))).toBe(1);
        expect(ModelRoute.memberIndex(definition, ModelRoute.ref({ providerID: "a", model: "m", variant: "high" }))).toBeUndefined();
        expect(ModelRoute.memberIndex(definition, ModelRoute.ref({ providerID: "z", model: "m" }))).toBeUndefined();
    });
    test("is per session and per route, and clearing removes it", () => {
        const low = ModelRoute.ref({ providerID: "b", model: "m", variant: "low" });
        ModelRoute.pinTarget("pool", "s1", low);
        ModelRoute.pinTarget("other", "s1", low);
        expect(ModelRoute.pinnedLeaf(definition, "s1")).toBe(2);
        expect(ModelRoute.pinnedLeaf(definition, "s2")).toBeUndefined();
        expect(ModelRoute.pinnedTargets("s1").map((item) => item.routeID)).toEqual(["pool", "other"]);
        ModelRoute.pinTarget("pool", "s1", undefined);
        expect(ModelRoute.pinnedLeaf(definition, "s1")).toBeUndefined();
        expect(ModelRoute.pinnedTargets("s1").map((item) => item.routeID)).toEqual(["other"]);
        ModelRoute.forgetPins("s1");
        expect(ModelRoute.pinnedTargets("s1")).toEqual([]);
    });
    test("a pin that names a member no longer in the pool resolves to nothing", () => {
        ModelRoute.pinTarget("pool", "s", ModelRoute.ref({ providerID: "gone", model: "m" }));
        expect(ModelRoute.pinnedLeaf(definition, "s")).toBeUndefined();
    });
});
