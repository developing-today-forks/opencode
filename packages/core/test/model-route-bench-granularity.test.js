import { afterEach, describe, expect, test } from "bun:test";
import { ModelRoute } from "@opencode/core/model-route";
/**
 * Bench granularity seeded by failure class (code#10367 design point 2).
 *
 * The design's seed map, as settled by Drew's same-day amendment of the #9950
 * bench design (2026-11-14, recorded in model-route-ratelimit-bench.test.ts)
 * and the 2026-11-16 refinements (#10128 plan walls, #2555):
 *
 * - Quota failures bench at MODEL granularity immediately — pool scope, every
 *   effort of the model, from the first failure. This file's first test is
 *   #10367 acceptance criterion 2's quota half, which no earlier suite pinned
 *   at a named sibling effort.
 * - Permanent plan/tier refusals (account-level) bench at model granularity
 *   too — the plan-wall class, pinned in model-route-plan-wall.test.ts.
 * - Request-shape (400-class), timeout, and 5xx failures — the ordinary class,
 *   no quota/auth/plan-wall flag — bench at EFFORT granularity: one effort's
 *   failure never holds the model's other efforts out of later calls. The
 *   second test pins that half across calls (criterion 1 covered the same
 *   split within one call's walk).
 * - Plain auth benches at effort granularity under the amendment (the Luna
 *   evidence: one effort's auth failures are not its siblings'), dead for
 *   last-resort dealing at the benched effort per #2555 — pinned in
 *   model-route-ratelimit-bench.test.ts and model-route-auth-bench-lastresort.test.ts.
 * - No-route is a resolution-time verdict, not an attempt failure: it plants
 *   no bench in any scope, so there is nothing to seed.
 */
describe("bench granularity seeded by failure class (code#10367 point 2)", () => {
    const policy = ModelRoute.policy({ cooldownMs: 60000, quotaCooldownMs: 900000 });
    afterEach(() => {
        ModelRoute.resetHealth();
        ModelRoute.resetSelection();
        ModelRoute.setAdjustments([]);
    });
    test("criterion 2: a quota failure benches all efforts of the model immediately", () => {
        const now = 7000000000;
        const target = ModelRoute.ref({ providerID: "quota-door", model: "drained-model" });
        const sibling = ModelRoute.ref({ providerID: "quota-door", model: "other-model" });
        ModelRoute.failed(target, policy, now, { quota: true });
        // Pool scope: the bench reads at every effort of the model, named or not,
        // from the first failure — no escalation is owed first.
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 900000);
        expect(ModelRoute.cooldownUntil(target, now, undefined, "xhigh")).toBe(now + 900000);
        expect(ModelRoute.cooldownUntil(target, now, undefined, "high")).toBe(now + 900000);
        expect(ModelRoute.cooldownUntil(target, now, undefined, "medium")).toBe(now + 900000);
        // The bench names the model, not an effort, and not the sibling model.
        const bench = ModelRoute.activeBenches(now).find((item) => item.providerID === target.providerID);
        expect(bench?.reason).toBe("quota");
        expect(bench?.variant).toBeUndefined();
        expect(ModelRoute.cooldownUntil(sibling, now)).toBe(0);
    });
    test("an ordinary (request-shape / timeout / 5xx class) failure benches only the effort that errored, across calls", () => {
        const now = 7100000000;
        const target = ModelRoute.ref({ providerID: "shape-door", model: "picky-model" });
        // The ordinary class: no quota, auth, or plan-wall flag — a door rejecting
        // one effort's request shape, a long-generation timeout, a 5xx.
        ModelRoute.failed(target, policy, now, {}, undefined, undefined, undefined, "xhigh");
        expect(ModelRoute.cooldownUntil(target, now, undefined, "xhigh")).toBe(now + 60000);
        // A later call at another effort is not held out by the xhigh bench.
        expect(ModelRoute.cooldownUntil(target, now + 1, undefined, "high")).toBe(0);
        expect(ModelRoute.cooldownUntil(target, now + 1, undefined, "medium")).toBe(0);
        expect(ModelRoute.coolingDown(target, now + 1, undefined, "high")).toBe(false);
        // The bench that stands is the effort's own traffic bench, never widened.
        const bench = ModelRoute.activeBenches(now).find((item) => item.providerID === target.providerID);
        expect(bench?.reason).toBe("failure");
        expect(bench?.variant).toBe("xhigh");
    });
});
