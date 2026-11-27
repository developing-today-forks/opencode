import { afterEach, describe, expect, test } from "bun:test";
import { ModelRoute } from "@opencode/core/model-route";
import { ModelRouteLog } from "@opencode/core/model-route-log";
const target = ModelRoute.ref({ providerID: "openai", model: "gpt-6-luna" });
afterEach(() => {
    ModelRoute.resetHealth();
    ModelRoute.resetSelection();
    ModelRoute.setAdjustments([]);
});
describe("ModelRoute health", () => {
    test("starts with bounded first-token and rolling-window defaults", () => {
        expect(ModelRoute.policy()).toMatchObject({
            firstTokenTimeoutMs: 30000,
            sampleWindow: 5,
            slowThreshold: 3,
            cooldownMs: 60000,
        });
    });
    test("cools down immediately after a provider failure, then recovers", () => {
        const policy = ModelRoute.policy({ cooldownMs: 2000 });
        ModelRoute.failed(target, policy, 10000);
        expect(ModelRoute.coolingDown(target, 11999)).toBe(true);
        expect(ModelRoute.coolingDown(target, 12000)).toBe(false);
        expect(ModelRoute.cooldownUntil(target, 12000)).toBe(0);
    });
    test("degrades after three slow completions in the rolling five-request window", () => {
        const policy = ModelRoute.policy({
            firstTokenTimeoutMs: false,
            maxResponseTimeMs: 1000,
            sampleWindow: 5,
            slowThreshold: 3,
            cooldownMs: 2000,
        });
        const fast = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 };
        const slow = { firstTokenMs: 100, responseMs: 1001, tokensPerSecond: 30 };
        ModelRoute.completed(target, policy, slow, 1000);
        ModelRoute.completed(target, policy, fast, 2000);
        ModelRoute.completed(target, policy, slow, 3000);
        expect(ModelRoute.coolingDown(target, 3000)).toBe(false);
        ModelRoute.completed(target, policy, slow, 4000);
        expect(ModelRoute.coolingDown(target, 4000)).toBe(true);
        expect(ModelRoute.coolingDown(target, 6000)).toBe(false);
    });
    test("evicts old slow samples as the rolling window advances", () => {
        const policy = ModelRoute.policy({
            firstTokenTimeoutMs: false,
            maxResponseTimeMs: 1000,
            sampleWindow: 3,
            slowThreshold: 3,
            cooldownMs: 2000,
        });
        const slow = { firstTokenMs: 100, responseMs: 2000, tokensPerSecond: 30 };
        const fast = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 };
        ModelRoute.completed(target, policy, slow, 1000);
        ModelRoute.completed(target, policy, slow, 2000);
        ModelRoute.completed(target, policy, fast, 3000);
        ModelRoute.completed(target, policy, fast, 4000);
        expect(ModelRoute.coolingDown(target, 4000)).toBe(false);
    });
});
describe("ModelRoute session selection", () => {
    test("ordered mode always starts at the first candidate and stays sticky", () => {
        expect(ModelRoute.sessionScoped("ordered")).toBe(false);
        expect(ModelRoute.selectSessionTarget("r", "s1", "ordered", [0, 1, 2], [1, 1, 1])).toBe(0);
        expect(ModelRoute.sessionTarget("r", "s1")).toBeUndefined();
    });
    test("round-robin rotates per session and sticks to the drawn target", () => {
        const indexes = [0, 1, 2];
        const first = ModelRoute.selectSessionTarget("rr", "s1", "round-robin", indexes, [1, 1, 1]);
        const second = ModelRoute.selectSessionTarget("rr", "s2", "round-robin", indexes, [1, 1, 1]);
        const third = ModelRoute.selectSessionTarget("rr", "s3", "round-robin", indexes, [1, 1, 1]);
        expect([first, second, third]).toEqual([0, 1, 2]);
        // Sticky while the drawn target is still a candidate.
        expect(ModelRoute.sessionTarget("rr", "s1")).toBe(0);
        expect(ModelRoute.selectSessionTarget("rr", "s1", "round-robin", [0, 2], [1, 1])).toBe(0);
        // If the sticky target left the candidate list (e.g. cooldown), the session re-draws and re-sticks.
        const redrawn = ModelRoute.selectSessionTarget("rr", "s1", "round-robin", [1, 2], [1, 1]);
        expect(redrawn === 1 || redrawn === 2).toBe(true);
        expect(ModelRoute.sessionTarget("rr", "s1")).toBe(redrawn);
    });
    test("weighted selection respects ratios and sticks per session", () => {
        const indexes = [0, 1];
        let first = 0;
        for (let i = 0; i < 200; i++) {
            const drawn = ModelRoute.selectSessionTarget(`w-${i}`, `s${i}`, "weighted", indexes, [3, 1]);
            if (drawn === 0)
                first++;
        }
        // 3:1 ratio over 200 draws; a tolerant band keeps this deterministic enough for CI.
        expect(first).toBeGreaterThan(120);
        expect(first).toBeLessThan(180);
        const sticky = ModelRoute.sessionTarget("w-0", "s0");
        expect(sticky).toBeDefined();
        expect(sticky).toBe(ModelRoute.selectSessionTarget("w-0", "s0", "weighted", indexes, [3, 1]));
    });
    test("forgetSession drops the sticky choice", () => {
        ModelRoute.selectSessionTarget("f", "s1", "round-robin", [0, 1], [1, 1]);
        expect(ModelRoute.sessionTarget("f", "s1")).toBeDefined();
        ModelRoute.forgetSession("f", "s1");
        expect(ModelRoute.sessionTarget("f", "s1")).toBeUndefined();
    });
});
describe("ModelRoute.orderTargets", () => {
    const targets = [0, 1, 2, 3].map((index) => ModelRoute.ref({ providerID: "p", model: `m${index}` }));
    // root: weighted 3:1 between group A (leaves 0,1 round-robin) and leaf 2; leaf 3 is a fallback.
    const definition = {
        id: "tree",
        targets,
        targetVariants: [],
        health: ModelRoute.policy(),
        nodes: [
            {
                selection: "weighted",
                weights: [3, 1, 1],
                children: [{ node: 1 }, { leaf: 2 }, { leaf: 3 }],
            },
            { selection: "round-robin", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
        ],
    };
    const all = new Set([0, 1, 2, 3]);
    test("keeps every leaf and splits within the chosen group", () => {
        const first = ModelRoute.orderTargets(definition, all, "s1", true);
        expect([...first].sort()).toEqual([0, 1, 2, 3]);
        // Group A's leaves stay adjacent: a group is chosen as one unit.
        const groupA = first.filter((index) => index < 2);
        expect(Math.abs(first.indexOf(groupA[0]) - first.indexOf(groupA[1]))).toBe(1);
    });
    test("is sticky per session at every level and drops cooled groups", () => {
        ModelRoute.resetSelection();
        const first = ModelRoute.nextTarget(definition, all, new Set(), "s2", true, undefined, undefined, () => 0);
        expect(first).toBe(0);
        expect(ModelRoute.nextTarget(definition, all, new Set(), "s2", true, undefined, undefined, () => 0.99)).toBe(0);
        const withoutA = ModelRoute.nextTarget(definition, new Set([2, 3]), new Set(), "s2", true, undefined, undefined, () => 0);
        expect(withoutA === 2 || withoutA === 3).toBe(true);
    });
    test("round-robin inside a group rotates across sessions", () => {
        const onlyA = new Set([0, 1]);
        const heads = ["a", "b", "c", "d"].map((id) => ModelRoute.orderTargets(definition, onlyA, id, true)[0]);
        expect(new Set(heads).size).toBe(2);
    });
    test("does not consume a nested round-robin draw until the parent reaches that group", () => {
        ModelRoute.resetSelection();
        const hierarchy = {
            ...definition,
            nodes: [
                {
                    routeID: "outer",
                    selection: "weighted",
                    weights: [99, 1],
                    children: [{ node: 1 }, { leaf: 2 }],
                },
                {
                    routeID: "luna",
                    selection: "round-robin",
                    weights: [1, 1],
                    children: [{ leaf: 0 }, { leaf: 1 }],
                },
            ],
        };
        const ready = new Set([0, 1, 2]);
        // Choose the sibling leaf; the nested route must not spend a turn just because it was inspected.
        expect(ModelRoute.nextTarget(hierarchy, ready, new Set(), "sibling", true, undefined, undefined, () => 0.999)).toBe(2);
        expect(ModelRoute.sessionTarget("luna#1", "sibling")).toBeUndefined();
        // Subsequent sessions that actually enter Luna should get its RR sequence in order.
        expect(ModelRoute.nextTarget(hierarchy, ready, new Set(), "luna-a", true, undefined, undefined, () => 0)).toBe(0);
        expect(ModelRoute.nextTarget(hierarchy, ready, new Set(), "luna-b", true, undefined, undefined, () => 0)).toBe(1);
    });
});
describe("ModelRoute correlation and adjustments", () => {
    const policy = ModelRoute.policy({ cooldownMs: 60000 });
    const model = (providerID, id) => ModelRoute.ref({ providerID, model: id });
    test("demotes a provider once several of its models are cooling, but not other providers", () => {
        ModelRoute.resetHealth();
        ModelRoute.failed(model("azure", "a"), policy, 1000);
        expect(ModelRoute.coolingDown(model("azure", "b"), 1000)).toBe(false);
        ModelRoute.failed(model("azure", "c"), policy, 1000);
        expect(ModelRoute.coolingDown(model("azure", "b"), 1000)).toBe(true);
        expect(ModelRoute.coolingDown(model("openai", "b"), 1000)).toBe(false);
        expect(ModelRoute.coolingDown(model("azure", "b"), 62000)).toBe(false);
    });
    test("does not punish targets when unrelated providers fail together", () => {
        ModelRoute.resetHealth();
        ModelRoute.failed(model("openai", "a"), policy, 1000, { network: true });
        ModelRoute.failed(model("azure", "a"), policy, 2000, { network: true });
        expect(ModelRoute.networkSuspect(2000)).toBe(false);
        ModelRoute.failed(model("anthropic", "a"), policy, 3000, { network: true });
        expect(ModelRoute.networkSuspect(3000)).toBe(true);
        expect(ModelRoute.coolingDown(model("anthropic", "a"), 3000)).toBe(false);
        expect(ModelRoute.coolingDown(model("openai", "a"), 3000)).toBe(false);
        expect(ModelRoute.coolingDown(model("azure", "a"), 3000)).toBe(false);
        expect(ModelRoute.networkSuspect(40000)).toBe(false);
    });
    test("network-suspect undo also forgives the escalation count", () => {
        ModelRoute.resetHealth();
        ModelRoute.failed(model("openai", "a"), policy, 1000, { network: true });
        ModelRoute.failed(model("azure", "a"), policy, 2000, { network: true });
        ModelRoute.failed(model("anthropic", "a"), policy, 3000, { network: true });
        expect(ModelRoute.networkSuspect(3000)).toBe(true);
        expect(ModelRoute.coolingDown(model("openai", "a"), 3000)).toBe(false);
        // After the outage is forgiven, a later single genuine failure benches at the
        // first-offence (1x) length, not doubled by the undone failure (#1034).
        ModelRoute.failed(model("openai", "a"), policy, 40000);
        expect(ModelRoute.cooldownUntil(model("openai", "a"), 40000)).toBe(100000);
        expect(ModelRoute.coolingDown(model("openai", "a"), 99999)).toBe(true);
        expect(ModelRoute.coolingDown(model("openai", "a"), 100000)).toBe(false);
    });
    test("does not classify provider quota failures as a network outage", () => {
        ModelRoute.resetHealth();
        ModelRoute.failed(model("openai", "a"), policy, 1000, { quota: true });
        ModelRoute.failed(model("azure", "a"), policy, 2000, { quota: true });
        ModelRoute.failed(model("anthropic", "a"), policy, 3000, { quota: true });
        expect(ModelRoute.networkSuspect(3000)).toBe(false);
        expect(ModelRoute.coolingDown(model("anthropic", "a"), 3000)).toBe(true);
    });
    test("skip and weight adjustments expire and reorder ordered groups", () => {
        ModelRoute.resetHealth();
        const targets = [model("openai", "gpt-6-luna"), model("anthropic", "claude-opus-5")];
        const definition = {
            id: "adj",
            targets,
            targetVariants: [],
            health: policy,
            nodes: [{ selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
        };
        const now = Date.now();
        expect(ModelRoute.orderTargets(definition, new Set([0, 1]), "s", true)).toEqual([0, 1]);
        ModelRoute.setAdjustments([{ id: "promo", match: "claude", action: "weight", factor: 5, until: now + 60000 }]);
        expect(ModelRoute.orderTargets(definition, new Set([0, 1]), "s", true)).toEqual([1, 0]);
        ModelRoute.setAdjustments([{ id: "promo", match: "claude", action: "weight", factor: 5, until: now - 1 }]);
        expect(ModelRoute.orderTargets(definition, new Set([0, 1]), "s", true)).toEqual([0, 1]);
        ModelRoute.setAdjustments([{ id: "out", match: "openai/", action: "skip", until: now + 60000 }]);
        expect(ModelRoute.skipped(targets[0])).toBe(true);
        expect(ModelRoute.skipped(targets[1])).toBe(false);
    });
});
describe("ModelRoute failure hints", () => {
    const policy = ModelRoute.policy({ cooldownMs: 60000, quotaCooldownMs: 900000 });
    const t = ModelRoute.ref({ providerID: "openai", model: "hint" });
    test("a stated retry-after sets the cooldown, capped at a day", () => {
        ModelRoute.resetHealth();
        ModelRoute.failed(t, policy, 1000, { retryAfterMs: 5000 });
        expect(ModelRoute.cooldownUntil(t, 1000)).toBe(6000);
        ModelRoute.resetHealth();
        ModelRoute.failed(t, policy, 1000, { retryAfterMs: 10 ** 12 });
        expect(ModelRoute.cooldownUntil(t, 1000)).toBe(1000 + 86400000);
    });
    test("an exhausted quota outlasts an ordinary failure", () => {
        ModelRoute.resetHealth();
        ModelRoute.failed(t, policy, 1000, { quota: true });
        expect(ModelRoute.cooldownUntil(t, 1000)).toBe(1000 + 900000);
        ModelRoute.resetHealth();
        ModelRoute.failed(t, policy, 1000);
        expect(ModelRoute.cooldownUntil(t, 1000)).toBe(1000 + 60000);
    });
    test("repeated failures double the bench, and the count survives the bench expiring", () => {
        // Driven with quota failures: their ladder still escalates without the failure
        // cap. An ordinary failure's ladder stops at failureCapMs (#2212), which the
        // machinery-constants tests below pin down.
        ModelRoute.resetHealth();
        ModelRoute.failed(t, policy, 1000, { quota: true });
        expect(ModelRoute.cooldownUntil(t, 1000)).toBe(1000 + 900000);
        ModelRoute.failed(t, policy, 901000, { quota: true });
        expect(ModelRoute.cooldownUntil(t, 901000)).toBe(901000 + 1800000);
        ModelRoute.failed(t, policy, 2701000, { quota: true });
        expect(ModelRoute.cooldownUntil(t, 2701000)).toBe(2701000 + 3600000);
        // Expiry (recover) does not forgive the history: the next failure keeps escalating.
        expect(ModelRoute.cooldownUntil(t, 6301000)).toBe(0);
        ModelRoute.failed(t, policy, 6301000, { quota: true });
        expect(ModelRoute.cooldownUntil(t, 6301000)).toBe(6301000 + 7200000);
    });
    test("a success resets the escalation back to the base bench", () => {
        ModelRoute.resetHealth();
        ModelRoute.failed(t, policy, 1000);
        ModelRoute.failed(t, policy, 61000);
        expect(ModelRoute.cooldownUntil(t, 61000)).toBe(61000 + 120000);
        ModelRoute.completed(t, policy, { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }, 181000);
        ModelRoute.failed(t, policy, 182000);
        expect(ModelRoute.cooldownUntil(t, 182000)).toBe(182000 + 60000);
    });
    test("an auth failure takes the long bench first, then escalates from it", () => {
        ModelRoute.resetHealth();
        ModelRoute.failed(t, policy, 1000, { auth: true });
        expect(ModelRoute.cooldownUntil(t, 1000)).toBe(1000 + 900000);
        ModelRoute.failed(t, policy, 901000, { auth: true });
        expect(ModelRoute.cooldownUntil(t, 901000)).toBe(901000 + 1800000);
    });
    test("three consecutive terminal auth failures gate the whole provider until a live success (#2519)", () => {
        ModelRoute.resetHealth();
        const alpha = ModelRoute.ref({ providerID: "acme", model: "alpha" });
        const beta = ModelRoute.ref({ providerID: "acme", model: "beta" });
        const gamma = ModelRoute.ref({ providerID: "acme", model: "gamma" });
        const other = ModelRoute.ref({ providerID: "other", model: "delta" });
        const events = [];
        ModelRouteLog.setSink((event) => events.push(event));
        try {
            ModelRoute.failed(alpha, policy, 1000, { auth: true }, "cred-a");
            ModelRoute.failed(beta, policy, 2000, { auth: true }, "cred-b");
            // Two refused legs are per-leg benches only: a third leg of the provider still deals.
            expect(ModelRoute.cooldownUntil(gamma, 2000)).toBe(0);
            expect(ModelRoute.providerRootStartBlocked(gamma, 2000)).toBeUndefined();
            ModelRoute.failed(gamma, policy, 3000, { auth: true }, "cred-a");
            // The third refusal gates the provider itself, on every leg and for root starts,
            // while a provider with no refusals is untouched.
            const gatedUntil = 3000 + 900000;
            expect(ModelRoute.cooldownUntil(gamma, 3000)).toBe(gatedUntil);
            expect(ModelRoute.cooldownUntil(alpha, 3000)).toBe(gatedUntil);
            expect(ModelRoute.providerRootStartBlocked(beta, 3000)).toEqual({ until: gatedUntil });
            expect(ModelRoute.cooldownUntil(other, 3000)).toBe(0);
            expect(ModelRoute.providerRootStartBlocked(other, 3000)).toBeUndefined();
            // Further refusals extend the gate on the long ladder.
            ModelRoute.failed(alpha, policy, 10000, { auth: true }, "cred-a");
            expect(ModelRoute.cooldownUntil(gamma, 10000)).toBe(10000 + 1800000);
            // A live success on any leg of the provider clears the gate outright.
            ModelRoute.completed(alpha, policy, { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }, 20000, "cred-a");
            expect(ModelRoute.cooldownUntil(gamma, 20000)).toBe(0);
            expect(ModelRoute.providerRootStartBlocked(gamma, 20000)).toBeUndefined();
        }
        finally {
            ModelRouteLog.setSink(undefined);
        }
        const health = events.flatMap((event) => (event.kind === "health" ? [event.row] : []));
        expect(health.filter((row) => row.reason === "provider:acme hard-failure-gated")).toHaveLength(1);
        expect(health.filter((row) => row.reason === "provider:acme hard-failure-cleared")).toHaveLength(1);
    });
    test("an ordinary failure between auth refusals does not count toward the provider hard-failure run (#2519)", () => {
        ModelRoute.resetHealth();
        const alpha = ModelRoute.ref({ providerID: "acme", model: "alpha" });
        const gamma = ModelRoute.ref({ providerID: "acme", model: "gamma" });
        ModelRoute.failed(alpha, policy, 1000, { auth: true }, "cred-a");
        ModelRoute.failed(alpha, policy, 2000, { auth: true }, "cred-a");
        ModelRoute.failed(alpha, policy, 3000, undefined, "cred-a");
        expect(ModelRoute.cooldownUntil(gamma, 3000)).toBe(0);
    });
    test("a stated retry-after is never multiplied, even after repeated failures", () => {
        ModelRoute.resetHealth();
        ModelRoute.failed(t, policy, 1000);
        ModelRoute.failed(t, policy, 61000);
        ModelRoute.failed(t, policy, 181000, { retryAfterMs: 5000 });
        expect(ModelRoute.cooldownUntil(t, 181000)).toBe(181000 + 5000);
    });
    test("the escalated bench is capped at a day", () => {
        // Quota failures: the class whose ladder still runs to the 24h cap. An ordinary
        // failure's ladder stops at failureCapMs long before this (#2212).
        ModelRoute.resetHealth();
        for (let index = 0; index < 30; index++)
            ModelRoute.failed(t, policy, 1000, { quota: true });
        expect(ModelRoute.cooldownUntil(t, 1000)).toBe(1000 + 86400000);
    });
});
describe("ModelRoute quota bench reset", () => {
    const policy = ModelRoute.policy({ cooldownMs: 60000, quotaCooldownMs: 900000 });
    const target = ModelRoute.ref({ providerID: "reset-provider", model: "quota" });
    const day = 86400000;
    const exhaustLadder = (now, credentialID) => {
        for (let index = 0; index < 8; index++)
            ModelRoute.failed(target, policy, now + index, { quota: true }, credentialID);
    };
    test("caps a credential bench at its exhausted window reset, not an unrelated window", () => {
        const now = 100000000;
        const resetAt = now + 5 * 3600000;
        ModelRoute.observeRateLimit(target, {
            at: now,
            limit: { short: "100", long: "1000" },
            remaining: { short: "0", long: "100" },
            reset: { short: "5h", long: "24h" },
        }, now, "cred-a");
        exhaustLadder(now, "cred-a");
        expect(ModelRoute.credentialCooldownUntil(target, "cred-a", now + 7)).toBe(resetAt);
        expect(ModelRoute.credentialCooldownUntil(target, "cred-a", resetAt - 1)).toBe(resetAt);
        expect(ModelRoute.credentialCooldownUntil(target, "cred-a", resetAt)).toBe(0);
        expect(ModelRoute.credentialCooldownUntil(target, "cred-b", now)).toBe(0);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(0);
        ModelRoute.completed(target, policy, { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }, resetAt, "cred-a");
        ModelRoute.failed(target, policy, resetAt + 1, { quota: true }, "cred-a");
        expect(ModelRoute.credentialCooldownUntil(target, "cred-a", resetAt + 1)).toBe(resetAt + 1 + 900000);
    });
    test("uses a fresh known-full plan reset but never the reactive fallback as an actual reset", () => {
        const now = 200000000;
        const resetAt = now + 5 * 3600000;
        ModelRoute.observeCredentialQuota(target, "cred-plan", {
            planID: "plan",
            window: "five-hours",
            providerID: "reset-provider",
            percent: 100,
            remaining: 0,
            resetAt,
            observedAt: now,
            stale: false,
        }, now);
        ModelRoute.observeQuotaFailure(target, "cred-plan", undefined, now);
        exhaustLadder(now + 1, "cred-plan");
        expect(ModelRoute.credentialCooldownUntil(target, "cred-plan", now + 8)).toBe(resetAt);
        ModelRoute.resetHealth();
        ModelRoute.observeProviderQuota(target, {
            planID: "plan",
            window: "five-hours",
            providerID: "reset-provider",
            percent: 100,
            remaining: 0,
            resetAt,
            observedAt: now,
            stale: false,
        }, now);
        exhaustLadder(now);
        expect(ModelRoute.cooldownUntil(target, now + 7)).toBe(resetAt);
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(target, "cred-fallback", undefined, now);
        exhaustLadder(now, "cred-fallback");
        expect(ModelRoute.credentialCooldownUntil(target, "cred-fallback", now + 7)).toBe(now + 7 + day);
    });
    test("reconciling the gate against live plans clears state derived from an ended plan (#1340)", () => {
        const now = 400000000;
        const resetAt = now + 5 * 3600000;
        const ended = {
            planID: "ended-plan",
            window: "five-hours",
            providerID: "reset-provider",
            percent: 100,
            remaining: 0,
            resetAt,
            observedAt: now,
            stale: false,
        };
        ModelRoute.resetHealth();
        ModelRoute.observeCredentialQuota(target, "cred-ended", ended, now);
        expect(ModelRoute.credentialQuotaBlocked("cred-ended", now)).toEqual({ until: resetAt });
        // While the plan still feeds the gate, reconciliation keeps its state.
        ModelRoute.reconcileQuotaGate("reset-provider", new Set(["ended-plan"]));
        expect(ModelRoute.credentialQuotaBlocked("cred-ended", now)).toEqual({ until: resetAt });
        // The plan ends: it derives no replacement snapshot, so its retained gate state clears
        // and the next route selection no longer blocks the credential on the stale snapshot.
        ModelRoute.reconcileQuotaGate("reset-provider", new Set(["live-plan"]));
        expect(ModelRoute.credentialQuotaBlocked("cred-ended", now)).toBeUndefined();
        // Reactive attempt evidence is not plan capacity: an attempt-derived gate survives
        // reconciliation even when no plan is live.
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(target, "cred-reactive", resetAt, now);
        expect(ModelRoute.credentialQuotaBlocked("cred-reactive", now)).toEqual({ until: resetAt });
        ModelRoute.reconcileQuotaGate("reset-provider", new Set());
        expect(ModelRoute.credentialQuotaBlocked("cred-reactive", now)).toEqual({ until: resetAt });
        // The provider scope follows the same rule, including its plan-derived skip adjustment.
        ModelRoute.resetHealth();
        ModelRoute.observeProviderQuota(target, ended, now);
        expect(ModelRoute.activeAdjustments(now).some((item) => item.id === "quota:reset-provider")).toBe(true);
        ModelRoute.reconcileQuotaGate("reset-provider", new Set(["live-plan"]));
        expect(ModelRoute.activeAdjustments(now).some((item) => item.id === "quota:reset-provider")).toBe(false);
    });
    test("reconciling the gate clears a balance baseline only when its grant's plan ended (#1340)", () => {
        const now = 450000000;
        const balance = {
            planID: "ended-balance-plan",
            window: "credits",
            providerID: "reset-provider",
            percent: 100,
            remaining: 0,
            resetAt: null,
            observedAt: now,
            stale: false,
            balance: true,
        };
        ModelRoute.resetHealth();
        ModelRoute.observeCredentialQuota(target, "cred-balance", balance, now);
        expect(ModelRoute.credentialQuotaBlocked("cred-balance", now)).toEqual({ until: null });
        // The durable baseline record is what re-arms the hold after a restart; while the
        // grant's plan is live, reconciliation leaves both state and record alone.
        ModelRoute.reconcileQuotaGate("reset-provider", new Set(["ended-balance-plan"]));
        expect(ModelRoute.credentialQuotaBlocked("cred-balance", now)).toEqual({ until: null });
        // Once the grant's plan has ended, the baseline goes with the in-memory state:
        // otherwise the restored hold would immediately re-block the credential.
        ModelRoute.reconcileQuotaGate("reset-provider", new Set());
        expect(ModelRoute.credentialQuotaBlocked("cred-balance", now)).toBeUndefined();
        expect(ModelRoute.activeAdjustments(now).some((item) => item.id === "quota-credential:cred-balance")).toBe(false);
    });
    test("a reclassified window replaces a balance hold with its normal timed gate (#1380)", () => {
        const now = 500000000;
        const resetAt = now + 5 * 3600000;
        const balance = {
            planID: "credits-plan",
            window: "credits",
            providerID: "reset-provider",
            percent: 100,
            remaining: 0,
            resetAt: null,
            observedAt: now,
            stale: false,
            balance: true,
        };
        // The same plan + window after a windowHours reclassification: derive() no longer
        // reports it as a balance, so the snapshot is a resetting usage window.
        const windowed = {
            planID: "credits-plan",
            window: "credits",
            providerID: "reset-provider",
            percent: 100,
            remaining: 0,
            resetAt,
            observedAt: now + 1,
            stale: false,
        };
        ModelRoute.resetHealth();
        ModelRoute.observeCredentialQuota(target, "cred-reclass", balance, now);
        expect(ModelRoute.credentialQuotaBlocked("cred-reclass", now)).toEqual({ until: null });
        expect(ModelRoute.activeAdjustments(now).some((item) => item.id === "quota-credential:cred-reclass")).toBe(true);
        ModelRoute.observeCredentialQuota(target, "cred-reclass", windowed, now + 1);
        // The stale increase-only hold is gone: the credential is gated only until the
        // window's stated reset, and the durable baseline record is cleared.
        expect(ModelRoute.credentialQuotaBlocked("cred-reclass", now + 1)).toEqual({ until: resetAt });
        expect(ModelRoute.activeAdjustments(now + 1).some((item) => item.id === "quota-credential:cred-reclass")).toBe(false);
        // A non-balance snapshot from a DIFFERENT grant is not evidence about the hold.
        ModelRoute.resetHealth();
        ModelRoute.observeCredentialQuota(target, "cred-other", balance, now);
        ModelRoute.observeCredentialQuota(target, "cred-other", { ...windowed, planID: "other-plan", window: "five-hours" }, now + 1);
        expect(ModelRoute.credentialQuotaBlocked("cred-other", now + 1)).toEqual({ until: null });
        // The provider scope follows the same rule: its balance skip is replaced by the
        // window's timed skip, with no balance baseline left on the record.
        ModelRoute.resetHealth();
        ModelRoute.observeProviderQuota(target, balance, now);
        expect(ModelRoute.activeAdjustments(now).find((item) => item.id === "quota:reset-provider")?.balanceBaseline).toBe(0);
        ModelRoute.observeProviderQuota(target, windowed, now + 1);
        const skip = ModelRoute.activeAdjustments(now + 1).find((item) => item.id === "quota:reset-provider");
        expect(skip?.balanceBaseline).toBeUndefined();
        expect(skip?.until).toBe(resetAt);
    });
    test("reconciling clears restored balance baselines whose grant plan ended (#1380)", () => {
        const now = 550000000;
        ModelRoute.resetHealth();
        // A baseline record restored after a restart, with no in-memory gate state: it blocks
        // its credential until a fed snapshot releases it -- or until reconciliation clears it.
        ModelRoute.addAdjustment({
            id: "quota-credential:cred-restored",
            match: "credential:cred-restored",
            action: "skip",
            balanceBaseline: 0,
            balanceGrant: "dead-plan\ncredits",
            credentialID: "cred-restored",
            providerID: "reset-provider",
            note: "credential balance exhausted; held until a fresh balance increase (durable baseline record -- not a selection skip)",
        });
        expect(ModelRoute.credentialQuotaBlocked("cred-restored", now)).toEqual({ until: null });
        // While the grant's plan still feeds the gate, the hold is still-applicable and stays.
        ModelRoute.reconcileQuotaGate("reset-provider", new Set(["dead-plan"]));
        expect(ModelRoute.credentialQuotaBlocked("cred-restored", now)).toEqual({ until: null });
        // The grant's plan is gone and no balance grant remains: the stale baseline clears.
        ModelRoute.reconcileQuotaGate("reset-provider", new Set(["live-plan"]));
        expect(ModelRoute.credentialQuotaBlocked("cred-restored", now)).toBeUndefined();
        expect(ModelRoute.activeAdjustments(now).some((item) => item.id === "quota-credential:cred-restored")).toBe(false);
        // The provider scope's restored balance skip follows the same rule.
        ModelRoute.addAdjustment({
            id: "quota:reset-provider",
            match: "reset-provider/",
            action: "skip",
            balanceBaseline: 0,
            balanceGrant: "dead-plan\ncredits",
            note: "quota exhausted (proactive snapshot); held until the stated reset",
        });
        ModelRoute.reconcileQuotaGate("reset-provider", new Set(["dead-plan"]));
        expect(ModelRoute.activeAdjustments(now).some((item) => item.id === "quota:reset-provider")).toBe(true);
        ModelRoute.reconcileQuotaGate("reset-provider", new Set(["live-plan"]));
        expect(ModelRoute.activeAdjustments(now).some((item) => item.id === "quota:reset-provider")).toBe(false);
    });
    test("leaves the ladder unchanged for missing, invalid, elapsed or stale provider resets", () => {
        const now = 300000000;
        const snapshots = [
            { at: now, remaining: { requests: "0" } },
            { at: now, remaining: { requests: "0" }, reset: { requests: "not-a-reset" } },
            { at: now - 2 * 3600000, remaining: { requests: "0" }, reset: { requests: "5h" } },
            { at: now - 2 * 3600000, remaining: { requests: "0" }, reset: { requests: "1h" } },
        ];
        for (const snapshot of snapshots) {
            ModelRoute.resetHealth();
            ModelRoute.observeRateLimit(target, snapshot, now, "cred-a");
            exhaustLadder(now, "cred-a");
            expect(ModelRoute.credentialCooldownUntil(target, "cred-a", now + 7)).toBe(now + 7 + day);
        }
    });
    test("does not cap auth or ordinary benches, and retry-after still wins unless the quota window is sooner", () => {
        const now = 400000000;
        const resetAt = now + 5 * 60000;
        const spent = {
            at: now,
            limit: { requests: "100" },
            remaining: { requests: "0" },
            reset: { requests: "5m" },
        };
        ModelRoute.observeRateLimit(target, spent, now, "cred-auth");
        ModelRoute.failed(target, policy, now, { auth: true }, "cred-auth");
        expect(ModelRoute.credentialCooldownUntil(target, "cred-auth", now)).toBe(now + 900000);
        ModelRoute.resetHealth();
        ModelRoute.observeRateLimit(target, spent, now, "cred-ordinary");
        ModelRoute.failed(target, policy, now, undefined, "cred-ordinary");
        expect(ModelRoute.credentialCooldownUntil(target, "cred-ordinary", now)).toBe(now + 60000);
        ModelRoute.resetHealth();
        ModelRoute.observeRateLimit(target, spent, now, "cred-retry");
        ModelRoute.failed(target, policy, now, { quota: true, retryAfterMs: 120000 }, "cred-retry");
        expect(ModelRoute.credentialCooldownUntil(target, "cred-retry", now)).toBe(now + 120000);
        ModelRoute.resetHealth();
        ModelRoute.observeRateLimit(target, spent, now, "cred-retry-long");
        ModelRoute.failed(target, policy, now, { quota: true, retryAfterMs: 10 * 60000 }, "cred-retry-long");
        expect(ModelRoute.credentialCooldownUntil(target, "cred-retry-long", now)).toBe(resetAt);
    });
    test("a quota bench can expire while an independent provider gate remains active", () => {
        const now = 500000000;
        const resetAt = now + 5 * 60000;
        ModelRoute.observeRateLimit(target, {
            at: now,
            limit: { requests: "100" },
            remaining: { requests: "0" },
            reset: { requests: "5m" },
        }, now);
        ModelRoute.observeQuotaFailure(target, undefined, now + day, now);
        exhaustLadder(now);
        expect(ModelRoute.cooldownUntil(target, now + 7)).toBe(resetAt);
        expect(ModelRoute.skipped(target, resetAt + 1)).toBe(true);
    });
});
describe("ModelRoute quota bench probe (#1123)", () => {
    const policy = ModelRoute.policy({ cooldownMs: 60000, quotaCooldownMs: 900000 });
    const target = ModelRoute.ref({ providerID: "probe-provider", model: "quota" });
    const day = 86400000;
    const sample = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 };
    const exhaustLadder = (now, credentialID) => {
        for (let index = 0; index < 8; index++)
            ModelRoute.failed(target, policy, now + index, { quota: true }, credentialID);
    };
    const knownFull = (resetAt, observedAt) => ({
        planID: "plan",
        window: "five-hours",
        providerID: "probe-provider",
        percent: 100,
        remaining: 0,
        resetAt,
        observedAt,
        stale: false,
    });
    test("a reset learned after the bench arms exactly one probe at rollover; probe success unbenched and clears the ladder", () => {
        const now = 600000000;
        const resetAt = now + 5 * 3600000;
        ModelRoute.resetHealth();
        // The bench is planted before any reset is known: the generic ladder runs to the 24h cap.
        exhaustLadder(now, "cred-probe");
        const benchUntil = now + 7 + day;
        expect(ModelRoute.credentialCooldownUntil(target, "cred-probe", now + 7)).toBe(benchUntil);
        // The quota feed then learns the credential's actual window reset, hours before the bench ends.
        ModelRoute.observeCredentialQuota(target, "cred-probe", knownFull(resetAt, now + 10), now + 10);
        // Route stats surface the active bench with its reason, expiry and known reset.
        expect(ModelRoute.activeBenches(now + 11)).toEqual([
            {
                providerID: "probe-provider",
                modelID: "quota",
                credentialID: "cred-probe",
                until: benchUntil,
                reason: "quota",
                consecutiveFailures: 8,
                quotaResetAt: resetAt,
                probeDue: false,
                probeClaimed: false,
            },
        ]);
        expect(ModelRoute.probeDue(target, "cred-probe", resetAt - 1)).toBe(false);
        expect(ModelRoute.probeDue(target, "cred-probe", resetAt)).toBe(true);
        // Exactly one probe: the first claim wins, later claims are refused while it is outstanding,
        // and ordinary candidacy stays excluded the whole time.
        expect(ModelRoute.claimBenchProbe(target, "cred-probe", resetAt)).toBe(true);
        expect(ModelRoute.claimBenchProbe(target, "cred-probe", resetAt)).toBe(false);
        expect(ModelRoute.probeDue(target, "cred-probe", resetAt)).toBe(false);
        expect(ModelRoute.credentialCooldownUntil(target, "cred-probe", resetAt)).toBe(benchUntil);
        expect(ModelRoute.activeBenches(resetAt)[0]?.probeClaimed).toBe(true);
        // Probe success fully unbenched the credential (the bench had ~19h left) and clears the ladder:
        // the next quota failure benches at the base again instead of escalating.
        ModelRoute.completed(target, policy, sample, resetAt + 1, "cred-probe");
        expect(ModelRoute.credentialCooldownUntil(target, "cred-probe", resetAt + 1)).toBe(0);
        expect(ModelRoute.activeBenches(resetAt + 1)).toEqual([]);
        ModelRoute.failed(target, policy, resetAt + 2, { quota: true }, "cred-probe");
        expect(ModelRoute.credentialCooldownUntil(target, "cred-probe", resetAt + 2)).toBe(resetAt + 2 + 900000);
    });
    test("a failed probe re-benches on the escalated ladder, capped at the next known reset", () => {
        const now = 700000000;
        const resetAt = now + 5 * 3600000;
        const nextResetAt = resetAt + 5 * 3600000;
        ModelRoute.resetHealth();
        exhaustLadder(now, "cred-probe-fail");
        ModelRoute.observeCredentialQuota(target, "cred-probe-fail", knownFull(resetAt, now + 10), now + 10);
        // The next window's reset becomes known before the probe runs.
        ModelRoute.observeCredentialQuota(target, "cred-probe-fail", knownFull(nextResetAt, resetAt), resetAt);
        expect(ModelRoute.claimBenchProbe(target, "cred-probe-fail", resetAt)).toBe(true);
        ModelRoute.failed(target, policy, resetAt + 1, { quota: true }, "cred-probe-fail");
        // Ninth consecutive failure: the ladder alone would cap at 24h; the next known reset bounds it.
        expect(ModelRoute.credentialCooldownUntil(target, "cred-probe-fail", resetAt + 1)).toBe(nextResetAt);
        expect(ModelRoute.probeDue(target, "cred-probe-fail", resetAt + 1)).toBe(false);
        // The re-bench ends AT the next reset, so candidacy returns there without needing a probe.
        expect(ModelRoute.credentialCooldownUntil(target, "cred-probe-fail", nextResetAt)).toBe(0);
        // Sibling credentials were never benched or probed.
        expect(ModelRoute.credentialCooldownUntil(target, "cred-other", resetAt + 1)).toBe(0);
        expect(ModelRoute.probeDue(target, "cred-other", nextResetAt)).toBe(false);
    });
    test("a target-level quota bench probes at a provider window reset learned after the bench", () => {
        const now = 800000000;
        const resetAt = now + 5 * 3600000;
        ModelRoute.resetHealth();
        exhaustLadder(now);
        expect(ModelRoute.cooldownUntil(target, now + 7)).toBe(now + 7 + day);
        ModelRoute.observeProviderQuota(target, knownFull(resetAt, now + 10), now + 10);
        expect(ModelRoute.probeDue(target, undefined, resetAt - 1)).toBe(false);
        expect(ModelRoute.probeDue(target, undefined, resetAt)).toBe(true);
        expect(ModelRoute.claimBenchProbe(target, undefined, resetAt)).toBe(true);
        expect(ModelRoute.claimBenchProbe(target, undefined, resetAt)).toBe(false);
        ModelRoute.completed(target, policy, sample, resetAt + 1);
        expect(ModelRoute.cooldownUntil(target, resetAt + 1)).toBe(0);
    });
    test("a released probe claim leaves the bench in force and the probe due again (#1478)", () => {
        const now = 850000000;
        const resetAt = now + 5 * 3600000;
        ModelRoute.resetHealth();
        exhaustLadder(now);
        ModelRoute.observeProviderQuota(target, knownFull(resetAt, now + 10), now + 10);
        expect(ModelRoute.claimBenchProbe(target, undefined, resetAt)).toBe(true);
        // A release naming a different claim is not this claim's owner: the claim stands.
        expect(ModelRoute.releaseBenchProbe(target, undefined, resetAt + 1)).toBe(false);
        expect(ModelRoute.activeBenches(resetAt)[0]?.probeClaimed).toBe(true);
        // The owner's release hands the probe back: bench and expiry unchanged, probe due again.
        expect(ModelRoute.releaseBenchProbe(target, undefined, resetAt)).toBe(true);
        expect(ModelRoute.cooldownUntil(target, resetAt)).toBe(now + 7 + day);
        expect(ModelRoute.activeBenches(resetAt)[0]?.probeClaimed).toBe(false);
        expect(ModelRoute.probeDue(target, undefined, resetAt)).toBe(true);
        expect(ModelRoute.claimBenchProbe(target, undefined, resetAt + 1)).toBe(true);
    });
    test("a quota probe claim that never settles goes stale at the claim bound while its bench still stands (#2455)", () => {
        const now = 875000000;
        const resetAt = now + 5 * 3600000;
        const bound = ModelRoute.PROBE_CLAIM_MAX_AGE_MS;
        ModelRoute.resetHealth();
        exhaustLadder(now);
        ModelRoute.observeProviderQuota(target, knownFull(resetAt, now + 10), now + 10);
        expect(ModelRoute.claimBenchProbe(target, undefined, resetAt)).toBe(true);
        // Within the bound the outstanding claim still holds the probe.
        expect(ModelRoute.probeDue(target, undefined, resetAt + bound)).toBe(false);
        expect(ModelRoute.probeInFlight(target, undefined, resetAt + bound)).toBe(true);
        // Past the bound the claim is stale even though the bench itself (a day long)
        // still stands: the probe is due again and a fresh claim takes the scope.
        expect(ModelRoute.probeInFlight(target, undefined, resetAt + bound + 1)).toBe(false);
        expect(ModelRoute.probeDue(target, undefined, resetAt + bound + 1)).toBe(true);
        expect(ModelRoute.claimBenchProbe(target, undefined, resetAt + bound + 1)).toBe(true);
        expect(ModelRoute.probeInFlight(target, undefined, resetAt + bound + 1)).toBe(true);
        expect(ModelRoute.cooldownUntil(target, resetAt + bound + 1)).toBe(now + 7 + day);
    });
    test("a stale token release cannot clear a same-millisecond re-claim (#1486)", () => {
        const now = 950000000;
        const resetAt = now + 5 * 3600000;
        ModelRoute.resetHealth();
        exhaustLadder(now);
        ModelRoute.observeProviderQuota(target, knownFull(resetAt, now + 10), now + 10);
        const first = ModelRoute.nextProbeClaimToken();
        expect(ModelRoute.claimBenchProbe(target, undefined, resetAt, first)).toBe(true);
        expect(ModelRoute.releaseBenchProbe(target, undefined, resetAt, first)).toBe(true);
        // A newer pick re-claims within the same millisecond: the timestamp alone collides.
        const second = ModelRoute.nextProbeClaimToken();
        expect(second).not.toBe(first);
        expect(ModelRoute.claimBenchProbe(target, undefined, resetAt, second)).toBe(true);
        // The first pick's redundant release names the same millisecond but a stale token:
        // the newer claim stands.
        expect(ModelRoute.releaseBenchProbe(target, undefined, resetAt, first)).toBe(false);
        expect(ModelRoute.activeBenches(resetAt)[0]?.probeClaimed).toBe(true);
        expect(ModelRoute.probeDue(target, undefined, resetAt)).toBe(false);
        expect(ModelRoute.releaseBenchProbe(target, undefined, resetAt, second)).toBe(true);
        expect(ModelRoute.probeDue(target, undefined, resetAt)).toBe(true);
    });
    test("failed settles both probe scopes of one pick, even when the serving credential differs (#1486)", () => {
        const now = 960000000;
        const resetAt = now + 5 * 3600000;
        const setup = () => {
            ModelRoute.resetHealth();
            exhaustLadder(now);
            exhaustLadder(now, "cred-probe");
            ModelRoute.observeProviderQuota(target, knownFull(resetAt, now + 10), now + 10);
            ModelRoute.observeCredentialQuota(target, "cred-probe", knownFull(resetAt, now + 10), now + 10);
            const token = ModelRoute.nextProbeClaimToken();
            expect(ModelRoute.claimBenchProbe(target, undefined, resetAt, token)).toBe(true);
            expect(ModelRoute.claimBenchProbe(target, "cred-probe", resetAt, token)).toBe(true);
            return token;
        };
        const benchOf = (at, credentialID) => ModelRoute.activeBenches(at).find((bench) => bench.modelID === "quota" && bench.credentialID === credentialID);
        // Without the pick's claim, a serving-credential failure leaves both probe scopes stranded.
        setup();
        ModelRoute.failed(target, policy, resetAt + 1, { quota: true }, "cred-serving");
        expect(benchOf(resetAt + 1)?.probeClaimed).toBe(true);
        expect(benchOf(resetAt + 1, "cred-probe")?.probeClaimed).toBe(true);
        // With it, the same failure renews the target scope and the probe credential scope too,
        // while the serving credential keeps its own health accounting.
        const token = setup();
        ModelRoute.failed(target, policy, resetAt + 1, { quota: true }, "cred-serving", undefined, {
            claimedAt: resetAt,
            token,
            credentialID: "cred-probe",
        });
        expect(ModelRoute.cooldownUntil(target, resetAt + 1)).toBeGreaterThan(resetAt + 1);
        expect(ModelRoute.credentialCooldownUntil(target, "cred-probe", resetAt + 1)).toBeGreaterThan(resetAt + 1);
        expect(ModelRoute.credentialCooldownUntil(target, "cred-serving", resetAt + 1)).toBeGreaterThan(resetAt + 1);
        expect(benchOf(resetAt + 1)?.probeClaimed).toBe(false);
        expect(benchOf(resetAt + 1, "cred-probe")?.probeClaimed).toBe(false);
        expect(ModelRoute.probeDue(target, undefined, resetAt + 1)).toBe(false);
        expect(ModelRoute.probeDue(target, "cred-probe", resetAt + 1)).toBe(false);
    });
    test("completed ends a probe credential that differs from the serving one (#1486)", () => {
        const now = 970000000;
        const resetAt = now + 5 * 3600000;
        const setup = () => {
            ModelRoute.resetHealth();
            exhaustLadder(now);
            exhaustLadder(now, "cred-probe");
            ModelRoute.observeProviderQuota(target, knownFull(resetAt, now + 10), now + 10);
            ModelRoute.observeCredentialQuota(target, "cred-probe", knownFull(resetAt, now + 10), now + 10);
            const token = ModelRoute.nextProbeClaimToken();
            expect(ModelRoute.claimBenchProbe(target, undefined, resetAt, token)).toBe(true);
            expect(ModelRoute.claimBenchProbe(target, "cred-probe", resetAt, token)).toBe(true);
            return token;
        };
        // Without the pick's claim, success on the serving credential leaves the probe
        // credential's bench (and its outstanding claim) in force.
        setup();
        ModelRoute.completed(target, policy, sample, resetAt + 1, "cred-serving");
        expect(ModelRoute.credentialCooldownUntil(target, "cred-probe", resetAt + 1)).toBeGreaterThan(resetAt + 1);
        expect(ModelRoute.activeBenches(resetAt + 1).find((bench) => bench.credentialID === "cred-probe")?.probeClaimed).toBe(true);
        // With it, the same success ends the target scope and the probe credential scope too.
        const token = setup();
        ModelRoute.completed(target, policy, sample, resetAt + 1, "cred-serving", undefined, {
            claimedAt: resetAt,
            token,
            credentialID: "cred-probe",
        });
        expect(ModelRoute.cooldownUntil(target, resetAt + 1)).toBe(0);
        expect(ModelRoute.credentialCooldownUntil(target, "cred-probe", resetAt + 1)).toBe(0);
        expect(ModelRoute.credentialCooldownUntil(target, "cred-serving", resetAt + 1)).toBe(0);
    });
    test("a quota reset never arms an auth bench's probe early; the probe comes at the bench's own expiry (code#9950)", () => {
        const now = 900000000;
        const resetAt = now + 5 * 3600000;
        ModelRoute.resetHealth();
        ModelRoute.failed(target, policy, now, { auth: true }, "cred-auth");
        ModelRoute.observeCredentialQuota(target, "cred-auth", knownFull(resetAt, now + 1), now + 1);
        // While the auth bench stands (900_000 from `now`), the learned quota reset arms
        // nothing: an auth bench has no window to roll over.
        expect(ModelRoute.probeDue(target, "cred-auth", now + 899999)).toBe(false);
        expect(ModelRoute.claimBenchProbe(target, "cred-auth", now + 899999)).toBe(false);
        // At the bench's own expiry the probe comes due (code#9950) — by then the reset
        // is long past, and it is the expiry, not the reset, that admits the probe.
        expect(ModelRoute.probeDue(target, "cred-auth", resetAt)).toBe(true);
        expect(ModelRoute.claimBenchProbe(target, "cred-auth", resetAt)).toBe(true);
        ModelRoute.resetHealth();
        exhaustLadder(now, "cred-fallback");
        ModelRoute.observeQuotaFailure(target, "cred-fallback", undefined, now + 10);
        expect(ModelRoute.activeBenches(now + 11)[0]?.quotaResetAt).toBeUndefined();
        expect(ModelRoute.probeDue(target, "cred-fallback", now + day)).toBe(false);
    });
});
describe("ModelRoute budgets", () => {
    const t = ModelRoute.ref({ providerID: "openai", model: "budgeted" });
    test("passes a target over once it reaches its soft limit, and frees it as the window moves", () => {
        ModelRoute.resetHealth();
        const budget = { requestsPerMinute: 10, softLimit: 0.5 };
        const start = 1000000;
        for (let index = 0; index < 4; index++)
            ModelRoute.recordUsage(t, 100, start + index * 1000);
        expect(ModelRoute.overBudget(t, budget, start + 5000)).toBe(false);
        ModelRoute.recordUsage(t, 100, start + 5000);
        expect(ModelRoute.overBudget(t, budget, start + 6000)).toBe(true);
        expect(ModelRoute.usageOf(t, start + 6000).minute).toEqual({ requests: 5, tokens: 500 });
        expect(ModelRoute.overBudget(t, budget, start + 70000)).toBe(false);
        expect(ModelRoute.usageOf(t, start + 70000).day.requests).toBe(5);
    });
    test("counts daily tokens and expires them after a day", () => {
        ModelRoute.resetHealth();
        const budget = { tokensPerDay: 1000 };
        ModelRoute.recordUsage(t, 950, 1000);
        expect(ModelRoute.overBudget(t, budget, 2000)).toBe(true);
        expect(ModelRoute.overBudget(t, budget, 1000 + 86400000 + 1)).toBe(false);
        expect(ModelRoute.overBudget(t, undefined, 2000)).toBe(false);
    });
    test("seeds usage from stored history in order", () => {
        ModelRoute.resetHealth();
        ModelRoute.seedUsage([
            { time: 3000, providerID: "openai", modelID: "budgeted", tokens: 30 },
            { time: 1000, providerID: "openai", modelID: "budgeted", tokens: 10 },
        ]);
        expect(ModelRoute.usageOf(t, 4000).day).toEqual({ requests: 2, tokens: 40 });
    });
});
describe("ModelRoute.slow", () => {
    test("repeated slow losses cool a target down like any other slow one", () => {
        ModelRoute.resetHealth();
        const policy = ModelRoute.policy({ sampleWindow: 5, slowThreshold: 3, cooldownMs: 60000 });
        const t = ModelRoute.ref({ providerID: "openai", model: "slowpoke" });
        ModelRoute.slow(t, policy, 1000);
        ModelRoute.slow(t, policy, 2000);
        expect(ModelRoute.coolingDown(t, 2000)).toBe(false);
        ModelRoute.slow(t, policy, 3000);
        expect(ModelRoute.coolingDown(t, 3000)).toBe(true);
        expect(ModelRoute.coolingDown(t, 64000)).toBe(false);
    });
});
describe("ModelRoute provider rate limits", () => {
    const t = ModelRoute.ref({ providerID: "openai", model: "limited" });
    const spent = (reset, now) => ({
        at: now,
        limit: { requests: "60" },
        remaining: { requests: "0" },
        reset: { requests: reset },
    });
    test("a spent window holds the target back until it resets, without counting as a failure", () => {
        ModelRoute.resetHealth();
        const now = 5000000;
        ModelRoute.observeRateLimit(t, spent("30s", now), now);
        expect(ModelRoute.limitedUntil(t, now + 1000)).toBe(now + 30000);
        expect(ModelRoute.coolingDown(t, now + 1000)).toBe(false);
        expect(ModelRoute.limitedUntil(t, now + 31000)).toBe(0);
    });
    test("a healthy report is remembered but holds nothing", () => {
        ModelRoute.resetHealth();
        const now = 5000000;
        const healthy = { at: now, limit: { requests: "60" }, remaining: { requests: "59" }, reset: { requests: "1s" } };
        ModelRoute.observeRateLimit(t, healthy, now);
        expect(ModelRoute.limitedUntil(t, now)).toBe(0);
        expect(ModelRoute.rateLimitOf(t)).toEqual(healthy);
    });
    test("a later healthy report lifts the hold", () => {
        ModelRoute.resetHealth();
        const now = 5000000;
        ModelRoute.observeRateLimit(t, spent("1h", now), now);
        expect(ModelRoute.limitedUntil(t, now + 1000)).toBeGreaterThan(0);
        ModelRoute.observeRateLimit(t, { at: now + 2000, limit: { requests: "60" }, remaining: { requests: "60" } }, now + 2000);
        expect(ModelRoute.limitedUntil(t, now + 3000)).toBe(0);
    });
    test("ignores a response that said nothing and is cleared with the rest of the health state", () => {
        ModelRoute.resetHealth();
        ModelRoute.observeRateLimit(t, undefined);
        expect(ModelRoute.rateLimitOf(t)).toBeUndefined();
        ModelRoute.observeRateLimit(t, spent("1h", Date.now()));
        ModelRoute.resetHealth();
        expect(ModelRoute.limitedUntil(t)).toBe(0);
        expect(ModelRoute.rateLimitOf(t)).toBeUndefined();
    });
    test("restored windows hold targets back", () => {
        ModelRoute.resetHealth();
        const now = Date.now();
        ModelRoute.seedLimits([{ providerID: "openai", modelID: "limited", until: now + 60000 }]);
        expect(ModelRoute.limitedUntil(t, now)).toBe(now + 60000);
    });
});
describe("ModelRoute continuity", () => {
    const primary = ModelRoute.ref({ providerID: "p", model: "a" });
    const fallback = ModelRoute.ref({ providerID: "p", model: "b" });
    const policy = ModelRoute.policy();
    const sample = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 };
    const ordered = {
        id: "r",
        targets: [primary, fallback],
        targetVariants: [],
        health: policy,
        nodes: [{ selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
    };
    const both = new Set([0, 1]);
    test("a target is steady until it has two give-ups in its last five requests", () => {
        expect(ModelRoute.steady(primary)).toBe(true);
        ModelRoute.failed(primary, policy);
        expect(ModelRoute.steady(primary)).toBe(true);
        ModelRoute.failed(primary, policy);
        expect(ModelRoute.steady(primary)).toBe(false);
        for (let index = 0; index < 4; index++)
            ModelRoute.completed(primary, policy, sample);
        expect(ModelRoute.steady(primary)).toBe(true);
    });
    test("a failover keeps the origin and offers it as the hedge partner for the next two requests", () => {
        ModelRoute.moved("r", "s1", primary);
        expect(ModelRoute.hedgeHome("r", "s1")).toBe("p/a");
        ModelRoute.served("r", "s1", fallback);
        expect(ModelRoute.hedgeHome("r", "s1")).toBe("p/a");
        ModelRoute.served("r", "s1", fallback);
        expect(ModelRoute.hedgeHome("r", "s1")).toBeUndefined();
        expect(ModelRoute.continuityOf("r", "s1")).toMatchObject({ current: "p/b", origin: "p/a", away: 2 });
    });
    test("answering from the origin again ends the move", () => {
        ModelRoute.moved("r", "s2", primary);
        ModelRoute.served("r", "s2", fallback);
        ModelRoute.served("r", "s2", primary);
        expect(ModelRoute.continuityOf("r", "s2")).toEqual({ current: "p/a", away: 0 });
        expect(ModelRoute.hedgeHome("r", "s2")).toBeUndefined();
    });
    test("an ordered route keeps a session on the target answering it while that target is ready", () => {
        expect(ModelRoute.orderTargets(ordered, both, "s3", false)).toEqual([0, 1]);
        ModelRoute.moved("r", "s3", primary);
        ModelRoute.served("r", "s3", fallback);
        // The primary has recovered and is first in order, but the session stays on the fallback.
        expect(ModelRoute.orderTargets(ordered, both, "s3", false)).toEqual([1, 0]);
        // Other sessions still start at the primary.
        expect(ModelRoute.orderTargets(ordered, both, "other", false)).toEqual([0, 1]);
        // If the current target is not ready, the order falls back to the configured one.
        expect(ModelRoute.orderTargets(ordered, new Set([0]), "s3", false)).toEqual([0]);
    });
    test("a session's continuity is dropped with the rest of the health state", () => {
        ModelRoute.moved("r", "s4", primary);
        ModelRoute.resetHealth();
        expect(ModelRoute.continuityOf("r", "s4")).toBeUndefined();
    });
});
describe("ModelRoute burst holds, quota demotion and escalation", () => {
    const primary = ModelRoute.ref({ providerID: "anthropic", model: "sonnet" });
    const backup = ModelRoute.ref({ providerID: "openai", model: "fallback" });
    const policy = ModelRoute.policy({ cooldownMs: 1000 });
    const ordered = {
        id: "burst",
        targets: [primary, backup],
        targetVariants: [],
        health: policy,
        nodes: [{ selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
    };
    const both = new Set([0, 1]);
    const spent = (now) => ({
        at: now,
        limit: { requests: "60" },
        remaining: { requests: "0" },
        reset: { requests: "30s" },
    });
    afterEach(() => {
        ModelRoute.configure({
            escalation: { enabled: true, afterGiveUps: 2 },
            quota: { demoteAfter: 3, windowMs: 4 * 3600000 },
        });
    });
    test("a session already on a held target keeps it, while a new session goes elsewhere", () => {
        ModelRoute.resetHealth();
        const now = 9000000;
        ModelRoute.observeRateLimit(primary, spent(now), now);
        ModelRoute.moved("burst", "old", backup);
        ModelRoute.served("burst", "old", primary);
        expect(ModelRoute.keepsThrough("burst", "old", primary, now + 1000)).toBe(true);
        expect(ModelRoute.keepsThrough("burst", "new", primary, now + 1000)).toBe(false);
    });
    test("a session on a held target moves once that target starts failing", () => {
        ModelRoute.resetHealth();
        const now = 9000000;
        ModelRoute.observeRateLimit(primary, spent(now), now);
        ModelRoute.moved("burst", "s", backup);
        ModelRoute.served("burst", "s", primary);
        ModelRoute.failed(primary, policy, now);
        ModelRoute.failed(primary, policy, now);
        expect(ModelRoute.keepsThrough("burst", "s", primary, now + 1000)).toBe(false);
    });
    test("three quota errors within the window put a target last in the order", () => {
        ModelRoute.resetHealth();
        const now = Date.now();
        const quota = { quota: true };
        ModelRoute.failed(primary, policy, now, quota);
        ModelRoute.failed(primary, policy, now + 1, quota);
        expect(ModelRoute.demoted(primary, now + 2)).toBe(false);
        ModelRoute.failed(primary, policy, now + 2, quota);
        expect(ModelRoute.demoted(primary, now + 3)).toBe(true);
        expect(ModelRoute.orderTargets(ordered, both, "new", false)).toEqual([1, 0]);
        // Old quota errors age out of the window, and the target returns to its place.
        expect(ModelRoute.demoted(primary, now + 4 * 3600000 + 10)).toBe(false);
    });
    test("a demoted target is not kept by a session that was already on it", () => {
        ModelRoute.resetHealth();
        const now = Date.now();
        ModelRoute.moved("burst", "q", backup);
        ModelRoute.served("burst", "q", primary);
        for (let index = 0; index < 3; index++)
            ModelRoute.failed(primary, policy, now + index, { quota: true });
        expect(ModelRoute.orderTargets(ordered, both, "q", false)).toEqual([1, 0]);
    });
    test("escalation starts once a target has given up twice recently, and can be switched off", () => {
        ModelRoute.resetHealth();
        expect(ModelRoute.escalates(primary)).toBe(false);
        ModelRoute.failed(primary, policy);
        expect(ModelRoute.escalates(primary)).toBe(false);
        ModelRoute.failed(primary, policy);
        expect(ModelRoute.escalates(primary)).toBe(true);
        ModelRoute.configure({ escalation: { enabled: false } });
        expect(ModelRoute.escalates(primary)).toBe(false);
    });
    test("the escalation threshold is tunable", () => {
        ModelRoute.resetHealth();
        ModelRoute.configure({ escalation: { afterGiveUps: 1 } });
        ModelRoute.failed(primary, policy);
        expect(ModelRoute.escalates(primary)).toBe(true);
    });
    test("currentSettings reports the defaults and what configure has changed", () => {
        expect(ModelRoute.currentSettings()).toEqual({
            escalation: { enabled: true, afterGiveUps: 2 },
            quota: { demoteAfter: 3, windowMs: 4 * 3600000 },
        });
        ModelRoute.configure({ quota: { demoteAfter: 5 } });
        expect(ModelRoute.currentSettings().quota).toEqual({ demoteAfter: 5, windowMs: 4 * 3600000 });
    });
});
describe("ModelRoute scheduled weights", () => {
    const a = ModelRoute.ref({ providerID: "p", model: "a" });
    const b = ModelRoute.ref({ providerID: "p", model: "b" });
    const c = ModelRoute.ref({ providerID: "p", model: "c" });
    const d = ModelRoute.ref({ providerID: "p", model: "d" });
    const always = { timezone: "UTC" };
    const definition = (weights, schedules = [], targets = [a, b, c, d], selection = "ordered") => ({
        id: "r",
        targets: targets.slice(0, weights.length),
        targetVariants: [],
        health: ModelRoute.policy(),
        nodes: [
            {
                selection,
                weights,
                ...(schedules.length > 0 ? { schedules } : {}),
                children: weights.map((_, index) => ({ leaf: index })),
            },
        ],
    });
    const fixed = (route) => ({ ...route, autonomy: "fixed" });
    const ready = (count) => new Set(Array.from({ length: count }, (_, index) => index));
    test("equal weights keep the configured order; different weights rank first", () => {
        const route = definition([1, 1, 1, 1], [
            { window: always, match: { targets: ["p/a"] }, factor: 1.2 },
            { window: always, match: { targets: ["p/c"] }, factor: 0.8 },
        ]);
        // 1.2 first, then the 1s in configured order, then the 0.8s.
        expect(ModelRoute.orderTargets(route, ready(4), undefined, false)).toEqual([0, 1, 3, 2]);
    });
    test("a static weight replaces the configured weight, a factor scales it", () => {
        const scaled = definition([2, 1], [{ window: always, match: { targets: ["p/a"] }, factor: 0.8 }], [a, b]);
        expect(ModelRoute.orderTargets(scaled, ready(2), undefined, false)).toEqual([0, 1]); // 1.6 vs 1
        const replaced = definition([2, 1], [{ window: always, match: { targets: ["p/a"] }, weight: 0.5 }], [a, b]);
        expect(ModelRoute.orderTargets(replaced, ready(2), undefined, false)).toEqual([1, 0]); // 0.5 vs 1
    });
    test("a schedule outside its window leaves the order alone", () => {
        const tomorrow = { daysOfWeek: [(new Date().getUTCDay() + 1) % 7], timezone: "UTC" };
        const route = definition([1, 1], [{ window: tomorrow, match: { targets: ["p/b"] }, factor: 10 }], [a, b]);
        expect(ModelRoute.orderTargets(route, ready(2), undefined, false)).toEqual([0, 1]);
    });
    test("configured weights order the remaining targets on every selection mode", () => {
        const rr = definition([1, 2], [], [a, b], "round-robin");
        expect(ModelRoute.orderTargets(rr, ready(2), undefined, false)).toEqual([1, 0]);
        const weighted = definition([1, 2], [], [a, b], "weighted");
        expect(ModelRoute.orderTargets(weighted, ready(2), undefined, false)).toEqual([1, 0]);
    });
    test("a session stays on the target answering it even when a schedule ranks it lower", () => {
        ModelRoute.resetHealth();
        const route = definition([1, 1], [{ window: always, match: { targets: ["p/b"] }, factor: 10 }], [a, b]);
        ModelRoute.moved("r", "s1", a);
        ModelRoute.served("r", "s1", b);
        expect(ModelRoute.orderTargets(route, ready(2), "s1", false)).toEqual([1, 0]);
        // A fresh session follows the schedule instead.
        expect(ModelRoute.orderTargets(route, ready(2), "fresh", false)).toEqual([1, 0]);
    });
    test("a global rule reaches only the routes it names", () => {
        const base = {
            id: "r",
            targets: [a, b],
            targetVariants: [],
            health: ModelRoute.policy(),
            nodes: [{ selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] }],
        };
        const scoped = {
            window: always,
            match: { targets: ["p/b"], routes: ["other"] },
            factor: 10,
        };
        expect(ModelRoute.orderTargets({ ...base, schedules: [scoped] }, ready(2), undefined, false)).toEqual([0, 1]);
        expect(ModelRoute.orderTargets({ ...base, id: "other", schedules: [scoped] }, ready(2), undefined, false)).toEqual([1, 0]);
        // A route id names a pool, so it matches in any case.
        expect(ModelRoute.orderTargets({ ...base, id: "OTHER", schedules: [scoped] }, ready(2), undefined, false)).toEqual([1, 0]);
    });
    test("a schedule on a nested route applies inside it", () => {
        const nested = {
            id: "outer",
            targets: [a, b, c],
            targetVariants: [],
            health: ModelRoute.policy(),
            nodes: [
                { routeID: "outer", selection: "ordered", weights: [1, 1], children: [{ leaf: 0 }, { node: 1 }] },
                {
                    routeID: "inner",
                    selection: "ordered",
                    weights: [1, 1],
                    schedules: [{ window: always, match: { targets: ["p/b"] }, factor: 0.5 }],
                    children: [{ leaf: 1 }, { leaf: 2 }],
                },
            ],
        };
        // Outer: leaf a (1) before the group (average 0.75); inside the group c (1) before b (0.5).
        expect(ModelRoute.orderTargets(nested, ready(3), undefined, false)).toEqual([0, 2, 1]);
    });
    test("a config schedule reorders a fixed route while a learned weight does not", () => {
        const scheduled = fixed(definition([1, 1], [{ window: always, match: { targets: ["p/b"] }, factor: 10 }], [a, b]));
        expect(ModelRoute.orderTargets(scheduled, ready(2), undefined, false)).toEqual([1, 0]);
        const learned = fixed(definition([1, 1], [], [a, b]));
        ModelRoute.setAdjustments([{ id: "tuned", match: "p/b", action: "weight", factor: 10, until: Date.now() + 60000 }]);
        expect(ModelRoute.orderTargets(learned, ready(2), undefined, false)).toEqual([0, 1]);
    });
    test("a definition with schedules survives the settings round trip", () => {
        const built = definition([2, 1], [{ window: always, match: { targets: ["p/a"] }, factor: 0.8 }], [a, b]);
        const info = {
            providerID: ModelRoute.PROVIDER_ID,
            id: "r",
            settings: { [ModelRoute.SETTING]: built },
        };
        const decoded = ModelRoute.definition(info);
        expect(decoded?.schedules).toBeUndefined();
        expect(decoded?.nodes[0].schedules).toEqual([{ window: always, match: { targets: ["p/a"] }, factor: 0.8 }]);
        expect(ModelRoute.orderTargets(decoded, ready(2), undefined, false)).toEqual([0, 1]);
    });
    test("a definition with date constraints survives the settings round trip", () => {
        const today = new Date().toISOString().slice(0, 10);
        const window = {
            timezone: "UTC",
            dates: ["2026-12-25"],
            excludeDates: ["2026-12-24"],
            excludeWindows: ["holidays"],
            excludedWindows: [{ dates: [today], timezone: "UTC" }],
        };
        const built = definition([1, 1], [{ window, match: { targets: ["p/b"] }, factor: 10 }], [a, b]);
        const info = {
            providerID: ModelRoute.PROVIDER_ID,
            id: "r",
            settings: { [ModelRoute.SETTING]: built },
        };
        const decoded = ModelRoute.definition(info);
        expect(decoded?.nodes[0].schedules).toEqual([{ window, match: { targets: ["p/b"] }, factor: 10 }]);
        // The resolved holiday exclusion is active today, so the rule stays out of force.
        expect(ModelRoute.orderTargets(decoded, ready(2), undefined, false)).toEqual([0, 1]);
    });
});
describe("ModelRoute window gates", () => {
    const flash = ModelRoute.ref({ providerID: "p", model: "flash" });
    const mimo = ModelRoute.ref({ providerID: "p", model: "mimo" });
    const always = { timezone: "UTC" };
    // A window active only tomorrow (UTC), following the scheduled-weights tests above.
    const tomorrow = { daysOfWeek: [(new Date().getUTCDay() + 1) % 7], timezone: "UTC" };
    const ready = new Set([0, 1]);
    test("gateOpen is open with no gate, follows the window, and invert flips it", () => {
        // January 5, 2026 is a Monday; 15:00 UTC is inside 09:00-17:00.
        const monday = Date.UTC(2026, 0, 5, 15, 0);
        const peak = { daysOfWeek: [1], start: "09:00", end: "17:00", timezone: "UTC" };
        expect(ModelRoute.gateOpen(undefined, monday)).toBe(true);
        expect(ModelRoute.gateOpen({ name: "peak", window: peak }, monday)).toBe(true);
        expect(ModelRoute.gateOpen({ name: "peak", window: peak, invert: true }, monday)).toBe(false);
        expect(ModelRoute.gateOpen({ name: "peak", window: { daysOfWeek: [2], timezone: "UTC" } }, monday)).toBe(false);
        expect(ModelRoute.gateOpen({ name: "peak", window: { daysOfWeek: [2], timezone: "UTC" }, invert: true }, monday)).toBe(true);
    });
    test("an ordered route resolves flash then mimo off-peak and mimo then flash at peak", () => {
        const gated = (peak) => ({
            id: "r",
            targets: [flash, mimo],
            targetVariants: [],
            health: ModelRoute.policy(),
            nodes: [
                {
                    routeID: "r",
                    selection: "ordered",
                    weights: [1, 1, 1],
                    children: [
                        { node: 1, gate: { name: "peak", window: peak, invert: true } },
                        { node: 2 },
                        { node: 3, gate: { name: "peak", window: peak } },
                    ],
                },
                { routeID: "flash-plan", selection: "ordered", weights: [1], children: [{ leaf: 0 }] },
                { routeID: "mimo-plan", selection: "ordered", weights: [1], children: [{ leaf: 1 }] },
                { routeID: "flash-peak", selection: "ordered", weights: [1], children: [{ leaf: 0 }] },
            ],
        });
        // Peak window inactive (tomorrow only): the inverted gate is open, the peak gate is closed.
        expect(ModelRoute.orderTargets(gated(tomorrow), ready, undefined, false)).toEqual([0, 1]);
        // Peak window active (always): the inverted gate is closed, the peak gate is open.
        expect(ModelRoute.orderTargets(gated(always), ready, undefined, false)).toEqual([1, 0]);
    });
    test("a gate-closed leaf inside an ungated nested group does not strand its ready sibling", () => {
        const nested = (gate) => ({
            id: "r",
            targets: [flash, mimo],
            targetVariants: [],
            health: ModelRoute.policy(),
            nodes: [
                {
                    selection: "ordered",
                    weights: [1, 1],
                    children: [{ node: 1 }, { leaf: 1 }],
                },
                { selection: "ordered", weights: [1], children: [{ leaf: 0, gate }] },
            ],
        });
        const closed = nested({ name: "peak", window: tomorrow });
        expect(ModelRoute.nextTarget(closed, ready, new Set(), undefined, false)).toBe(1);
        expect(ModelRoute.orderTargets(closed, ready, undefined, false)).toEqual([1]);
        // The same shape with the inner gate open resolves the inner leaf first.
        expect(ModelRoute.orderTargets(nested({ name: "peak", window: always }), ready, undefined, false)).toEqual([0, 1]);
        // An inverted gate on an always-active window is closed at every depth too.
        expect(ModelRoute.orderTargets(nested({ name: "peak", window: always, invert: true }), ready, undefined, false)).toEqual([1]);
    });
    test("a fully gate-closed route still returns no target", () => {
        const route = {
            id: "r",
            targets: [flash, mimo],
            targetVariants: [],
            health: ModelRoute.policy(),
            nodes: [
                {
                    selection: "ordered",
                    weights: [1, 1],
                    children: [{ node: 1 }, { leaf: 1, gate: { name: "peak", window: tomorrow } }],
                },
                {
                    selection: "ordered",
                    weights: [1],
                    children: [{ leaf: 0, gate: { name: "peak", window: tomorrow } }],
                },
            ],
        };
        expect(ModelRoute.nextTarget(route, ready, new Set(), undefined, false)).toBeUndefined();
        expect(ModelRoute.orderTargets(route, ready, undefined, false)).toEqual([]);
    });
    test("a closed gate on a leaf removes only that leaf", () => {
        const route = {
            id: "r",
            targets: [flash, mimo],
            targetVariants: [],
            health: ModelRoute.policy(),
            nodes: [
                {
                    selection: "ordered",
                    weights: [1, 1],
                    children: [{ leaf: 0, gate: { name: "peak", window: tomorrow } }, { leaf: 1 }],
                },
            ],
        };
        expect(ModelRoute.orderTargets(route, ready, undefined, false)).toEqual([1]);
    });
});
describe("ModelRoute per-target context limits", () => {
    const limited = (targetLimits, routeCap) => ({
        id: "r",
        targets: targetLimits.map((_, index) => ModelRoute.ref({ providerID: "p", model: `m${index}` })),
        targetVariants: [],
        health: ModelRoute.policy(),
        ...(routeCap !== undefined ? { limit: { context: routeCap } } : {}),
        ...(targetLimits.some((item) => item !== undefined)
            ? { targetLimits: targetLimits.map((item) => item ?? {}) }
            : {}),
        nodes: [
            {
                selection: "ordered",
                weights: targetLimits.map(() => 1),
                children: targetLimits.map((_, index) => ({ leaf: index })),
            },
        ],
    });
    test("contextCeiling is the smaller of the route cap and the leaf ceiling", () => {
        expect(ModelRoute.contextCeiling(limited([]), 0)).toBeUndefined();
        expect(ModelRoute.contextCeiling(limited([undefined], 100000), 0)).toBe(100000);
        expect(ModelRoute.contextCeiling(limited([{ context: 200000 }]), 0)).toBe(200000);
        expect(ModelRoute.contextCeiling(limited([{ context: 200000 }], 100000), 0)).toBe(100000);
        expect(ModelRoute.contextCeiling(limited([{ context: 100000 }], 200000), 0)).toBe(100000);
    });
    test("overLimit skips a request that fits neither ceiling, and never filters an unknown size", () => {
        const both = limited([{ context: 200000 }], 100000);
        expect(ModelRoute.overLimit(both, 0, undefined)).toBe(false);
        expect(ModelRoute.overLimit(both, 0, 100000)).toBe(false);
        expect(ModelRoute.overLimit(both, 0, 100001)).toBe(true);
        // The route cap binds even though the leaf ceiling is larger.
        expect(ModelRoute.overLimit(limited([{ context: 200000 }], 100000), 0, 150000)).toBe(true);
        // The leaf ceiling binds even though the route cap is larger.
        expect(ModelRoute.overLimit(limited([{ context: 200000 }], 300000), 0, 250000)).toBe(true);
        expect(ModelRoute.overLimit(limited([{ context: 200000 }], 300000), 0, 150000)).toBe(false);
        // A leaf with no ceiling always fits, with or without a route cap elsewhere.
        expect(ModelRoute.overLimit(limited([undefined], 100000), 0, 90000)).toBe(false);
        expect(ModelRoute.overLimit(limited([undefined]), 0, 10000000)).toBe(false);
    });
    test("a definition with limits survives the settings round trip", () => {
        const built = limited([{ context: 100000 }, {}], 200000);
        const info = {
            providerID: ModelRoute.PROVIDER_ID,
            id: "r",
            settings: { [ModelRoute.SETTING]: built },
        };
        const decoded = ModelRoute.definition(info);
        expect(decoded?.limit).toEqual({ context: 200000 });
        expect(decoded?.targetLimits).toEqual([{ context: 100000 }, {}]);
    });
});
describe("ModelRoute round-robin tiers (#1122)", () => {
    const policy = ModelRoute.policy();
    const leaf = (model) => ModelRoute.ref({ providerID: "tiers-p", model });
    const flat = (id, weights, targets) => ({
        id,
        targets,
        targetVariants: [],
        health: policy,
        nodes: [{ selection: "round-robin", weights, children: targets.map((_, index) => ({ leaf: index })) }],
    });
    const head = (route, ready, session) => ModelRoute.nextTarget(route, ready, new Set(), session, true);
    test("a single tier rotates evenly across sessions, as plain round-robin always did", () => {
        const route = flat("tier-single", [1, 1, 1], [leaf("a"), leaf("b"), leaf("c")]);
        const all = new Set([0, 1, 2]);
        const heads = ["s1", "s2", "s3", "s4", "s5", "s6"].map((session) => head(route, all, session));
        expect(heads).toEqual([0, 1, 2, 0, 1, 2]);
    });
    test("the lower tier is never drawn while any top-tier member is ready", () => {
        const route = flat("tier-two", [2, 2, 1], [leaf("a"), leaf("b"), leaf("c")]);
        const all = new Set([0, 1, 2]);
        const heads = ["s1", "s2", "s3", "s4"].map((session) => head(route, all, session));
        expect(heads).toEqual([0, 1, 0, 1]);
        // The session-less walk order is the tier order too: both weight-2 leaves before the weight-1.
        expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([0, 1, 2]);
        const walked = ModelRoute.orderTargets(route, all, "sx", true);
        expect([...walked.slice(0, 2)].sort()).toEqual([0, 1]);
        expect(walked[2]).toBe(2);
    });
    test("the next tier engages once every member above it has failed or left", () => {
        const route = flat("tier-fall", [2, 2, 1], [leaf("a"), leaf("b"), leaf("c")]);
        // Top tier unavailable: the weight-1 leaf serves.
        expect(head(route, new Set([2]), "down")).toBe(2);
        // Top tier tried within this dispatch: the walk falls through instead of retrying it.
        expect(ModelRoute.nextTarget(route, new Set([0, 1, 2]), new Set([0, 1]), "walk", true)).toBe(2);
    });
    test("a session stuck to a lower tier returns to the top tier when it recovers", () => {
        const route = flat("tier-sticky", [2, 1], [leaf("a"), leaf("b")]);
        expect(head(route, new Set([1]), "s1")).toBe(1);
        // The top tier is back: the sticky pick in the lower tier no longer binds the session.
        expect(head(route, new Set([0, 1]), "s1")).toBe(0);
        expect(ModelRoute.sessionTarget("tier-sticky#0", "s1")).toBe(0);
    });
    test("rotation persists across dispatches inside the tier, wrapping instead of falling through", () => {
        const route = flat("tier-cycle", [2, 2, 2, 1], [leaf("a"), leaf("b"), leaf("c"), leaf("d")]);
        const all = new Set([0, 1, 2, 3]);
        const heads = ["s1", "s2", "s3", "s4", "s5", "s6"].map((session) => head(route, all, session));
        expect(heads).toEqual([0, 1, 2, 0, 1, 2]);
    });
    test("an unset weight lands in the same tier as weight 1", () => {
        // Only the first target lists a weight; the other two default to 1.
        const route = flat("tier-default", [2], [leaf("a"), leaf("b"), leaf("c")]);
        const all = new Set([0, 1, 2]);
        expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([0, 1, 2]);
        // The lone weight-2 target is the whole top tier, so every session starts there.
        expect(head(route, all, "s1")).toBe(0);
        expect(head(route, all, "s2")).toBe(0);
        // With it gone, the two default-weight targets rotate evenly between themselves.
        const rest = new Set([1, 2]);
        const heads = ["t1", "t2", "t3", "t4"].map((session) => head(route, rest, session));
        expect(heads).toEqual([1, 2, 1, 2]);
    });
    test("a quota-demoted leaf sorts below every live tier, whatever its weight, and still serves last", () => {
        const heavy = leaf("heavy");
        const route = flat("tier-demoted", [100, 2, 1], [heavy, leaf("mid"), leaf("low")]);
        const now = Date.now();
        for (const at of [now, now + 1000, now + 2000])
            ModelRoute.failed(heavy, policy, at, { quota: true });
        expect(ModelRoute.demoted(heavy)).toBe(true);
        const all = new Set([0, 1, 2]);
        // Weight order among the live tiers (2 before 1); the demoted 100 goes last — the old 0.01
        // factor would have tied it with the weight-1 leaf in configured order, [1, 0, 2].
        expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([1, 2, 0]);
        // Draws stay in the live tiers while any of them can serve...
        expect(head(route, all, "d1")).toBe(1);
        expect(ModelRoute.nextTarget(route, all, new Set([1]), "d2", true)).toBe(2);
        // ...and the demoted leaf is the last resort, not a refusal.
        expect(ModelRoute.nextTarget(route, all, new Set([1, 2]), "d3", true)).toBe(0);
    });
    test("a nested route reference is a tier member with its group weight", () => {
        const targets = [leaf("a"), leaf("b"), leaf("c")];
        const build = (weights) => ({
            id: "tier-nested",
            targets,
            targetVariants: [],
            health: policy,
            nodes: [
                { selection: "round-robin", weights, children: [{ node: 1 }, { leaf: 2 }] },
                {
                    routeID: "inner",
                    selection: "round-robin",
                    weights: [1, 1],
                    children: [{ leaf: 0 }, { leaf: 1 }],
                },
            ],
        });
        const all = new Set([0, 1, 2]);
        // Group at weight 2 over the weight-1 leaf: sessions rotate inside the group, leaf 2 waits.
        const grouped = build([2, 1]);
        const heads = ["g1", "g2", "g3", "g4"].map((session) => head(grouped, all, session));
        expect(heads).toEqual([0, 1, 0, 1]);
        expect(ModelRoute.orderTargets(grouped, all, undefined, false)).toEqual([0, 1, 2]);
        expect(head(grouped, new Set([2]), "only")).toBe(2);
        // Leaf at weight 2 over the weight-1 group: the leaf is the top tier now.
        ModelRoute.resetSelection();
        const leafFirst = build([1, 2]);
        expect(head(leafFirst, all, "top")).toBe(2);
        expect(ModelRoute.orderTargets(leafFirst, all, undefined, false)).toEqual([2, 0, 1]);
    });
    test("float-noise tier weights share one tier: an averaged group rotates with its equal leaf (#1421)", () => {
        const targets = [leaf("a"), leaf("b"), leaf("c"), leaf("d")];
        const route = {
            id: "tier-float",
            targets,
            targetVariants: [],
            health: policy,
            nodes: [
                {
                    selection: "round-robin",
                    weights: [1, 1],
                    schedules: [{ factor: 0.1 }],
                    children: [{ node: 1 }, { leaf: 3 }],
                },
                {
                    routeID: "inner",
                    selection: "round-robin",
                    weights: [1, 1, 1],
                    children: [{ leaf: 0 }, { leaf: 1 }, { leaf: 2 }],
                },
            ],
        };
        const all = new Set([0, 1, 2, 3]);
        ModelRoute.resetSelection();
        // The group averages (0.1 + 0.1 + 0.1) / 3 = 0.10000000000000002 while the
        // direct leaf sits at exactly 0.1: computation noise must not split the tier.
        const heads = ["f1", "f2", "f3", "f4", "f5", "f6"].map((session) => head(route, all, session));
        expect(heads).toEqual([0, 3, 1, 3, 2, 3]);
    });
    test("a group whose every door is demoted drops below the live tiers as one demoted member", () => {
        const a = leaf("ga");
        const b = leaf("gb");
        const route = {
            id: "tier-group-demoted",
            targets: [a, b, leaf("gc")],
            targetVariants: [],
            health: policy,
            nodes: [
                { selection: "round-robin", weights: [2, 1], children: [{ node: 1 }, { leaf: 2 }] },
                { routeID: "inner", selection: "round-robin", weights: [1, 1], children: [{ leaf: 0 }, { leaf: 1 }] },
            ],
        };
        const now = Date.now();
        for (const target of [a, b])
            for (const at of [now, now + 1000, now + 2000])
                ModelRoute.failed(target, policy, at, { quota: true });
        const all = new Set([0, 1, 2]);
        // The weight-2 group is demoted as a unit: the weight-1 leaf leads, the group serves after.
        expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([2, 0, 1]);
        expect(head(route, all, "gd")).toBe(2);
    });
});
describe("ModelRoute provider route groups", () => {
    const policy = ModelRoute.policy();
    const alt = ModelRoute.ref({ providerID: "route-alt", model: "m" });
    const main = ModelRoute.ref({ providerID: "route-main", model: "m" });
    const build = (selection, weights = [1, 1]) => ({
        id: "outer-route",
        targets: [alt, main],
        targetVariants: [],
        health: policy,
        nodes: [
            { selection: "ordered", weights: [1], children: [{ node: 1 }] },
            { routeID: "plan", providerRoute: "plan", selection, weights, children: [{ leaf: 0 }, { leaf: 1 }] },
        ],
    });
    const all = new Set([0, 1]);
    const demote = (target) => {
        const now = Date.now();
        for (const at of [now, now + 1000, now + 2000])
            ModelRoute.failed(target, policy, at, { quota: true });
        expect(ModelRoute.demoted(target)).toBe(true);
    };
    test("ordered: the first ready member serves, and an unavailable member falls through", () => {
        const route = build("ordered");
        expect(ModelRoute.nextTarget(route, all, new Set(), "s1", true)).toBe(0);
        // The resolver expresses a benched member by leaving it out of the ready set.
        expect(ModelRoute.nextTarget(route, new Set([1]), new Set(), "s2", true)).toBe(1);
        expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([0, 1]);
    });
    test("ordered: a quota-demoted member drops behind the live member and still serves last", () => {
        demote(alt);
        const route = build("ordered");
        expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([1, 0]);
        expect(ModelRoute.nextTarget(route, all, new Set(), "d1", true)).toBe(1);
        expect(ModelRoute.nextTarget(route, all, new Set([1]), "d2", true)).toBe(0);
    });
    test("round-robin: a quota-demoted member sorts below the live tier inside the group", () => {
        demote(alt);
        const route = build("round-robin", [2, 1]);
        // Alt outweighs main 2:1, but demotion holds it below the live tier: main serves,
        // and the demoted member remains the last resort rather than a refusal.
        expect(ModelRoute.nextTarget(route, all, new Set(), "r1", true)).toBe(1);
        expect(ModelRoute.nextTarget(route, all, new Set([1]), "r2", true)).toBe(0);
        expect(ModelRoute.orderTargets(route, all, undefined, false)).toEqual([1, 0]);
    });
    test("the decision records show the provider route resolution: the group under its own id, the member it chose", () => {
        const events = [];
        ModelRouteLog.setSink((event) => events.push(event));
        try {
            expect(ModelRoute.nextTarget(build("ordered"), all, new Set(), "dec-session", true)).toBe(0);
        }
        finally {
            ModelRouteLog.setSink(undefined);
        }
        const decisions = events.flatMap((event) => (event.kind === "decision" ? [event.row] : []));
        const inner = decisions.find((row) => row.route_id === "plan");
        expect(inner?.candidates).toEqual(["route-alt/m", "route-main/m"]);
        expect(inner?.chosen).toBe("route-alt/m");
        const outer = decisions.find((row) => row.route_id === "outer-route");
        expect(outer?.candidates).toEqual(["plan/m"]);
        expect(outer?.chosen).toBe("plan/m");
    });
});
describe("ModelRoute machinery constants (experimental.model_route_settings)", () => {
    const target = ModelRoute.ref({ providerID: "openai", model: "gpt-6-sol" });
    const policy = ModelRoute.policy({ cooldownMs: 60000 });
    afterEach(() => {
        ModelRoute.onSettingsConfig(() => undefined);
        ModelRoute.configureConstants(ModelRoute.DEFAULT_CONSTANTS);
        ModelRoute.configure({
            escalation: { enabled: true, afterGiveUps: 2 },
            quota: { demoteAfter: 3, windowMs: 4 * 3600000 },
        });
    });
    test("the resolved defaults are exactly the machinery's named constants", () => {
        expect(ModelRoute.currentConstants()).toEqual({
            bench: {
                maxCooldownMs: 86400000,
                multiplier: 2,
                failureCapMs: 120000,
                retryAfterMinMs: 1000,
                cooldownCapMs: 3600000,
                quotaCooldownCapMs: 86400000,
                longBenchMs: 900000,
                sustainedRateLimitFailures: 3,
            },
            demotion: { factor: 0.01 },
            quotaGate: {
                maxMs: 30 * 86400000,
                fallbackMs: 30 * 60000,
                feedTtlMs: 60000,
                balanceDeadThreshold: 0.1,
                rootStartMaxPct: 85,
                rootStartEnabled: true,
            },
            escalation: { outcomeWindow: 5 },
            network: { windowMs: 30000, providers: 3, providerModels: 2 },
            membership: { waitMs: 5000 },
            continuity: { hedgeRequests: 2 },
            overrides: { preferredFactor: 3 },
        });
        expect(ModelRoute.currentConstants()).toEqual(ModelRoute.DEFAULT_CONSTANTS);
    });
    test("the bench ladder doubles to the failure cap by default, and stops at a configured cap", () => {
        const now = 1000000;
        ModelRoute.failed(target, policy, now);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 60000);
        ModelRoute.failed(target, policy, now);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 120000);
        // A third ordinary failure would double to 240s; the failure cap holds the grace at
        // 120s instead -- the short grace of Drew's failover spec (#2212).
        ModelRoute.failed(target, policy, now);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 120000);
        ModelRoute.resetHealth();
        ModelRoute.configureConstants({ bench: { maxCooldownMs: 5000 } });
        ModelRoute.failed(target, policy, now);
        // A bench that would run a full minute stops at the configured cap.
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 5000);
    });
    test("the failure cap is configurable, and quota benches are not bounded by it", () => {
        const now = 5000000;
        ModelRoute.configureConstants({ bench: { failureCapMs: 300000 } });
        for (let i = 0; i < 6; i++)
            ModelRoute.failed(target, policy, now);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 300000);
        ModelRoute.resetHealth();
        // A quota failure starts from the long bench and keeps doubling past the failure
        // cap: the provider stated the window, so its bench is bounded by the stated reset
        // and the 24h cap, not by the ordinary failure grace.
        ModelRoute.failed(target, policy, now, { quota: true });
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 900000);
        ModelRoute.failed(target, policy, now, { quota: true });
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 1800000);
    });
    test("a fractional bench multiplier keeps growing past the old exponent limit until it reaches the cap", () => {
        const now = 3000000;
        const quick = ModelRoute.policy({ cooldownMs: 60000 });
        ModelRoute.configureConstants({ bench: { multiplier: 1.1, failureCapMs: 86400000 } });
        Array.from({ length: 32 }, () => ModelRoute.failed(target, quick, now));
        expect(ModelRoute.cooldownUntil(target, now)).toBeGreaterThan(now + 60000 * 1.1 ** 30);
        Array.from({ length: 50 }, () => ModelRoute.failed(target, quick, now));
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 86400000);
        ModelRoute.resetHealth();
        ModelRoute.configureConstants({ bench: { multiplier: 1 } });
        Array.from({ length: 40 }, () => ModelRoute.failed(target, quick, now));
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 60000);
    });
    test("the bench multiplier and the caps on the health bases are configurable", () => {
        const quick = ModelRoute.policy({ cooldownMs: 1000 });
        const now = 2000000;
        ModelRoute.configureConstants({ bench: { multiplier: 3 } });
        ModelRoute.failed(target, quick, now);
        ModelRoute.failed(target, quick, now);
        ModelRoute.failed(target, quick, now);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 9000);
        expect(ModelRoute.policy({ cooldownMs: 999999999 }).cooldownMs).toBe(3600000);
        expect(ModelRoute.policy({ quotaCooldownMs: 999999999 }).quotaCooldownMs).toBe(86400000);
        ModelRoute.configureConstants({ bench: { cooldownCapMs: 120000, quotaCooldownCapMs: 7200000 } });
        expect(ModelRoute.policy({ cooldownMs: 999999999 }).cooldownMs).toBe(120000);
        expect(ModelRoute.policy({ quotaCooldownMs: 999999999 }).quotaCooldownMs).toBe(7200000);
    });
    test("demotion threshold and factor are configurable", () => {
        const now = Date.now();
        ModelRoute.configureConstants({ demotion: { factor: 0.5 } });
        ModelRoute.configure({ quota: { demoteAfter: 2 } });
        ModelRoute.failed(target, policy, now, { quota: true });
        expect(ModelRoute.demoted(target, now + 1)).toBe(false);
        ModelRoute.failed(target, policy, now + 1, { quota: true });
        expect(ModelRoute.demoted(target, now + 2)).toBe(true);
        expect(ModelRoute.weightOf(target, 2, now + 2)).toBe(1);
    });
    test("the quota gate believes a stated reset up to the cap and falls back when none is stated", () => {
        const now = 100000000;
        ModelRoute.observeQuotaFailure(target, "settings-cred-a", now + 90 * 86400000, now);
        expect(ModelRoute.credentialQuotaBlocked("settings-cred-a", now)?.until).toBe(now + 30 * 86400000);
        ModelRoute.observeQuotaFailure(target, "settings-cred-b", undefined, now);
        expect(ModelRoute.credentialQuotaBlocked("settings-cred-b", now)?.until).toBe(now + 30 * 60000);
    });
    test("the root-start threshold is configurable through quota gate settings (#566)", () => {
        ModelRoute.onSettingsConfig(() => ({ quotaGate: { rootStartMaxPct: 70 } }));
        expect(ModelRoute.currentConstants().quotaGate.rootStartMaxPct).toBe(70);
        ModelRoute.onSettingsConfig(() => undefined);
        expect(ModelRoute.currentConstants().quotaGate.rootStartMaxPct).toBe(85);
    });
    test("the quota gate fallback and cap are configurable", () => {
        const now = 100000000;
        ModelRoute.configureConstants({ quotaGate: { fallbackMs: 10000, maxMs: 60000 } });
        ModelRoute.observeQuotaFailure(target, "settings-cred-c", undefined, now);
        expect(ModelRoute.credentialQuotaBlocked("settings-cred-c", now)?.until).toBe(now + 10000);
        ModelRoute.observeQuotaFailure(target, "settings-cred-d", now + 3600000, now);
        expect(ModelRoute.credentialQuotaBlocked("settings-cred-d", now)?.until).toBe(now + 60000);
    });
    test("the quota feed interval follows the gate constants", () => {
        ModelRoute.resetQuotaFeed();
        expect(ModelRoute.shouldFeedQuota(1000000)).toBe(true);
        expect(ModelRoute.shouldFeedQuota(1030000)).toBe(false);
        expect(ModelRoute.shouldFeedQuota(1061000)).toBe(true);
        ModelRoute.resetQuotaFeed();
        ModelRoute.configureConstants({ quotaGate: { feedTtlMs: 10000 } });
        expect(ModelRoute.shouldFeedQuota(2000000)).toBe(true);
        expect(ModelRoute.shouldFeedQuota(2005000)).toBe(false);
        expect(ModelRoute.shouldFeedQuota(2011000)).toBe(true);
    });
    test("the gathered pass keeps its own feed stamps, independent of the gate's (code#8086)", () => {
        ModelRoute.resetQuotaFeed();
        // The production sequence (resolveRouteWithin): the gate feeds first with the
        // resolution's `now`, the gathered pass runs immediately after with the same
        // `now`. On a shared stamp the second call was never due — the starved plant.
        expect(ModelRoute.shouldFeedQuota(5000000, "loc", "provider-x")).toBe(true);
        expect(ModelRoute.shouldFeedGatheredQuota(5000000, "loc", "provider-x")).toBe(true);
        // Each pass then throttles on its OWN stamp for the feed TTL...
        expect(ModelRoute.shouldFeedQuota(5030000, "loc", "provider-x")).toBe(false);
        expect(ModelRoute.shouldFeedGatheredQuota(5030000, "loc", "provider-x")).toBe(false);
        // ...and comes due again on its own stamp's TTL, independently of the other pass.
        expect(ModelRoute.shouldFeedGatheredQuota(5061000, "loc", "provider-x")).toBe(true);
        expect(ModelRoute.shouldFeedQuota(5061000, "loc", "provider-x")).toBe(true);
        // Per provider and location, exactly like the gate's stamps.
        expect(ModelRoute.shouldFeedGatheredQuota(5061000, "loc", "provider-y")).toBe(true);
        expect(ModelRoute.shouldFeedGatheredQuota(5061000, "other-loc", "provider-x")).toBe(true);
        ModelRoute.resetQuotaFeed();
        // The reset seam clears both stamp sets.
        expect(ModelRoute.shouldFeedGatheredQuota(5061000, "loc", "provider-x")).toBe(true);
        ModelRoute.resetQuotaFeed();
    });
    test("quota feeds are throttled per provider and location", () => {
        ModelRoute.resetQuotaFeed();
        expect(ModelRoute.shouldFeedQuota(1000000, "location-a", "provider-a")).toBe(true);
        expect(ModelRoute.shouldFeedQuota(1030000, "location-a", "provider-b")).toBe(true);
        expect(ModelRoute.shouldFeedQuota(1030000, "location-a", "provider-a")).toBe(false);
        expect(ModelRoute.shouldFeedQuota(1030000, "location-b", "provider-a")).toBe(true);
        expect(ModelRoute.shouldFeedQuota(1061000, "location-a", "provider-a")).toBe(true);
        expect(ModelRoute.shouldFeedQuota(1061000, "location-a", "provider-b")).toBe(false);
        ModelRoute.resetQuotaFeed();
    });
    test("the escalation outcome window is configurable", () => {
        const ok = { firstTokenMs: 10, responseMs: 20, tokensPerSecond: 50 };
        const other = ModelRoute.ref({ providerID: "openai", model: "gpt-6-terra" });
        // Default window (5): two give-ups still count after two successes.
        ModelRoute.failed(target, policy, 1000);
        ModelRoute.failed(target, policy, 2000);
        ModelRoute.completed(target, policy, ok, 3000);
        ModelRoute.completed(target, policy, ok, 4000);
        expect(ModelRoute.escalates(target)).toBe(true);
        // Window of 3: the successes push the older give-up out of the window.
        ModelRoute.configureConstants({ escalation: { outcomeWindow: 3 } });
        ModelRoute.failed(other, policy, 1000);
        ModelRoute.failed(other, policy, 2000);
        ModelRoute.completed(other, policy, ok, 3000);
        ModelRoute.completed(other, policy, ok, 4000);
        expect(ModelRoute.escalates(other)).toBe(false);
    });
    test("a valid pair at a small configured window escalates exactly at the effective threshold (#1163)", () => {
        const ok = { firstTokenMs: 10, responseMs: 20, tokensPerSecond: 50 };
        const off = ModelRoute.onSettingsConfig(() => ({ escalation: { afterGiveUps: 2, outcomeWindow: 2 } }), "/loc/small-window");
        try {
            ModelRoute.resetHealth();
            // One give-up in the window of 2: below the threshold of 2.
            ModelRoute.failed(target, policy, 1000, undefined, undefined, "/loc/small-window");
            expect(ModelRoute.escalates(target, undefined, "/loc/small-window")).toBe(false);
            // A success pushes the give-up out of the small window: give-up, success, give-up
            // leaves only one give-up in the last 2 outcomes, so still no escalation. (Under the
            // default window of 5 the count would be 2 and this would already escalate.)
            ModelRoute.completed(target, policy, ok, 2000, undefined, "/loc/small-window");
            ModelRoute.failed(target, policy, 3000, undefined, undefined, "/loc/small-window");
            expect(ModelRoute.escalates(target, undefined, "/loc/small-window")).toBe(false);
            // A second consecutive give-up fills the window at the threshold exactly
            // (afterGiveUps == outcomeWindow): escalation fires, so the equality pair is not inert.
            ModelRoute.failed(target, policy, 4000, undefined, undefined, "/loc/small-window");
            expect(ModelRoute.escalates(target, undefined, "/loc/small-window")).toBe(true);
        }
        finally {
            off();
        }
    });
    test("settings readers are scoped per Location, in either activation order", () => {
        const offA = ModelRoute.onSettingsConfig(() => ({ demotion: { after: 2, factor: 0.5 }, bench: { maxCooldownMs: 5000 }, escalation: { afterGiveUps: 4 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => ({ demotion: { after: 9, factor: 0.9 }, bench: { maxCooldownMs: 9000 }, escalation: { afterGiveUps: 7 } }), "/loc/b");
        try {
            // B activated last: before #1423 its reader would have governed A too.
            expect(ModelRoute.currentSettings("/loc/a").escalation.afterGiveUps).toBe(4);
            expect(ModelRoute.currentSettings("/loc/b").escalation.afterGiveUps).toBe(7);
            expect(ModelRoute.currentConstants("/loc/a").bench.maxCooldownMs).toBe(5000);
            expect(ModelRoute.currentConstants("/loc/b").bench.maxCooldownMs).toBe(9000);
            expect(ModelRoute.currentConstants("/loc/a").demotion.factor).toBe(0.5);
            // An unscoped read with two Locations registered cannot know which it serves:
            // it must fall back to the defaults rather than leak either Location's config.
            expect(ModelRoute.currentSettings().escalation.afterGiveUps).toBe(2);
            expect(ModelRoute.currentConstants()).toEqual(ModelRoute.DEFAULT_CONSTANTS);
        }
        finally {
            offA();
            offB();
        }
    });
    test("a Location with no settings block gets defaults without disturbing others", () => {
        const offA = ModelRoute.onSettingsConfig(() => ({ escalation: { afterGiveUps: 4 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => undefined, "/loc/b");
        try {
            expect(ModelRoute.currentSettings("/loc/b").escalation.afterGiveUps).toBe(2);
            expect(ModelRoute.currentSettings("/loc/a").escalation.afterGiveUps).toBe(4);
        }
        finally {
            offA();
            offB();
        }
    });
    test("behavior consumers judge with their own Location's settings, not the unscoped fallback (#1423)", () => {
        ModelRoute.resetHealth();
        const now = Date.now();
        ModelRoute.failed(target, policy, now);
        ModelRoute.failed(target, policy, now + 1);
        ModelRoute.failed(target, policy, now + 2, { quota: true });
        ModelRoute.failed(target, policy, now + 3, { quota: true });
        const offA = ModelRoute.onSettingsConfig(() => ({ escalation: { enabled: false, afterGiveUps: 2 }, demotion: { after: 2, factor: 0.5 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => ({ escalation: { enabled: true, afterGiveUps: 2 }, demotion: { after: 9, factor: 0.9 } }), "/loc/b");
        try {
            // Escalation: A switched it off, B left it on — each Location's step sees its own.
            expect(ModelRoute.escalates(target, undefined, "/loc/a")).toBe(false);
            expect(ModelRoute.escalates(target, undefined, "/loc/b")).toBe(true);
            // Quota demotion: two quota errors demote under A's threshold of 2, not B's 9.
            expect(ModelRoute.demoted(target, now + 10, undefined, "/loc/a")).toBe(true);
            expect(ModelRoute.demoted(target, now + 10, undefined, "/loc/b")).toBe(false);
            // Weights: the traced demotion layer uses the judging Location's factor.
            expect(ModelRoute.tracedWeightOf(target, 100, now + 10, { location: "/loc/a" }).demotion).toBe(50);
            expect(ModelRoute.tracedWeightOf(target, 100, now + 10, { location: "/loc/b" }).demotion).toBe(100);
        }
        finally {
            offA();
            offB();
        }
    });
    test("health recording keeps the judging Location's outcome window and bench ladder (#1423)", () => {
        const offA = ModelRoute.onSettingsConfig(() => ({ escalation: { afterGiveUps: 6, outcomeWindow: 10 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => ({ bench: { multiplier: 3, failureCapMs: 300000 } }), "/loc/b");
        try {
            // Six give-ups recorded for A: A's window (10) keeps all six, so A's
            // afterGiveUps (6) can actually trigger; the default window (5) would
            // have truncated the history before the threshold could accumulate.
            ModelRoute.resetHealth();
            for (let index = 0; index < 6; index++)
                ModelRoute.failed(target, policy, 1000000 + index, undefined, undefined, "/loc/a");
            expect(ModelRoute.escalates(target, undefined, "/loc/a")).toBe(true);
            // Bench ladder: B's multiplier (3) doubles — triples — the second bench.
            ModelRoute.resetHealth();
            const now = Date.now();
            ModelRoute.failed(target, policy, now, undefined, undefined, "/loc/b");
            ModelRoute.failed(target, policy, now, undefined, undefined, "/loc/b");
            expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 180000);
        }
        finally {
            offA();
            offB();
        }
    });
    test("quota-gate recording and evaluation use the owning Location's gate (#1423)", () => {
        const offA = ModelRoute.onSettingsConfig(() => ({ quotaGate: { fallbackMs: 60000 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => ({ quotaGate: { fallbackMs: 120000 } }), "/loc/b");
        try {
            ModelRoute.resetHealth();
            const now = Date.now();
            // A rate-limit exhaustion with no stated reset installs the fallback gate of
            // the Location whose attempt reported it — one minute for A, not the
            // compiled 30-minute default the unscoped read used once B registered.
            ModelRoute.observeQuotaFailure(target, "settings-cred-a", undefined, now, "rate-limit", "/loc/a");
            expect(ModelRoute.credentialQuotaBlocked("settings-cred-a", now, "/loc/a")).toEqual({ until: now + 60000 });
            ModelRoute.observeQuotaFailure(target, "settings-cred-b", undefined, now, "rate-limit", "/loc/b");
            expect(ModelRoute.credentialQuotaBlocked("settings-cred-b", now, "/loc/b")).toEqual({ until: now + 120000 });
        }
        finally {
            offA();
            offB();
        }
    });
    test("threshold-derived balance holds are judged under the judging Location's threshold (#1461)", () => {
        const offA = ModelRoute.onSettingsConfig(() => ({ quotaGate: { balanceDeadThreshold: 1 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => ({ quotaGate: { balanceDeadThreshold: 0.05 } }), "/loc/b");
        try {
            ModelRoute.resetHealth();
            const now = Date.now();
            const balance = {
                planID: "credits-plan",
                window: "credits",
                providerID: "openai",
                percent: 100,
                remaining: 0.5,
                resetAt: null,
                observedAt: now,
                stale: false,
                balance: true,
            };
            // Armed under A's threshold (1): a balance of 0.5 is dead for A, alive for B (0.05).
            ModelRoute.observeCredentialQuota(target, "loc-hold-cred", balance, now, "/loc/a");
            expect(ModelRoute.credentialQuotaBlocked("loc-hold-cred", now, "/loc/a")).toEqual({ until: null });
            expect(ModelRoute.credentialQuotaBlocked("loc-hold-cred", now, "/loc/b")).toBeUndefined();
            // The durable record carries the hold's threshold origin, not just its baseline.
            expect(ModelRoute.activeAdjustments(now).find((item) => item.id === "quota-credential:loc-hold-cred")
                ?.balanceHoldOrigin).toBe("threshold");
            // B feeding the same grant a lower balance corrects the retained snapshot:
            // 0.03 is dead under B's threshold too, so B is now blocked as well.
            ModelRoute.observeCredentialQuota(target, "loc-hold-cred", { ...balance, remaining: 0.03, observedAt: now + 1 }, now + 1, "/loc/b");
            expect(ModelRoute.credentialQuotaBlocked("loc-hold-cred", now + 1, "/loc/b")).toEqual({ until: null });
            expect(ModelRoute.credentialQuotaBlocked("loc-hold-cred", now + 1, "/loc/a")).toEqual({ until: null });
            // A fresh increase over the benched balance still releases the hold for everyone.
            ModelRoute.observeCredentialQuota(target, "loc-hold-cred", { ...balance, remaining: 2, observedAt: now + 2 }, now + 2, "/loc/b");
            expect(ModelRoute.credentialQuotaBlocked("loc-hold-cred", now + 2, "/loc/a")).toBeUndefined();
            expect(ModelRoute.credentialQuotaBlocked("loc-hold-cred", now + 2, "/loc/b")).toBeUndefined();
            // Attempt-reported exhaustion holds keep their unconditional force: installed
            // from a balance of 5, they block even the Location whose threshold admits 5.
            ModelRoute.resetHealth();
            ModelRoute.observeCredentialQuota(target, "attempt-cred", { ...balance, remaining: 5, observedAt: now }, now, "/loc/b");
            expect(ModelRoute.credentialQuotaBlocked("attempt-cred", now, "/loc/b")).toBeUndefined();
            ModelRoute.observeQuotaFailure(target, "attempt-cred", undefined, now + 1, "balance-exhaustion", "/loc/a");
            expect(ModelRoute.credentialQuotaBlocked("attempt-cred", now + 1, "/loc/a")).toEqual({ until: null });
            expect(ModelRoute.credentialQuotaBlocked("attempt-cred", now + 1, "/loc/b")).toEqual({ until: null });
            expect(ModelRoute.activeAdjustments(now + 1).find((item) => item.id === "quota-credential:attempt-cred")
                ?.balanceHoldOrigin).toBe("attempt");
            // A threshold hold restored from its durable record (no in-memory state) is
            // judged by its benched balance under the judging Location's threshold.
            ModelRoute.resetHealth();
            ModelRoute.setAdjustments([
                {
                    id: "quota-credential:restored-cred",
                    match: "credential:restored-cred",
                    action: "skip",
                    balanceBaseline: 0.5,
                    balanceGrant: "credits-plan\ncredits",
                    balanceHoldOrigin: "threshold",
                    credentialID: "restored-cred",
                    providerID: "openai",
                },
            ]);
            expect(ModelRoute.credentialQuotaBlocked("restored-cred", now, "/loc/a")).toEqual({ until: null });
            expect(ModelRoute.credentialQuotaBlocked("restored-cred", now, "/loc/b")).toBeUndefined();
            // Expiration is known-full regardless of the numeric threshold, including after
            // restoring the durable credential hold without a fresh quota feed.
            ModelRoute.setAdjustments([
                {
                    id: "quota-credential:expired-cred",
                    match: "credential:expired-cred",
                    action: "skip",
                    balanceBaseline: 5,
                    balanceGrant: "expired-plan\ncredits",
                    balanceHoldOrigin: "threshold",
                    balanceHoldExpired: true,
                    credentialID: "expired-cred",
                    providerID: "openai",
                },
            ]);
            expect(ModelRoute.credentialQuotaBlocked("expired-cred", now, "/loc/b")).toEqual({ until: null });
            // A tuning result computed under A's policy must not leak to B.
            ModelRoute.setAdjustments([
                {
                    id: "auto-quota:location-scoped",
                    match: `${target.providerID}/${target.id}`,
                    action: "skip",
                    location: "/loc/a",
                },
            ]);
            expect(ModelRoute.skipped(target, now, { location: "/loc/a" })).toBe(true);
            expect(ModelRoute.skipped(target, now, { location: "/loc/b" })).toBe(false);
        }
        finally {
            ModelRoute.setAdjustments([]);
            offA();
            offB();
        }
    });
    test("a restored threshold hold is judged by its latest judged balance, not its benched baseline (#1461)", () => {
        const offA = ModelRoute.onSettingsConfig(() => ({ quotaGate: { balanceDeadThreshold: 1 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => ({ quotaGate: { balanceDeadThreshold: 0.05 } }), "/loc/b");
        try {
            ModelRoute.resetHealth();
            const now = Date.now();
            const balance = {
                planID: "credits-plan",
                window: "credits",
                providerID: "openai",
                percent: 100,
                remaining: 0.5,
                resetAt: null,
                observedAt: now,
                stale: false,
                balance: true,
            };
            ModelRoute.observeCredentialQuota(target, "judged-cred", balance, now, "/loc/a");
            ModelRoute.observeCredentialQuota(target, "judged-cred", { ...balance, remaining: 0.03, observedAt: now + 1 }, now + 1, "/loc/b");
            expect(ModelRoute.credentialQuotaBlocked("judged-cred", now + 1, "/loc/b")).toEqual({ until: null });
            const durable = ModelRoute.activeAdjustments(now + 1).find((item) => item.id === "quota-credential:judged-cred");
            expect(durable?.balanceBaseline).toBe(0.5);
            expect(durable?.balanceHoldBalance).toBe(0.03);
            ModelRoute.resetHealth();
            ModelRoute.setAdjustments(durable ? [durable] : []);
            expect(ModelRoute.credentialQuotaBlocked("judged-cred", now + 1, "/loc/b")).toEqual({ until: null });
            expect(ModelRoute.credentialQuotaBlocked("judged-cred", now + 1, "/loc/a")).toEqual({ until: null });
        }
        finally {
            ModelRoute.setAdjustments([]);
            offA();
            offB();
        }
    });
    test("restored threshold holds keep tolerance, unknown-snapshot evidence, reactive timed gates, and timed provider skips (#1461)", () => {
        const offA = ModelRoute.onSettingsConfig(() => ({ quotaGate: { balanceDeadThreshold: 1 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => ({ quotaGate: { balanceDeadThreshold: 0.05 } }), "/loc/b");
        const offC = ModelRoute.onSettingsConfig(() => ({ quotaGate: { balanceDeadThreshold: 0.1 } }), "/loc/c");
        try {
            ModelRoute.resetHealth();
            const now = Date.now();
            const balance = {
                planID: "credits-plan",
                window: "credits",
                providerID: "openai",
                percent: 100,
                remaining: 0.5,
                resetAt: null,
                observedAt: now,
                stale: false,
                balance: true,
            };
            // Tolerance: a restored balance a rounding hair above the threshold
            // (0.4 - 0.3 = 0.10000000000000003 against 0.1) is still dead, as the live
            // gate judges it -- on both the credential and provider durable paths.
            ModelRoute.setAdjustments([
                {
                    id: "quota-credential:tol-cred",
                    match: "credential:tol-cred",
                    action: "skip",
                    balanceBaseline: 0.10000000000000003,
                    balanceHoldBalance: 0.10000000000000003,
                    balanceGrant: "credits-plan\ncredits",
                    balanceHoldOrigin: "threshold",
                    credentialID: "tol-cred",
                    providerID: "openai",
                },
            ]);
            expect(ModelRoute.credentialQuotaBlocked("tol-cred", now, "/loc/c")).toEqual({ until: null });
            const leafTol = ModelRoute.ref({ providerID: "prov-tol", model: "m" });
            ModelRoute.setAdjustments([
                {
                    id: "quota:prov-tol",
                    match: "prov-tol/",
                    action: "skip",
                    balanceBaseline: 0.10000000000000003,
                    balanceHoldBalance: 0.10000000000000003,
                    balanceHoldOrigin: "threshold",
                },
            ]);
            expect(ModelRoute.skipped(leafTol, now, { location: "/loc/c" })).toBe(true);
            // Unknown first snapshot after a restart: the restored hold's preserved
            // judged balance still governs -- A (threshold 1) stays blocked, B (0.05)
            // still admits -- instead of the unknown reading admitting everyone.
            ModelRoute.resetHealth();
            ModelRoute.setAdjustments([]);
            ModelRoute.observeCredentialQuota(target, "unknown-cred", balance, now, "/loc/a");
            const durableUnknown = ModelRoute.activeAdjustments(now).find((item) => item.id === "quota-credential:unknown-cred");
            ModelRoute.resetHealth();
            ModelRoute.setAdjustments(durableUnknown ? [durableUnknown] : []);
            ModelRoute.observeCredentialQuota(target, "unknown-cred", { ...balance, percent: null, remaining: null, observedAt: now + 1 }, now + 1, "/loc/b");
            expect(ModelRoute.credentialQuotaBlocked("unknown-cred", now + 1, "/loc/a")).toEqual({ until: null });
            expect(ModelRoute.credentialQuotaBlocked("unknown-cred", now + 1, "/loc/b")).toBeUndefined();
            // Reactive rate limit: B admits the held balance, but a plain rate limit
            // reported under B gates the credential until its stated reset anyway;
            // after the reset, B admits again while A stays balance-blocked.
            ModelRoute.resetHealth();
            ModelRoute.setAdjustments([]);
            ModelRoute.observeCredentialQuota(target, "timed-cred", balance, now, "/loc/a");
            expect(ModelRoute.credentialQuotaBlocked("timed-cred", now, "/loc/b")).toBeUndefined();
            ModelRoute.observeQuotaFailure(target, "timed-cred", now + 60000, now + 1, "rate-limit", "/loc/b");
            expect(ModelRoute.credentialQuotaBlocked("timed-cred", now + 1, "/loc/b")).toEqual({ until: now + 60000 });
            expect(ModelRoute.credentialQuotaBlocked("timed-cred", now + 60001, "/loc/b")).toBeUndefined();
            expect(ModelRoute.credentialQuotaBlocked("timed-cred", now + 60001, "/loc/a")).toEqual({ until: null });
            // Timed provider skips: two providers whose threshold holds B admits each
            // gain a timed attempt-reported skip; the exclusion lands on each
            // provider's own records \u2014 there is no pool verdict to count them together.
            ModelRoute.resetHealth();
            ModelRoute.setAdjustments([]);
            const leaf1 = ModelRoute.ref({ providerID: "prov-t1", model: "m" });
            const leaf2 = ModelRoute.ref({ providerID: "prov-t2", model: "m" });
            ModelRoute.observeProviderQuota(leaf1, { ...balance, providerID: "prov-t1" }, now, "/loc/a");
            ModelRoute.observeProviderQuota(leaf2, { ...balance, providerID: "prov-t2" }, now, "/loc/a");
            expect(ModelRoute.providerQuotaBlocked(leaf1, now, "/loc/b")).toBeUndefined();
            expect(ModelRoute.providerQuotaBlocked(leaf2, now, "/loc/b")).toBeUndefined();
            ModelRoute.observeQuotaFailure(leaf1, undefined, now + 60000, now + 1, "rate-limit", "/loc/b");
            ModelRoute.observeQuotaFailure(leaf2, undefined, now + 60000, now + 1, "rate-limit", "/loc/b");
            expect(ModelRoute.skipped(leaf1, now + 1, { location: "/loc/b" })).toBe(true);
            // The timed exclusion is carried by each provider's own skip record
            // (skipped above); the in-memory gate still shows only the threshold
            // hold, which blocks A and admits B.
            expect(ModelRoute.providerQuotaBlocked(leaf1, now + 1, "/loc/b")).toBeUndefined();
            expect(ModelRoute.providerQuotaBlocked(leaf1, now + 1, "/loc/a")).toEqual({ until: null });
            expect(ModelRoute.providerQuotaBlocked(leaf2, now + 1, "/loc/a")).toEqual({ until: null });
        }
        finally {
            ModelRoute.setAdjustments([]);
            offA();
            offB();
            offC();
        }
    });
    test("threshold-derived provider holds are judged under the requesting Location in skipped (#1461)", () => {
        const offA = ModelRoute.onSettingsConfig(() => ({ quotaGate: { balanceDeadThreshold: 1 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => ({ quotaGate: { balanceDeadThreshold: 0.05 } }), "/loc/b");
        try {
            ModelRoute.resetHealth();
            const now = Date.now();
            const leafA = ModelRoute.ref({ providerID: "prov-hold", model: "m1" });
            const balance = {
                planID: "credits-plan",
                window: "credits",
                providerID: "prov-hold",
                percent: 100,
                remaining: 0.5,
                resetAt: null,
                observedAt: now,
                stale: false,
                balance: true,
            };
            ModelRoute.observeProviderQuota(leafA, balance, now, "/loc/a");
            expect(ModelRoute.skipped(leafA, now, { location: "/loc/a" })).toBe(true);
            expect(ModelRoute.skipped(leafA, now, { location: "/loc/b" })).toBe(false);
            // The provider's own gate carries the same per-Location judgement: the
            // hold blocks its leaf under A and admits it under B. There is no
            // pool-level fact to consult \u2014 a pool cannot run out (Drew, 2026-11-07).
            expect(ModelRoute.providerQuotaBlocked(leafA, now, "/loc/a")).toEqual({ until: null });
            expect(ModelRoute.providerQuotaBlocked(leafA, now, "/loc/b")).toBeUndefined();
            const durable = ModelRoute.activeAdjustments(now).find((item) => item.id === "quota:prov-hold");
            expect(durable?.balanceHoldOrigin).toBe("threshold");
            ModelRoute.resetHealth();
            ModelRoute.setAdjustments(durable ? [durable] : []);
            expect(ModelRoute.skipped(leafA, now, { location: "/loc/a" })).toBe(true);
            expect(ModelRoute.skipped(leafA, now, { location: "/loc/b" })).toBe(false);
            // After a restart the durable record alone carries the judgement through
            // skipped(); no in-memory provider gate exists until the next fed snapshot.
            expect(ModelRoute.providerQuotaBlocked(leafA, now, "/loc/a")).toBeUndefined();
            expect(ModelRoute.providerQuotaBlocked(leafA, now, "/loc/b")).toBeUndefined();
        }
        finally {
            ModelRoute.setAdjustments([]);
            offA();
            offB();
        }
    });
    test("network-fault evaluation and origin hedging use the owning Location's constants (#1423)", () => {
        const offA = ModelRoute.onSettingsConfig(() => ({ network: { providers: 2 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => ({ network: { providers: 2 }, continuity: { hedgeRequests: 5 } }), "/loc/b");
        try {
            // Network forgiveness: two unrelated transport failures meet A's configured
            // providers threshold (2), so the first target's bench is cleared — the
            // default threshold (3) the unscoped read used would have kept it benched.
            ModelRoute.resetHealth();
            const now = Date.now();
            const first = ModelRoute.ref({ providerID: "p1", model: "m" });
            const second = ModelRoute.ref({ providerID: "p2", model: "m" });
            ModelRoute.failed(first, policy, now, { network: true }, undefined, "/loc/a");
            expect(ModelRoute.cooldownUntil(first, now + 1, "/loc/a")).toBeGreaterThan(now);
            ModelRoute.failed(second, policy, now + 1, { network: true }, undefined, "/loc/a");
            expect(ModelRoute.cooldownUntil(first, now + 2, "/loc/a")).toBe(0);
            // Origin hedging: B allows five away responses before the session settles,
            // so the origin is still offered after three — the default (2) would not.
            const origin = ModelRoute.ref({ providerID: "p", model: "a" });
            const away = ModelRoute.ref({ providerID: "p", model: "b" });
            ModelRoute.moved("r", "s-net", origin);
            ModelRoute.served("r", "s-net", away, "/loc/b");
            ModelRoute.served("r", "s-net", away, "/loc/b");
            ModelRoute.served("r", "s-net", away, "/loc/b");
            expect(ModelRoute.hedgeHome("r", "s-net", "/loc/b")).toBe("p/a");
        }
        finally {
            offA();
            offB();
        }
    });
    test("shared outcome history keeps each Location's window: retention is the union, evaluation is scoped (#1423)", () => {
        const offA = ModelRoute.onSettingsConfig(() => ({ escalation: { afterGiveUps: 6, outcomeWindow: 10 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => undefined, "/loc/b");
        try {
            ModelRoute.resetHealth();
            const ok = { firstTokenMs: 10, responseMs: 20, tokensPerSecond: 50 };
            for (let index = 0; index < 6; index++)
                ModelRoute.failed(target, policy, 2000000 + index, undefined, undefined, "/loc/a");
            // One success recorded through B (default window 5) must not erase the
            // history A (window 10) still judges by.
            ModelRoute.completed(target, policy, ok, 2000100, undefined, "/loc/b");
            expect(ModelRoute.giveUps(target, undefined, "/loc/a")).toBe(6);
            expect(ModelRoute.giveUps(target, undefined, "/loc/b")).toBe(4);
            expect(ModelRoute.escalates(target, undefined, "/loc/a")).toBe(true);
        }
        finally {
            offA();
            offB();
        }
    });
    test("quota-event and network histories retain the union of Location windows (#1423)", () => {
        const offA = ModelRoute.onSettingsConfig(() => ({ demotion: { after: 2, windowMs: 60000 }, network: { providers: 3, windowMs: 60000 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => ({ demotion: { windowMs: 1000 }, network: { windowMs: 1000 } }), "/loc/b");
        try {
            // Quota events: B's narrow window (1s) recording the second event must not
            // prune the first event A (60s window, threshold 2) still counts.
            ModelRoute.resetHealth();
            const now = Date.now();
            ModelRoute.failed(target, policy, now, { quota: true }, undefined, "/loc/a");
            ModelRoute.failed(target, policy, now + 2000, { quota: true }, undefined, "/loc/b");
            expect(ModelRoute.demoted(target, now + 2000, undefined, "/loc/a")).toBe(true);
            // Network history: failures through B must not prune A's longer window, so
            // the third unrelated failure still triggers A's outage forgiveness.
            ModelRoute.resetHealth();
            const first = ModelRoute.ref({ providerID: "p1", model: "m" });
            const second = ModelRoute.ref({ providerID: "p2", model: "m" });
            const third = ModelRoute.ref({ providerID: "p3", model: "m" });
            ModelRoute.failed(first, policy, now, { network: true }, undefined, "/loc/a");
            expect(ModelRoute.cooldownUntil(first, now + 1, "/loc/a")).toBeGreaterThan(now);
            ModelRoute.failed(second, policy, now + 2000, { network: true }, undefined, "/loc/b");
            ModelRoute.failed(third, policy, now + 3000, { network: true }, undefined, "/loc/a");
            expect(ModelRoute.cooldownUntil(first, now + 3001, "/loc/a")).toBe(0);
        }
        finally {
            offA();
            offB();
        }
    });
    test("network forgiveness clears only the failures inside the judging Location's window (#1423)", () => {
        const offA = ModelRoute.onSettingsConfig(() => ({ network: { windowMs: 60000 } }), "/loc/a");
        const offB = ModelRoute.onSettingsConfig(() => ({ network: { windowMs: 1000, providers: 2 } }), "/loc/b");
        try {
            ModelRoute.resetHealth();
            const now = Date.now();
            const old = ModelRoute.ref({ providerID: "p1", model: "m" });
            const fresh1 = ModelRoute.ref({ providerID: "p2", model: "m" });
            const fresh2 = ModelRoute.ref({ providerID: "p3", model: "m" });
            ModelRoute.failed(old, policy, now, { network: true }, undefined, "/loc/a");
            expect(ModelRoute.cooldownUntil(old, now + 1, "/loc/a")).toBeGreaterThan(now);
            // Ten seconds later B detects its own outage from two fresh failures; its
            // forgiveness must not reach back and clear A's older, unrelated bench,
            // even though the shared history retains that entry for A's window.
            ModelRoute.failed(fresh1, policy, now + 10000, { network: true }, undefined, "/loc/b");
            ModelRoute.failed(fresh2, policy, now + 10500, { network: true }, undefined, "/loc/b");
            expect(ModelRoute.cooldownUntil(fresh1, now + 10501, "/loc/b")).toBe(0);
            expect(ModelRoute.cooldownUntil(old, now + 10501, "/loc/a")).toBeGreaterThan(now + 10501);
        }
        finally {
            offA();
            offB();
        }
    });
    test("config feeds both layers at once, and behavior follows", () => {
        ModelRoute.onSettingsConfig(() => ({
            demotion: { after: 2, factor: 0.5 },
            bench: { maxCooldownMs: 5000 },
            escalation: { afterGiveUps: 4 },
        }));
        expect(ModelRoute.currentSettings()).toEqual({
            escalation: { enabled: true, afterGiveUps: 4 },
            quota: { demoteAfter: 2, windowMs: 4 * 3600000 },
        });
        expect(ModelRoute.currentConstants().bench.maxCooldownMs).toBe(5000);
        expect(ModelRoute.currentConstants().demotion.factor).toBe(0.5);
        const now = Date.now();
        ModelRoute.failed(target, policy, now);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 5000);
        ModelRoute.failed(target, policy, now, { quota: true });
        ModelRoute.failed(target, policy, now + 1, { quota: true });
        expect(ModelRoute.demoted(target, now + 2)).toBe(true);
        expect(ModelRoute.weightOf(target, 2, now + 2)).toBe(1);
    });
});
describe("ModelRoute demotion policy (experimental.model_route_demotion, #1151)", () => {
    const target = ModelRoute.ref({ providerID: "openai", model: "gpt-6-demotion" });
    const policy = ModelRoute.policy({ cooldownMs: 60000 });
    const quota = { quota: true };
    let offs = [];
    afterEach(() => {
        offs.forEach((off) => off());
        offs = [];
        ModelRoute.onSettingsConfig(() => undefined);
        ModelRoute.configure({
            escalation: { enabled: true, afterGiveUps: 2 },
            quota: { demoteAfter: 3, windowMs: 4 * 3600000 },
        });
    });
    test("unconfigured, the policy is exactly today's defaults", () => {
        expect(ModelRoute.DEFAULT_DEMOTION_POLICY).toEqual({ threshold: 3, windowMs: 14400000 });
        expect(ModelRoute.demotionPolicy()).toEqual({ threshold: 3, windowMs: 14400000 });
        expect(ModelRoute.demotionPolicy("/unconfigured-location")).toEqual({ threshold: 3, windowMs: 14400000 });
        // And the behaviour matches: two quota failures do not demote, the third does,
        // and a failure older than the 4h window no longer counts.
        const now = Date.now();
        ModelRoute.failed(target, policy, now, quota);
        ModelRoute.failed(target, policy, now + 1, quota);
        expect(ModelRoute.demoted(target, now + 2)).toBe(false);
        ModelRoute.failed(target, policy, now + 2, quota);
        expect(ModelRoute.demoted(target, now + 3)).toBe(true);
        expect(ModelRoute.demoted(target, now + 14400000 + 10)).toBe(false);
    });
    test("a configured threshold of 1 demotes after a single quota failure inside the window", () => {
        offs.push(ModelRoute.onDemotionConfig(() => ({ threshold: 1, windowMs: 60000 }), "/proj-a"));
        expect(ModelRoute.demotionPolicy("/proj-a")).toEqual({ threshold: 1, windowMs: 60000 });
        const now = Date.now();
        ModelRoute.failed(target, policy, now, quota);
        expect(ModelRoute.demoted(target, now + 1, undefined, "/proj-a")).toBe(true);
        // The same failure is outside the configured window an hour later.
        expect(ModelRoute.demoted(target, now + 3600000, undefined, "/proj-a")).toBe(false);
        // A Location with no registration keeps the defaults: one failure is not enough.
        expect(ModelRoute.demoted(target, now + 1, undefined, "/proj-unconfigured")).toBe(false);
    });
    test("failures outside the configured window do not count toward the threshold", () => {
        offs.push(ModelRoute.onDemotionConfig(() => ({ threshold: 2, windowMs: 1000 }), "/proj-b"));
        const now = Date.now();
        ModelRoute.failed(target, policy, now, quota);
        ModelRoute.failed(target, policy, now + 2000, quota);
        expect(ModelRoute.demoted(target, now + 2000, undefined, "/proj-b")).toBe(false);
        ModelRoute.failed(target, policy, now + 2500, quota);
        expect(ModelRoute.demoted(target, now + 2500, undefined, "/proj-b")).toBe(true);
    });
    test("two Locations with divergent thresholds each judge by their own policy", () => {
        offs.push(ModelRoute.onDemotionConfig(() => ({ threshold: 1 }), "/proj-strict"));
        offs.push(ModelRoute.onDemotionConfig(() => ({ threshold: 3 }), "/proj-lenient"));
        const now = Date.now();
        ModelRoute.failed(target, policy, now, quota);
        expect(ModelRoute.demoted(target, now + 1, undefined, "/proj-strict")).toBe(true);
        expect(ModelRoute.demoted(target, now + 1, undefined, "/proj-lenient")).toBe(false);
        // An unscoped read with several Locations registered cannot know which it serves,
        // so it falls back to the defaults rather than borrowing another Location's policy.
        expect(ModelRoute.demoted(target, now + 1)).toBe(false);
        ModelRoute.failed(target, policy, now + 1, quota);
        ModelRoute.failed(target, policy, now + 2, quota);
        expect(ModelRoute.demoted(target, now + 3, undefined, "/proj-lenient")).toBe(true);
        expect(ModelRoute.demoted(target, now + 3)).toBe(true);
    });
    test("an unscoped read follows the single registered Location (session and façade traffic alike)", () => {
        offs.push(ModelRoute.onDemotionConfig(() => ({ threshold: 1 }), "/only-proj"));
        const now = Date.now();
        ModelRoute.failed(target, policy, now, quota);
        expect(ModelRoute.demoted(target, now + 1)).toBe(true);
    });
    test("a wider configured window retains quota events the default window would prune", () => {
        offs.push(ModelRoute.onDemotionConfig(() => ({ threshold: 2, windowMs: 6 * 3600000 }), "/proj-wide"));
        const now = Date.now();
        ModelRoute.failed(target, policy, now, quota);
        ModelRoute.failed(target, policy, now + 5 * 3600000, quota);
        // Both failures are inside the configured 6h window, so the target demotes there —
        // under the default 4h window the first failure would not count.
        expect(ModelRoute.demoted(target, now + 5 * 3600000, undefined, "/proj-wide")).toBe(true);
        expect(ModelRoute.demoted(target, now + 5 * 3600000, undefined, "/proj-unconfigured")).toBe(false);
    });
    test("a Location registering later with a wider window still counts earlier quota events (#1699)", () => {
        const now = Date.now();
        // Two quota failures land while no wide-window Location is registered.
        ModelRoute.failed(target, policy, now, quota);
        ModelRoute.failed(target, policy, now + 1, quota);
        // A third failure five hours later is the pruning moment: under the old
        // record-time retention (the registered readers' union, 4h by default)
        // recording it discarded the first two events for good.
        ModelRoute.failed(target, policy, now + 5 * 3600000, quota);
        // Only now does the wider-window Location activate — no restart, so no
        // ledger re-seed can recover anything the live path pruned.
        offs.push(ModelRoute.onDemotionConfig(() => ({ threshold: 3, windowMs: 10 * 3600000 }), "/proj-late"));
        // All three failures are inside its 10h window, so it demotes.
        expect(ModelRoute.demoted(target, now + 5 * 3600000, undefined, "/proj-late")).toBe(true);
        // A narrower Location still judges only its own window over the retained
        // events: just the latest failure is inside the default 4h window, so
        // the wider retention does not demote for it.
        expect(ModelRoute.demoted(target, now + 5 * 3600000, undefined, "/proj-unconfigured")).toBe(false);
    });
    test("removing a Location's registration restores the defaults for it", () => {
        const off = ModelRoute.onDemotionConfig(() => ({ threshold: 1 }), "/proj-gone");
        off();
        expect(ModelRoute.demotionPolicy("/proj-gone")).toEqual({ threshold: 3, windowMs: 14400000 });
    });
});
describe("ModelRoute provider-route groups with no ready members", () => {
    const sibling = ModelRoute.ref({ providerID: "opendesign", model: "gpt-6-luna" });
    const groupNode = {
        routeID: "plan",
        providerRoute: "plan",
        selection: "ordered",
        weights: [],
        children: [],
    };
    const capture = () => {
        const events = [];
        ModelRouteLog.setSink((event) => events.push(event));
        return {
            stop: () => ModelRouteLog.setSink(undefined),
            decisions: () => events.flatMap((event) => (event.kind === "decision" ? [event.row] : [])),
        };
    };
    test("a leafless provider-route group appears in the parent decision's excluded list with a reason", () => {
        const definition = {
            id: "luna-plan",
            targets: [sibling],
            targetVariants: [],
            health: ModelRoute.policy(),
            nodes: [
                { selection: "round-robin", weights: [2.5, 1], children: [{ node: 1 }, { leaf: 0 }] },
                groupNode,
            ],
        };
        const cap = capture();
        try {
            expect(ModelRoute.nextTarget(definition, new Set([0]), new Set(), undefined, false)).toBe(0);
        }
        finally {
            cap.stop();
        }
        const parent = cap.decisions().find((row) => row.route_id === "luna-plan");
        expect(parent?.chosen).toBe("opendesign/gpt-6-luna");
        expect(parent?.detail?.excluded).toContainEqual({
            candidate: "plan",
            reason: "no-ready-members",
        });
    });
    test("a route whose only seat is a leafless group records the exclusion on its no-candidates decision", () => {
        const definition = {
            id: "terra-plan",
            targets: [],
            targetVariants: [],
            health: ModelRoute.policy(),
            nodes: [{ selection: "round-robin", weights: [1], children: [{ node: 1 }] }, groupNode],
        };
        const cap = capture();
        try {
            expect(ModelRoute.nextTarget(definition, new Set(), new Set(), undefined, false)).toBeUndefined();
        }
        finally {
            cap.stop();
        }
        const row = cap.decisions().find((item) => item.route_id === "terra-plan");
        expect(row?.reason).toBe("no-candidates");
        expect(row?.detail?.excluded).toContainEqual({
            candidate: "plan",
            reason: "no-ready-members",
        });
    });
});
describe("ModelRoute per-leg quota state (pool verdict abolished)", () => {
    const policy = ModelRoute.policy({ cooldownMs: 5000, quotaCooldownMs: 60000 });
    const leaves = [0, 1, 2].map((index) => ModelRoute.ref({ providerID: `pool-p${index}`, model: `m${index}` }));
    const outside = ModelRoute.ref({ providerID: "pool-outside", model: "solo" });
    test("quota benches on two leaves of one group never exclude a third, individually-clear leaf", () => {
        ModelRoute.resetHealth();
        const now = Date.now();
        ModelRoute.failed(leaves[0], policy, now, { quota: true });
        ModelRoute.failed(leaves[1], policy, now, { quota: true });
        // Each benched leaf is out on its own bench...
        expect(ModelRoute.cooldownUntil(leaves[0], now)).toBeGreaterThan(now);
        expect(ModelRoute.cooldownUntil(leaves[1], now)).toBeGreaterThan(now);
        // ...and the third leaf of the same group carries no exclusion of any kind:
        // no bench and no provider gate. A pool cannot run out (Drew, 2026-11-07) \u2014
        // only its leaves' own models, credentials, and providers can.
        expect(ModelRoute.cooldownUntil(leaves[2], now)).toBe(0);
        expect(ModelRoute.providerQuotaBlocked(leaves[2], now)).toBeUndefined();
        expect(ModelRoute.cooldownUntil(outside, now)).toBe(0);
        // Expiry re-admits each benched leaf on its own clock.
        expect(ModelRoute.cooldownUntil(leaves[0], now + 60001)).toBe(0);
        expect(ModelRoute.cooldownUntil(leaves[1], now + 60001)).toBe(0);
    });
    test("a provider's own quota state blocks every leaf it serves and no other provider's leaf", () => {
        ModelRoute.resetHealth();
        ModelRoute.setAdjustments([]);
        const now = Date.now();
        const resetAt = now + 3600000;
        // Two leaves share one provider; a third leaf sits on its own provider in
        // the same route group. Quota state is the provider's, so it covers
        // exactly the leaves that provider serves.
        const shared = [0, 1].map((index) => ModelRoute.ref({ providerID: "pool-shared", model: `s${index}` }));
        // Attempt-reported exhaustion from ONE model family lands model-scoped
        // (#1976): only the answering leaf is skipped — a sibling family on the
        // same provider keeps serving until its own answer corroborates.
        ModelRoute.observeQuotaFailure(shared[0], undefined, resetAt, now);
        expect(ModelRoute.skipped(shared[0], now)).toBe(true);
        expect(ModelRoute.skipped(shared[1], now)).toBe(false);
        expect(ModelRoute.skipped(leaves[2], now)).not.toBe(true);
        // The second family answering quota corroborates the hold to provider
        // scope: now the provider's own skip record blocks every leaf it serves.
        ModelRoute.observeQuotaFailure(shared[1], undefined, resetAt, now);
        expect(ModelRoute.skipped(shared[1], now)).toBe(true);
        expect(ModelRoute.skipped(leaves[2], now)).not.toBe(true);
        expect(ModelRoute.providerQuotaBlocked(shared[0], now)).toBeUndefined();
        // A fed known-full snapshot gates the provider in memory, for both leaves.
        ModelRoute.observeProviderQuota(shared[0], {
            planID: "plan",
            window: "weekly",
            providerID: "pool-shared",
            percent: 100,
            remaining: 0,
            resetAt,
            observedAt: now,
            stale: false,
        }, now);
        expect(ModelRoute.providerQuotaBlocked(shared[0], now)).toEqual({ until: resetAt });
        expect(ModelRoute.providerQuotaBlocked(shared[1], now)).toEqual({ until: resetAt });
        expect(ModelRoute.providerQuotaBlocked(leaves[2], now)).toBeUndefined();
        // The gate lifts on the provider's own reset clock.
        expect(ModelRoute.providerQuotaBlocked(shared[0], resetAt + 1)).toBeUndefined();
        expect(ModelRoute.skipped(shared[0], resetAt + 1)).not.toBe(true);
    });
    test("a shared credential's gate blocks through the credential scope only, never a provider scope", () => {
        ModelRoute.resetHealth();
        const now = Date.now();
        const resetAt = now + 3600000;
        ModelRoute.observeQuotaFailure(leaves[0], "cred-pool", resetAt, now);
        expect(ModelRoute.credentialQuotaBlocked("cred-pool", now)).toEqual({ until: resetAt });
        // The credential gate says nothing about any provider gate: a leaf keeps
        // whatever its own provider state says (here, nothing).
        expect(ModelRoute.providerQuotaBlocked(leaves[0], now)).toBeUndefined();
        expect(ModelRoute.credentialQuotaBlocked("cred-pool", resetAt + 1)).toBeUndefined();
    });
    test("a due probe does not outrank the leaf's own independent provider gate (#1390, #1473)", () => {
        ModelRoute.resetHealth();
        const now = Date.now();
        const resetAt = now + 5 * 3600000;
        const longPolicy = ModelRoute.policy({ cooldownMs: 60000, quotaCooldownMs: 900000 });
        const knownFull = (at, observedAt) => ({
            planID: "plan",
            window: "five-hours",
            providerID: "pool-p0",
            percent: 100,
            remaining: 0,
            resetAt: at,
            observedAt,
            stale: false,
        });
        // Bench the leaf on the escalated ladder, which runs far past the window
        // reset the provider feed then teaches it: a half-open probe comes due.
        for (let index = 0; index < 8; index++)
            ModelRoute.failed(leaves[0], longPolicy, now + index, { quota: true });
        ModelRoute.observeProviderQuota(leaves[0], knownFull(resetAt, now + 10), now + 10);
        expect(ModelRoute.probeDue(leaves[0], undefined, resetAt)).toBe(true);
        // A fresher independent gate on the same provider still blocks the leaf
        // itself: gates beat probes, judged per leaf, never via a pool verdict.
        ModelRoute.observeProviderQuota(leaves[0], knownFull(resetAt + 60000, resetAt), resetAt);
        expect(ModelRoute.providerQuotaBlocked(leaves[0], resetAt + 10)).toEqual({ until: resetAt + 60000 });
        expect(ModelRoute.providerQuotaBlocked(leaves[2], resetAt + 10)).toBeUndefined();
    });
});
describe("ModelRoute gathered quota wall: plant side and window aggregation (code#8086, #2036)", () => {
    const hour = 3600000;
    const gathered = (opts) => [
        {
            providerID: opts.providerID,
            measuredAt: opts.at,
            windows: (opts.windows ?? []).map((window) => ({
                name: window.name,
                usedPercent: window.usedPercent,
                resetAt: window.resetAt ?? null,
                measuredAt: opts.at,
            })),
            models: Object.fromEntries(Object.entries(opts.models ?? {}).map(([modelID, windows]) => [
                modelID,
                windows.map((window) => ({
                    name: window.name,
                    usedPercent: window.usedPercent,
                    resetAt: window.resetAt ?? null,
                    measuredAt: opts.at,
                })),
            ])),
        },
    ];
    test("a still-full window holds the skip in either serialization order (#2036)", () => {
        const now = 800000000;
        const leaf = ModelRoute.ref({ providerID: "opendesign", model: "claude-haiku-5.5" });
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(leaf, undefined, now + 3 * 86400000, now);
        expect(ModelRoute.skipped(leaf, now + 1)).toBe(true);
        const judgedAt = now + 15 * 60000;
        // The #2036 probe case: one measurement, two windows, the short window
        // still at 100%. Whichever window the snapshot serializes last, the skip
        // must stand — the judgement aggregates the measurement, it does not take
        // whichever window iterated last.
        for (const windows of [
            [
                { name: "weekly", usedPercent: 4, resetAt: now + 7 * 86400000 },
                { name: "5h", usedPercent: 100, resetAt: judgedAt + 5 * hour },
            ],
            [
                { name: "5h", usedPercent: 100, resetAt: judgedAt + 5 * hour },
                { name: "weekly", usedPercent: 4, resetAt: now + 7 * 86400000 },
            ],
        ]) {
            expect(ModelRoute.releaseQuotaSkipsForCurrent(leaf, gathered({ providerID: "opendesign", at: judgedAt, models: { "claude-haiku-5.5": windows } }), judgedAt)).toEqual([]);
            expect(ModelRoute.skipped(leaf, judgedAt + 1)).toBe(true);
        }
        // The both-headroom control still releases, in the same aggregated shape.
        expect(ModelRoute.releaseQuotaSkipsForCurrent(leaf, gathered({
            providerID: "opendesign",
            at: judgedAt + 60000,
            models: {
                "claude-haiku-5.5": [
                    { name: "weekly", usedPercent: 4, resetAt: now + 7 * 86400000 },
                    { name: "5h", usedPercent: 1, resetAt: judgedAt + 5 * hour },
                ],
            },
        }), judgedAt + 60000)).toEqual(["quota-model:opendesign:claude-haiku-5.5"]);
        expect(ModelRoute.skipped(leaf, judgedAt + 60001)).toBe(false);
    });
    test("a percent-less window in the freshest reading voids the release judgement (#2036)", () => {
        const now = 810000000;
        const leaf = ModelRoute.ref({ providerID: "opendesign", model: "claude-haiku-5.5" });
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(leaf, undefined, now + 3 * 86400000, now);
        const judgedAt = now + 15 * 60000;
        // One window reads headroom; the other carries no percent at all. The
        // percent-less window is missing evidence, not headroom: nothing lifts.
        expect(ModelRoute.releaseQuotaSkipsForCurrent(leaf, gathered({
            providerID: "opendesign",
            at: judgedAt,
            models: {
                "claude-haiku-5.5": [
                    { name: "weekly", usedPercent: 4, resetAt: now + 7 * 86400000 },
                    { name: "5h", usedPercent: null },
                ],
            },
        }), judgedAt)).toEqual([]);
        expect(ModelRoute.skipped(leaf, judgedAt + 1)).toBe(true);
    });
    test("a gathered 100% reading plants the wall pre-attempt, and a later room reading lifts it (code#8086)", () => {
        const now = 820000000;
        // The antigravity shape: per-model windows in the gathered snapshot.
        const leaf = ModelRoute.ref({ providerID: "antigravity-direct", model: "gemini-3.8-flash" });
        ModelRoute.resetHealth();
        // No attempt has failed — nothing is skipped before the plant.
        expect(ModelRoute.skipped(leaf, now)).toBe(false);
        const resetAt = now + 3 * 86400000;
        const planted = ModelRoute.plantGatheredQuotaWall(leaf, gathered({
            providerID: "antigravity-direct",
            at: now,
            models: { "gemini-3.8-flash": [{ name: "weekly", usedPercent: 100, resetAt }] },
        }), now);
        expect(planted).toBe("quota-model:antigravity-direct:gemini-3.8-flash");
        // The wall holds the leg out of selection until the gathered reset...
        expect(ModelRoute.skipped(leaf, now + 1)).toBe(true);
        expect(ModelRoute.skipped(leaf, resetAt - 1)).toBe(true);
        // ...and the moment a later snapshot shows the window below full, the leg
        // is eligible again — no attempt spent, no probe sent, no record surgery.
        const lifted = ModelRoute.plantGatheredQuotaWall(leaf, gathered({
            providerID: "antigravity-direct",
            at: now + 15 * 60000,
            models: { "gemini-3.8-flash": [{ name: "weekly", usedPercent: 12, resetAt: resetAt + 7 * 86400000 }] },
        }), now + 15 * 60000);
        expect(lifted).toBe("quota-model:antigravity-direct:gemini-3.8-flash");
        expect(ModelRoute.skipped(leaf, now + 15 * 60000 + 1)).toBe(false);
    });
    test("a provider-window wall plants from the provider's single entry (the cline-pass shape, code#8086)", () => {
        const now = 830000000;
        // The cline-pass shape: no per-model readings at all — the provider's own
        // windows are the wall. The first lane's residual: the weekly window read
        // 100% for days while fresh sessions kept drawing the leg.
        const leaf = ModelRoute.ref({ providerID: "cline-pass", model: "deepseek-v4.1-flash" });
        const sibling = ModelRoute.ref({ providerID: "cline-pass", model: "another-model" });
        ModelRoute.resetHealth();
        const resetAt = now + 3 * 86400000;
        const reading = (weekly, at) => gathered({
            providerID: "cline-pass",
            at,
            windows: [
                { name: "5h", usedPercent: 0, resetAt: at + 5 * hour },
                { name: "weekly", usedPercent: weekly, resetAt },
                { name: "monthly", usedPercent: 50, resetAt: now + 26 * 86400000 },
            ],
        });
        expect(ModelRoute.plantGatheredQuotaWall(leaf, reading(100, now), now)).toBe("quota-model:cline-pass:deepseek-v4.1-flash");
        expect(ModelRoute.skipped(leaf, now + 1)).toBe(true);
        expect(ModelRoute.skipped(leaf, resetAt - 1)).toBe(true);
        // The plant is per target: the sibling model is planted by its own feed,
        // not by a synthesized provider-wide verdict.
        expect(ModelRoute.skipped(sibling, now + 1)).toBe(false);
        // Room on every window lifts the plant on the reading's word alone.
        expect(ModelRoute.plantGatheredQuotaWall(leaf, reading(40, now + 15 * 60000), now + 15 * 60000)).toBe("quota-model:cline-pass:deepseek-v4.1-flash");
        expect(ModelRoute.skipped(leaf, now + 15 * 60000 + 1)).toBe(false);
    });
    test("below 1% remaining alone is a warning: no wall without quota-class failures (#2256)", () => {
        const now = 840000000;
        // The Command Code shape from the issue: one provider entry, the
        // monthly window binding at 99.5% used ($0.05 of $10 left), weekly lower.
        const leaf = ModelRoute.ref({ providerID: "command-code", model: "deepseek-v4.1-flash" });
        ModelRoute.resetHealth();
        const resetAt = now + 30 * 86400000;
        const reading = (monthly, at) => gathered({
            providerID: "command-code",
            at,
            windows: [
                { name: "weekly", usedPercent: 64.6, resetAt: now + 4 * 86400000 },
                { name: "monthly", usedPercent: monthly, resetAt },
            ],
        });
        // Oracle: the combined rule — low quota alone never walls.
        expect(ModelRoute.gatheredNearEmptyWall(leaf, reading(99.5, now), now)).toBeUndefined();
        expect(ModelRoute.plantGatheredNearEmptyWall(leaf, reading(99.5, now), now)).toBeUndefined();
        expect(ModelRoute.skipped(leaf, now + 1)).toBe(false);
        expect(ModelRoute.availability(now + 1).some((entry) => entry.reason.includes("walled-below-1%"))).toBe(false);
    });
    test("below 1% remaining plus quota-class failures walls, distinctly, until the window resets (#2256)", () => {
        const now = 850000000;
        const leaf = ModelRoute.ref({ providerID: "command-code", model: "deepseek-v4.1-flash" });
        ModelRoute.resetHealth();
        // A short quota bench: the failure is on record (quota event + bench)
        // long after the bench itself has lapsed, so the skip judged below is
        // the plant's, not the bench's.
        const policy = ModelRoute.policy({ cooldownMs: 1000, quotaCooldownMs: 1000 });
        ModelRoute.failed(leaf, policy, now, { quota: true });
        const resetAt = now + 30 * 86400000;
        const reading = (monthly, at) => gathered({
            providerID: "command-code",
            at,
            windows: [
                { name: "weekly", usedPercent: 64.6, resetAt: now + 4 * 86400000 },
                { name: "monthly", usedPercent: monthly, resetAt },
            ],
        });
        const wall = ModelRoute.gatheredNearEmptyWall(leaf, reading(99.5, now), now);
        expect(wall?.percent).toBe(99.5);
        expect(wall?.until).toBe(resetAt);
        expect(ModelRoute.plantGatheredNearEmptyWall(leaf, reading(99.5, now), now)).toBe("quota-model:command-code:deepseek-v4.1-flash");
        // Zero new attempts: the leg is skipped well past its 1s bench, until
        // the binding window's reset — and the surface names the distinct state.
        expect(ModelRoute.skipped(leaf, now + 2000)).toBe(true);
        expect(ModelRoute.skipped(leaf, resetAt - 1)).toBe(true);
        const entry = ModelRoute.availability(now + 2000).find((candidate) => candidate.providerID === "command-code" && candidate.reason.includes("walled-below-1%"));
        expect(entry?.class).toBe("quota");
        expect(entry?.until).toBe(resetAt);
        expect(entry?.resume).toBe("reset");
        // A measured increase on the binding window re-admits it with no
        // config change: the next feed at 90% used lifts the plant.
        expect(ModelRoute.plantGatheredNearEmptyWall(leaf, reading(90, now + 15 * 60000), now + 15 * 60000)).toBe("quota-model:command-code:deepseek-v4.1-flash");
        expect(ModelRoute.skipped(leaf, now + 15 * 60000 + 1)).toBe(false);
    });
    test("exactly 1% remaining does not wall, and a generic failure is not the failure half (#2256)", () => {
        const now = 860000000;
        const leaf = ModelRoute.ref({ providerID: "command-code", model: "deepseek-v4.1-flash" });
        ModelRoute.resetHealth();
        const policy = ModelRoute.policy({ cooldownMs: 1000, quotaCooldownMs: 1000 });
        ModelRoute.failed(leaf, policy, now, { quota: true });
        const resetAt = now + 30 * 86400000;
        const at99 = gathered({
            providerID: "command-code",
            at: now,
            windows: [{ name: "monthly", usedPercent: 99, resetAt }],
        });
        // Oracle: the rule is strictly under 1% remaining.
        expect(ModelRoute.gatheredNearEmptyWall(leaf, at99, now)).toBeUndefined();
        // A generic (non-quota) failure records no quota signal: at 99.5% the
        // combined rule still states no wall.
        ModelRoute.resetHealth();
        ModelRoute.failed(leaf, policy, now);
        const at995 = gathered({
            providerID: "command-code",
            at: now,
            windows: [{ name: "monthly", usedPercent: 99.5, resetAt }],
        });
        expect(ModelRoute.quotaFailureSignal(leaf, now)).toBe(false);
        expect(ModelRoute.gatheredNearEmptyWall(leaf, at995, now)).toBeUndefined();
    });
    test("a provider-wide gathered wall also gates the provider scope (fork #2479)", () => {
        const now = 870000000;
        // The production shape: cline-pass and opendesign carry exactly one
        // gathered entry, no per-model windows, and no plan-derived feed, so the
        // model-scope plant was the only proactive record — and a route
        // adjustment binds only rules routes and never reaches the root-start
        // gate. Fresh session waves kept dealing the legs as last resorts and
        // spending one attempt each into the wall (opendesign 42 attempts in 6h,
        // cline-pass 8, all quota failures, while the snapshot read 100%). The
        // wall must stand in the provider gate itself.
        const leaf = ModelRoute.ref({ providerID: "cline-pass", model: "deepseek-v4.1-flash" });
        const sibling = ModelRoute.ref({ providerID: "cline-pass", model: "mimo-v2.6-flash" });
        ModelRoute.resetHealth();
        const resetAt = now + 21 * 86400000;
        const reading = (monthly, at) => gathered({
            providerID: "cline-pass",
            at,
            windows: [
                { name: "5h", usedPercent: 0, resetAt: at + 5 * hour },
                { name: "weekly", usedPercent: 99, resetAt: now + 4 * 86400000 },
                { name: "monthly", usedPercent: monthly, resetAt },
            ],
        });
        // Nothing gates the provider before the feed.
        expect(ModelRoute.providerQuotaBlocked(leaf, now)).toBeUndefined();
        expect(ModelRoute.providerRootStartBlocked(leaf, now)).toBeUndefined();
        expect(ModelRoute.observeGatheredProviderWall(leaf, reading(100, now), now)).toBe(true);
        // The whole provider is gated until the stated reset — every leg of it,
        // for continuations and for root starts alike.
        expect(ModelRoute.providerQuotaBlocked(leaf, now + 1)).toEqual({ until: resetAt });
        expect(ModelRoute.providerQuotaBlocked(sibling, now + 1)).toEqual({ until: resetAt });
        expect(ModelRoute.providerRootStartBlocked(leaf, now + 1)).toEqual({ until: resetAt });
        // The stated reset passing re-admits on its own: no feed, no attempt.
        expect(ModelRoute.providerQuotaBlocked(leaf, resetAt + 1)).toBeUndefined();
        expect(ModelRoute.providerRootStartBlocked(leaf, resetAt + 1)).toBeUndefined();
    });
    test("a provider-wide gathered wall lifts on a fresh below-full reading, and partial evidence lifts nothing (fork #2479)", () => {
        const now = 880000000;
        const leaf = ModelRoute.ref({ providerID: "opendesign", model: "mimo-v2.6-flash" });
        ModelRoute.resetHealth();
        const resetAt = now + 2 * 86400000;
        const full = gathered({
            providerID: "opendesign",
            at: now,
            windows: [
                { name: "5h", usedPercent: 0, resetAt: now + 5 * hour },
                { name: "7d", usedPercent: 100, resetAt },
            ],
        });
        expect(ModelRoute.observeGatheredProviderWall(leaf, full, now)).toBe(true);
        expect(ModelRoute.providerQuotaBlocked(leaf, now + 1)).toEqual({ until: resetAt });
        // A percent-less window is missing evidence, not headroom: the wall stands.
        const partial = gathered({
            providerID: "opendesign",
            at: now + 15 * 60000,
            windows: [
                { name: "5h", usedPercent: 0, resetAt: now + 5 * hour },
                { name: "7d", usedPercent: null },
            ],
        });
        expect(ModelRoute.observeGatheredProviderWall(leaf, partial, now + 15 * 60000)).toBe(false);
        expect(ModelRoute.providerQuotaBlocked(leaf, now + 15 * 60000 + 1)).toEqual({ until: resetAt });
        // A fresh, complete reading below full on every window lifts the wall.
        const room = gathered({
            providerID: "opendesign",
            at: now + 30 * 60000,
            windows: [
                { name: "5h", usedPercent: 0, resetAt: now + 5 * hour },
                { name: "7d", usedPercent: 40, resetAt: resetAt + 7 * 86400000 },
            ],
        });
        expect(ModelRoute.observeGatheredProviderWall(leaf, room, now + 30 * 60000)).toBe(true);
        expect(ModelRoute.providerQuotaBlocked(leaf, now + 30 * 60000 + 1)).toBeUndefined();
        expect(ModelRoute.providerRootStartBlocked(leaf, now + 30 * 60000 + 1)).toBeUndefined();
    });
    test("per-model and per-account gathered shapes state no provider-wide gate (fork #2479)", () => {
        const now = 890000000;
        const leaf = ModelRoute.ref({ providerID: "antigravity-direct", model: "gemini-3.8-flash" });
        ModelRoute.resetHealth();
        // A per-model reading at 100%: the model-scope plant governs this shape;
        // no provider gate is stated.
        const perModel = gathered({
            providerID: "antigravity-direct",
            at: now,
            models: { "gemini-3.8-flash": [{ name: "weekly", usedPercent: 100, resetAt: now + 3 * 86400000 }] },
        });
        expect(ModelRoute.observeGatheredProviderWall(leaf, perModel, now)).toBe(false);
        expect(ModelRoute.providerQuotaBlocked(leaf, now + 1)).toBeUndefined();
        // Several entries for one provider are per-account readings: a proper
        // subset of full accounts synthesizes no provider wall (code#13693 rule 3:
        // only EVERY account reading known-full aggregates to a provider gate —
        // that case is covered in the wall-scoping suite below).
        const codexLeaf = ModelRoute.ref({ providerID: "codex", model: "gpt-6-luna" });
        const entry = (weekly) => ({
            providerID: "codex",
            measuredAt: now,
            windows: [{ name: "weekly", usedPercent: weekly, resetAt: now + 3 * 86400000, measuredAt: now }],
            models: {},
        });
        expect(ModelRoute.observeGatheredProviderWall(codexLeaf, [entry(100), entry(65)], now)).toBe(false);
        expect(ModelRoute.providerQuotaBlocked(codexLeaf, now + 1)).toBeUndefined();
        // A stale provider-wide reading states no wall either.
        const stale = gathered({
            providerID: "cline-pass",
            at: now - 31 * 60000,
            windows: [{ name: "monthly", usedPercent: 100, resetAt: now + 21 * 86400000 }],
        });
        const clineLeaf = ModelRoute.ref({ providerID: "cline-pass", model: "deepseek-v4.1-flash" });
        expect(ModelRoute.observeGatheredProviderWall(clineLeaf, stale, now)).toBe(false);
        expect(ModelRoute.providerQuotaBlocked(clineLeaf, now + 1)).toBeUndefined();
    });
    test("a stale or missing gathered reading plants nothing and lifts nothing (code#8086)", () => {
        const now = 840000000;
        const leaf = ModelRoute.ref({ providerID: "cline-pass", model: "deepseek-v4.1-flash" });
        ModelRoute.resetHealth();
        const stale = gathered({
            providerID: "cline-pass",
            at: now - 31 * 60000,
            windows: [{ name: "weekly", usedPercent: 100, resetAt: now + 86400000 }],
        });
        // A reading older than the gatherer's own cadence is not evidence: the
        // leg stays exactly as attempt + bench left it — attempted, not idled.
        expect(ModelRoute.gatheredQuotaWall(leaf, stale, now)).toBeUndefined();
        expect(ModelRoute.plantGatheredQuotaWall(leaf, stale, now)).toBeUndefined();
        expect(ModelRoute.skipped(leaf, now + 1)).toBe(false);
        // No reading for the provider at all: no judgement either.
        expect(ModelRoute.plantGatheredQuotaWall(leaf, [], now)).toBeUndefined();
        expect(ModelRoute.skipped(leaf, now + 1)).toBe(false);
    });
    test("several gathered entries for one provider plant no pool verdict (code#8086)", () => {
        const now = 850000000;
        // The codex shape: several per-account entries share one provider id, and
        // they disagree — one account's weekly window is full, another's is not.
        // No provider-wide wall is synthesized from per-account readings; each
        // account's own gate and benches govern it.
        const leaf = ModelRoute.ref({ providerID: "codex", model: "gpt-6-luna" });
        ModelRoute.resetHealth();
        const entry = (weekly) => ({
            providerID: "codex",
            measuredAt: now,
            windows: [{ name: "weekly", usedPercent: weekly, resetAt: now + 3 * 86400000, measuredAt: now }],
            models: {},
        });
        expect(ModelRoute.plantGatheredQuotaWall(leaf, [entry(100), entry(65), entry(100)], now)).toBeUndefined();
        expect(ModelRoute.skipped(leaf, now + 1)).toBe(false);
    });
    test("the gathered plant never touches an attempt-reported skip (code#8086, #1974)", () => {
        const now = 860000000;
        const leaf = ModelRoute.ref({ providerID: "opendesign", model: "claude-haiku-5.5" });
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(leaf, undefined, now + 3 * 86400000, now);
        expect(ModelRoute.skipped(leaf, now + 1)).toBe(true);
        // A headroom reading arrives at the plant path: the attempt-reported
        // record is the re-admission path's business (#1974), not the plant's —
        // it stands until that path or its own stated reset releases it.
        expect(ModelRoute.plantGatheredQuotaWall(leaf, gathered({
            providerID: "opendesign",
            at: now + 60000,
            models: { "claude-haiku-5.5": [{ name: "weekly", usedPercent: 4, resetAt: now + 7 * 86400000 }] },
        }), now + 60000)).toBeUndefined();
        expect(ModelRoute.skipped(leaf, now + 60001)).toBe(true);
    });
    test("a gathered wall does not overwrite an attempt-reported skip (#2332)", () => {
        const now = 870000000;
        const leaf = ModelRoute.ref({ providerID: "opendesign", model: "claude-haiku-5.5" });
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(leaf, undefined, now + 3 * 86400000, now);
        expect(ModelRoute.skipped(leaf, now + 1)).toBe(true);
        // A wall is judged from the gathered snapshot while the attempt record
        // stands. The plant must leave that record untouched — origin, until
        // and note — not replace it with a proactive record of its own (#2332):
        // nothing is planted by this call.
        expect(ModelRoute.plantGatheredQuotaWall(leaf, gathered({
            providerID: "opendesign",
            at: now + 60000,
            models: { "claude-haiku-5.5": [{ name: "weekly", usedPercent: 100, resetAt: now + 7 * 86400000 }] },
        }), now + 60000)).toBeUndefined();
        // The discriminating consequence: had the wall flipped the record's
        // origin to "proactive", this headroom reading would lift it on the
        // snapshot's word. The attempt record stands instead, until the
        // attempt path or its own stated reset releases it (#1974).
        expect(ModelRoute.plantGatheredQuotaWall(leaf, gathered({
            providerID: "opendesign",
            at: now + 120000,
            models: { "claude-haiku-5.5": [{ name: "weekly", usedPercent: 4, resetAt: now + 7 * 86400000 }] },
        }), now + 120000)).toBeUndefined();
        expect(ModelRoute.skipped(leaf, now + 120001)).toBe(true);
    });
});
describe("ModelRoute wall scoping: sibling-evidence narrowing + all-accounts-full aggregation (code#13693 Slice F)", () => {
    const hour = 3600000;
    const policy = ModelRoute.policy({ cooldownMs: 1000, quotaCooldownMs: 1000 });
    const fast = { firstTokenMs: 10, responseMs: 10, tokensPerSecond: 30 };
    const gathered = (opts) => [
        {
            providerID: opts.providerID,
            measuredAt: opts.at,
            windows: (opts.windows ?? []).map((window) => ({
                name: window.name,
                usedPercent: window.usedPercent,
                resetAt: window.resetAt ?? null,
                measuredAt: opts.at,
            })),
            models: Object.fromEntries(Object.entries(opts.models ?? {}).map(([modelID, windows]) => [
                modelID,
                windows.map((window) => ({
                    name: window.name,
                    usedPercent: window.usedPercent,
                    resetAt: window.resetAt ?? null,
                    measuredAt: opts.at,
                })),
            ])),
        },
    ];
    test("a serving model is exempt from a gathered provider gate its sibling stays under (code#13693 rule 2)", () => {
        const now = 900000000;
        const leafA = ModelRoute.ref({ providerID: "cline-pass", model: "model-a" });
        const leafB = ModelRoute.ref({ providerID: "cline-pass", model: "model-b" });
        ModelRoute.resetHealth();
        const resetAt = now + 21 * 86400000;
        const reading = gathered({
            providerID: "cline-pass",
            at: now,
            windows: [{ name: "monthly", usedPercent: 100, resetAt }],
        });
        // Oracle (code#13693 scope rule): the single-entry gathered provider gate
        // stands for the provider as a whole...
        expect(ModelRoute.observeGatheredProviderWall(leafA, reading, now)).toBe(true);
        expect(ModelRoute.providerQuotaBlocked(leafA, now + 1)).toEqual({ until: resetAt });
        expect(ModelRoute.providerQuotaBlocked(leafB, now + 1)).toEqual({ until: resetAt });
        // ...but model A records a success AFTER the gate's evidence time (the
        // reading's observedAt): A is demonstrably serving, so the provider-scope
        // gate no longer blocks it — its pair scope governs it instead.
        ModelRoute.completed(leafA, policy, fast, now + 60000);
        expect(ModelRoute.providerQuotaBlocked(leafA, now + 60001)).toBeUndefined();
        // Model B has no success on record: the gate applies exactly as before.
        expect(ModelRoute.providerQuotaBlocked(leafB, now + 60001)).toEqual({ until: resetAt });
    });
    test("a quota-class failure after the exempting success revokes the narrowing (code#13693 rule 2)", () => {
        const now = 910000000;
        const leafA = ModelRoute.ref({ providerID: "cline-pass", model: "model-a" });
        ModelRoute.resetHealth();
        const resetAt = now + 21 * 86400000;
        const reading = gathered({
            providerID: "cline-pass",
            at: now,
            windows: [{ name: "monthly", usedPercent: 100, resetAt }],
        });
        expect(ModelRoute.observeGatheredProviderWall(leafA, reading, now)).toBe(true);
        ModelRoute.completed(leafA, policy, fast, now + 60000);
        expect(ModelRoute.providerQuotaBlocked(leafA, now + 60001)).toBeUndefined();
        // Oracle: A's own quota-class failure after that success is on record in
        // the same stores quotaFailureSignal consults (quotaEvents + health bench
        // state), so the exemption is revoked through those stores alone — A is
        // blocked by the provider gate again, with no registry to update.
        ModelRoute.failed(leafA, policy, now + 120000, { quota: true });
        expect(ModelRoute.quotaFailureSignal(leafA, now + 120001)).toBe(true);
        expect(ModelRoute.providerQuotaBlocked(leafA, now + 120001)).toEqual({ until: resetAt });
    });
    test("no sibling success anywhere: every model of the gated provider stays blocked (fork #2479 regression)", () => {
        const now = 920000000;
        const leafA = ModelRoute.ref({ providerID: "opendesign", model: "model-a" });
        const leafB = ModelRoute.ref({ providerID: "opendesign", model: "model-b" });
        ModelRoute.resetHealth();
        const resetAt = now + 2 * 86400000;
        const reading = gathered({
            providerID: "opendesign",
            at: now,
            windows: [
                { name: "5h", usedPercent: 0, resetAt: now + 5 * hour },
                { name: "7d", usedPercent: 100, resetAt },
            ],
        });
        // Oracle: with no recorded success more recent than the gate's evidence,
        // today's #2479 behaviour is unchanged — the whole provider is blocked.
        expect(ModelRoute.observeGatheredProviderWall(leafA, reading, now)).toBe(true);
        expect(ModelRoute.providerQuotaBlocked(leafA, now + 1)).toEqual({ until: resetAt });
        expect(ModelRoute.providerQuotaBlocked(leafB, now + 1)).toEqual({ until: resetAt });
        // A success OLDER than the gate's evidence states no narrowing either.
        ModelRoute.completed(leafA, policy, fast, now - 60000);
        expect(ModelRoute.providerQuotaBlocked(leafA, now + 1)).toEqual({ until: resetAt });
    });
    test("the plan-fed provider gate narrows on the same sibling evidence (code#13693 rule 2)", () => {
        const now = 930000000;
        const leafA = ModelRoute.ref({ providerID: "fed-prov", model: "model-a" });
        const leafB = ModelRoute.ref({ providerID: "fed-prov", model: "model-b" });
        ModelRoute.resetHealth();
        ModelRoute.setAdjustments([]);
        const resetAt = now + 3600000;
        ModelRoute.observeProviderQuota(leafA, {
            planID: "plan",
            window: "weekly",
            providerID: "fed-prov",
            percent: 100,
            remaining: 0,
            resetAt,
            observedAt: now,
            stale: false,
        }, now);
        expect(ModelRoute.providerQuotaBlocked(leafA, now + 1)).toEqual({ until: resetAt });
        expect(ModelRoute.providerQuotaBlocked(leafB, now + 1)).toEqual({ until: resetAt });
        // Oracle: the fed path judges narrowing against its own state snapshot's
        // observedAt, exactly as the gathered path judges against its reading's.
        ModelRoute.completed(leafA, policy, fast, now + 60000);
        expect(ModelRoute.providerQuotaBlocked(leafA, now + 60001)).toBeUndefined();
        expect(ModelRoute.providerQuotaBlocked(leafB, now + 60001)).toEqual({ until: resetAt });
    });
    test("all-accounts-full gathered readings aggregate to a provider gate; any shortfall states none (code#13693 rule 3)", () => {
        const now = 940000000;
        const leaf = ModelRoute.ref({ providerID: "codex", model: "gpt-6-luna" });
        ModelRoute.resetHealth();
        const entry = (opts) => ({
            providerID: "codex",
            measuredAt: opts.at ?? now,
            windows: opts.windows.map((window) => ({
                name: window.name,
                usedPercent: window.usedPercent,
                resetAt: window.resetAt ?? null,
                measuredAt: opts.at ?? now,
            })),
            models: {},
        });
        const resetEarly = now + 2 * 86400000;
        const resetLate = now + 3 * 86400000;
        // Oracle: EVERY account entry fresh, complete and known-full on its
        // fullest window -> the provider gate is recorded from the aggregate,
        // carrying the EARLIEST reset among the entries.
        expect(ModelRoute.observeGatheredProviderWall(leaf, [
            entry({ windows: [{ name: "weekly", usedPercent: 100, resetAt: resetLate }] }),
            entry({
                windows: [
                    { name: "5h", usedPercent: 40, resetAt: now + 5 * hour },
                    { name: "weekly", usedPercent: 100, resetAt: resetEarly },
                ],
            }),
        ], now)).toBe(true);
        expect(ModelRoute.providerQuotaBlocked(leaf, now + 1)).toEqual({ until: resetEarly });
        // One entry below full -> no gate.
        ModelRoute.resetHealth();
        expect(ModelRoute.observeGatheredProviderWall(leaf, [
            entry({ windows: [{ name: "weekly", usedPercent: 100, resetAt: resetLate }] }),
            entry({ windows: [{ name: "weekly", usedPercent: 65, resetAt: resetLate }] }),
        ], now)).toBe(false);
        expect(ModelRoute.providerQuotaBlocked(leaf, now + 1)).toBeUndefined();
        // One entry incomplete (a percent-less window) -> no gate.
        ModelRoute.resetHealth();
        expect(ModelRoute.observeGatheredProviderWall(leaf, [
            entry({ windows: [{ name: "weekly", usedPercent: 100, resetAt: resetLate }] }),
            entry({ windows: [{ name: "weekly", usedPercent: null }] }),
        ], now)).toBe(false);
        expect(ModelRoute.providerQuotaBlocked(leaf, now + 1)).toBeUndefined();
        // One entry stale -> no gate.
        ModelRoute.resetHealth();
        expect(ModelRoute.observeGatheredProviderWall(leaf, [
            entry({ windows: [{ name: "weekly", usedPercent: 100, resetAt: resetLate }] }),
            entry({ at: now - 31 * 60000, windows: [{ name: "weekly", usedPercent: 100, resetAt: resetLate }] }),
        ], now)).toBe(false);
        expect(ModelRoute.providerQuotaBlocked(leaf, now + 1)).toBeUndefined();
    });
});
describe("ModelRoute reactive quota skip scoping and quota-driven re-admission (#1974, #1976)", () => {
    const hour = 3600000;
    const gatheredReading = (opts) => [
        {
            providerID: opts.providerID,
            measuredAt: opts.at,
            windows: opts.widePercent === undefined
                ? []
                : [{ name: "weekly", usedPercent: opts.widePercent, resetAt: opts.resetAt ?? null, measuredAt: opts.at }],
            models: {
                [opts.modelID]: [
                    { name: "weekly", usedPercent: opts.percent, resetAt: opts.resetAt ?? null, measuredAt: opts.at },
                ],
            },
        },
    ];
    test("a credential-less quota answer skips only the answering target (#1976)", () => {
        const now = 700000000;
        const resetAt = now + 3600000;
        const gemini = ModelRoute.ref({ providerID: "antigravity-direct", model: "gemini-3.8-flash" });
        const claude = ModelRoute.ref({ providerID: "antigravity-direct", model: "claude-sonnet-5-5" });
        ModelRoute.resetHealth();
        // The Claude family's wall: one credential-less quota answer.
        ModelRoute.observeQuotaFailure(claude, undefined, resetAt, now);
        // The answering target is skipped, under its own model-scoped record...
        expect(ModelRoute.skipped(claude, now + 1)).toBe(true);
        expect(ModelRoute.activeAdjustments(now + 1).some((item) => item.id === "quota-model:antigravity-direct:claude-sonnet-5-5")).toBe(true);
        // ...and the sibling family is untouched: no provider-wide record, no skip.
        expect(ModelRoute.skipped(gemini, now + 1)).toBe(false);
        expect(ModelRoute.activeAdjustments(now + 1).some((item) => item.id === "quota:antigravity-direct")).toBe(false);
    });
    test("a second family's quota answer corroborates the skip to provider scope (#1976)", () => {
        const now = 710000000;
        const resetAt = now + 3600000;
        const gemini = ModelRoute.ref({ providerID: "antigravity-direct", model: "gemini-3.8-flash" });
        const claude = ModelRoute.ref({ providerID: "antigravity-direct", model: "claude-sonnet-5-5" });
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(claude, undefined, resetAt, now);
        // A second, distinct target of the same provider answers quota while the first
        // family's hold still stands: two sources, the pool-verdict standard.
        ModelRoute.observeQuotaFailure(gemini, undefined, resetAt, now + 1);
        expect(ModelRoute.activeAdjustments(now + 2).some((item) => item.id === "quota:antigravity-direct")).toBe(true);
        expect(ModelRoute.skipped(gemini, now + 2)).toBe(true);
        expect(ModelRoute.skipped(claude, now + 2)).toBe(true);
        // Corroboration is judged against live holds: once the first family's stated hold
        // has lapsed, a lone new answer scopes to its own target again.
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(claude, undefined, resetAt, now);
        ModelRoute.observeQuotaFailure(gemini, undefined, resetAt + 7200000, resetAt + 1);
        expect(ModelRoute.activeAdjustments(resetAt + 2).some((item) => item.id === "quota:antigravity-direct")).toBe(false);
        expect(ModelRoute.skipped(gemini, resetAt + 2)).toBe(true);
        expect(ModelRoute.skipped(claude, resetAt + 2)).toBe(false);
    });
    test("a gathered reading with headroom lifts the skip, long before the stated reset (#1974)", () => {
        const now = 720000000;
        // The OpenDesign shape: the error's stated reset is days out, far past the real
        // window roll — and the window did roll, which the gatherer's fresh reading shows.
        const statedReset = now + 3 * 86400000;
        const leaf = ModelRoute.ref({ providerID: "opendesign", model: "claude-haiku-5.5" });
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(leaf, undefined, statedReset, now);
        expect(ModelRoute.skipped(leaf, now + 1)).toBe(true);
        const judgedAt = now + 15 * 60000;
        const released = ModelRoute.releaseQuotaSkipsForCurrent(leaf, gatheredReading({
            providerID: "opendesign",
            modelID: "claude-haiku-5.5",
            percent: 4,
            at: judgedAt,
            resetAt: now + 7 * 86400000,
        }), judgedAt);
        // The source's reset (a fresh window, days past the stated one) governs: the skip
        // comes off on the reading's word, with no attempt spent to learn it.
        expect(released).toEqual(["quota-model:opendesign:claude-haiku-5.5"]);
        expect(ModelRoute.skipped(leaf, judgedAt + 1)).toBe(false);
    });
    test("a gathered reading that still shows the window full lifts nothing (#1974)", () => {
        const now = 730000000;
        const leaf = ModelRoute.ref({ providerID: "opendesign", model: "claude-haiku-5.5" });
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(leaf, undefined, now + 3 * 86400000, now);
        const judgedAt = now + 15 * 60000;
        const released = ModelRoute.releaseQuotaSkipsForCurrent(leaf, gatheredReading({
            providerID: "opendesign",
            modelID: "claude-haiku-5.5",
            percent: 100,
            at: judgedAt,
            resetAt: now + 86400000,
        }), judgedAt);
        expect(released).toEqual([]);
        expect(ModelRoute.skipped(leaf, judgedAt + 1)).toBe(true);
        // A stale reading is no evidence either way: the skip stands, unjudged.
        expect(ModelRoute.releaseQuotaSkipsForCurrent(leaf, gatheredReading({ providerID: "opendesign", modelID: "claude-haiku-5.5", percent: 4, at: judgedAt }), judgedAt + 2 * hour)).toEqual([]);
        expect(ModelRoute.skipped(leaf, judgedAt + 2 * hour)).toBe(true);
    });
    test("a provider the snapshot does not carry keeps its skip — no reading, no judgement (#1974)", () => {
        const now = 740000000;
        const leaf = ModelRoute.ref({ providerID: "unmeasured", model: "m" });
        const other = ModelRoute.ref({ providerID: "opendesign", model: "claude-haiku-5.5" });
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(leaf, undefined, now + 86400000, now);
        const judgedAt = now + 15 * 60000;
        // Headroom readings exist — for another provider, and for this provider's other
        // model. Neither is a reading of this leaf's window.
        expect(ModelRoute.releaseQuotaSkipsForCurrent(leaf, gatheredReading({ providerID: "opendesign", modelID: "claude-haiku-5.5", percent: 0, at: judgedAt }), judgedAt)).toEqual([]);
        expect(ModelRoute.releaseQuotaSkipsForCurrent(leaf, gatheredReading({ providerID: "unmeasured", modelID: "some-other-model", percent: 0, at: judgedAt }), judgedAt)).toEqual([]);
        expect(ModelRoute.skipped(leaf, judgedAt + 1)).toBe(true);
        expect(ModelRoute.skipped(other, judgedAt + 1)).toBe(false);
    });
    test("a corroborated provider-wide skip lifts only on provider-wide headroom (#1974)", () => {
        const now = 750000000;
        // Two families answered quota, so the standing skip is provider-wide. One family's
        // headroom reading cannot lift it while that record stands — the leaf stays
        // skipped until the provider's own windows read headroom too.
        const gemini = ModelRoute.ref({ providerID: "antigravity-direct", model: "gemini-3.8-flash" });
        const claude = ModelRoute.ref({ providerID: "antigravity-direct", model: "claude-sonnet-5-5" });
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(claude, undefined, now + 3 * 86400000, now);
        ModelRoute.observeQuotaFailure(gemini, undefined, now + 3 * 86400000, now + 1);
        expect(ModelRoute.skipped(gemini, now + 2)).toBe(true);
        const judgedAt = now + 15 * 60000;
        // Gemini's window reads 4% used, but the provider-wide window still reads full:
        // nothing lifts, and the leaf stays skipped under the provider record.
        expect(ModelRoute.releaseQuotaSkipsForCurrent(gemini, gatheredReading({
            providerID: "antigravity-direct",
            modelID: "gemini-3.8-flash",
            percent: 4,
            at: judgedAt,
            widePercent: 100,
        }), judgedAt)).toEqual([]);
        expect(ModelRoute.skipped(gemini, judgedAt + 1)).toBe(true);
        // The provider-wide windows read headroom as well: the corroborated record comes
        // off, and the sibling family's own record — no reading for it here — stands.
        expect(ModelRoute.releaseQuotaSkipsForCurrent(gemini, gatheredReading({
            providerID: "antigravity-direct",
            modelID: "gemini-3.8-flash",
            percent: 4,
            at: judgedAt,
            widePercent: 40,
        }), judgedAt)).toEqual(["quota:antigravity-direct"]);
        expect(ModelRoute.skipped(gemini, judgedAt + 2)).toBe(false);
        expect(ModelRoute.skipped(claude, judgedAt + 2)).toBe(true);
    });
    test("a provider-wide attempt skip lifts on provider-window headroom when the gathered entry carries no model reading (#2554)", () => {
        const now = 770000000;
        // The `_claude` gathered shape: provider windows only, and a per-model entry keyed by
        // a family nickname rather than the full model id — so no reading is keyed to the target.
        const haiku = ModelRoute.ref({ providerID: "_claude", model: "claude-haiku-5-5" });
        const fable = ModelRoute.ref({ providerID: "_claude", model: "claude-fable-5-2" });
        const resetAt = now + 3 * 86400000;
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(haiku, undefined, resetAt, now);
        ModelRoute.observeQuotaFailure(fable, undefined, resetAt, now + 1);
        expect(ModelRoute.skipped(haiku, now + 2)).toBe(true);
        const judgedAt = now + 15 * 60000;
        const claudeEntry = (windows) => [
            {
                providerID: "_claude",
                measuredAt: judgedAt,
                windows: [
                    { name: "5h", usedPercent: windows["5h"], resetAt: null, measuredAt: judgedAt },
                    { name: "7d", usedPercent: windows["7d"], resetAt: null, measuredAt: judgedAt },
                    { name: "Fable:7d", usedPercent: 0, resetAt: null, measuredAt: judgedAt },
                ],
                models: { Fable: [{ name: "7d", usedPercent: 0, resetAt: null, measuredAt: judgedAt }] },
            },
        ];
        // Provider windows still read full: the provider record stands.
        expect(ModelRoute.releaseQuotaSkipsForCurrent(haiku, claudeEntry({ "5h": 100, "7d": 100 }), judgedAt)).toEqual([]);
        expect(ModelRoute.skipped(haiku, judgedAt + 1)).toBe(true);
        // Fresh below-full provider windows re-admit the provider on the reading's word, and
        // the target's own record beneath it goes with it.
        expect(ModelRoute.releaseQuotaSkipsForCurrent(haiku, claudeEntry({ "5h": 1, "7d": 2 }), judgedAt)).toEqual([
            "quota-model:_claude:claude-haiku-5-5",
            "quota:_claude",
        ]);
        expect(ModelRoute.skipped(haiku, judgedAt + 2)).toBe(false);
        expect(ModelRoute.skipped(fable, judgedAt + 2)).toBe(false);
    });
    test("a fresher not-full snapshot releases a model-scoped reactive skip (#1974, #1976)", () => {
        const now = 760000000;
        const resetAt = now + 3 * 86400000;
        const leaf = ModelRoute.ref({ providerID: "opendesign", model: "claude-haiku-5.5" });
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(leaf, undefined, resetAt, now);
        expect(ModelRoute.skipped(leaf, now + 1)).toBe(true);
        ModelRoute.observeProviderQuota(leaf, {
            planID: "plan",
            window: "weekly",
            providerID: "opendesign",
            percent: 4,
            remaining: 144000,
            resetAt: now + 7 * 86400000,
            observedAt: now + 60000,
            stale: false,
        }, now + 60000);
        expect(ModelRoute.skipped(leaf, now + 60001)).toBe(false);
    });
    test("two families out promotes the hold to provider scope; one family stays model-scoped (#1976)", () => {
        const now = 770000000;
        const resetAt = now + 3600000;
        const a = ModelRoute.ref({ providerID: "prov-a", model: "m-a" });
        const b = ModelRoute.ref({ providerID: "prov-a", model: "m-b" });
        ModelRoute.resetHealth();
        ModelRoute.observeQuotaFailure(a, undefined, resetAt, now);
        // One family out: only the answering target is skipped; its sibling keeps serving.
        expect(ModelRoute.skipped(a, now + 1)).toBe(true);
        expect(ModelRoute.skipped(b, now + 1)).toBe(false);
        ModelRoute.observeQuotaFailure(b, undefined, resetAt, now);
        // Corroborated by a second distinct target: the hold is provider-wide now.
        expect(ModelRoute.skipped(a, now + 1)).toBe(true);
        expect(ModelRoute.skipped(b, now + 1)).toBe(true);
    });
});
