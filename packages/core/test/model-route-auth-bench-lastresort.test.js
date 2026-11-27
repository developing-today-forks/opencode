import { afterEach, describe, expect, test } from "bun:test";
import { ModelRoute } from "@opencode/core/model-route";
// #2555 (2026-11-16): entitlement-dead legs were re-dealt forever — not because
// their auth benches were zero-length (the server DB proves every auth bench
// planted a real duration: ~900s escalating to the 24h cap), but because
// last-resort selection did not count an auth bench as dead. In the incident
// window (2026-11-16 19:00-19:10Z, laptop server route_health), the
// credential-less leg _commandcode/reflection/beam:free stood under a 24h auth
// bench and was still dealt 169 times in 10 minutes: its route's other doors
// were quota-full, ready was empty, and the last-resort path seated the one
// leg whose failure cannot heal by itself. Oracle for every test below: an
// auth bench is a death until a credential/plan change, not a cooling period —
// re-admission is the bench expiry's single probe (code#9950), never
// continuous dealing during the bench. Short retry-after benches and ordinary
// failure benches keep their last-resort grace; sibling efforts, sibling
// models, and sibling credentials are never widened into the verdict.
describe("ModelRoute auth benches: dead for last-resort selection (#2555)", () => {
    const policy = ModelRoute.policy({ cooldownMs: 60000, quotaCooldownMs: 900000 });
    afterEach(() => {
        ModelRoute.resetHealth();
        ModelRoute.resetSelection();
        ModelRoute.setAdjustments([]);
    });
    test("a credential-less leg under an auth bench is last-resort dead (the beam:free shape)", () => {
        const now = 4000000000;
        const beam = ModelRoute.ref({ providerID: "_commandcode", model: "reflection/beam:free" });
        ModelRoute.failed(beam, policy, now, { auth: true }, undefined, undefined, undefined, "default");
        expect(ModelRoute.cooldownUntil(beam, now, undefined, "default")).toBe(now + 900000);
        expect(ModelRoute.authBenched(beam, undefined, now, undefined, "default")).toBe(true);
        expect(ModelRoute.lastResortDead(beam, undefined, now, undefined, "default")).toBe(true);
    });
    test("an auth bench deads only the effort that errored; the sibling effort stays last-resort dealable", () => {
        const now = 4100000000;
        const sol = ModelRoute.ref({ providerID: "_commandcode", model: "gpt-6.1-sol" });
        ModelRoute.failed(sol, policy, now, { auth: true }, undefined, undefined, undefined, "medium");
        expect(ModelRoute.authBenched(sol, undefined, now, undefined, "medium")).toBe(true);
        expect(ModelRoute.lastResortDead(sol, undefined, now, undefined, "medium")).toBe(true);
        expect(ModelRoute.authBenched(sol, undefined, now, undefined, "high")).toBe(false);
        expect(ModelRoute.lastResortDead(sol, undefined, now, undefined, "high")).toBe(false);
    });
    test("an auth bench at credential scope deads the leg for that credential, not for a sibling credential", () => {
        const now = 4200000000;
        const leg = ModelRoute.ref({ providerID: "some-door", model: "some-model" });
        ModelRoute.failed(leg, policy, now, { auth: true }, "cred-dead", undefined, undefined, undefined);
        expect(ModelRoute.authBenched(leg, "cred-dead", now)).toBe(true);
        expect(ModelRoute.lastResortDead(leg, "cred-dead", now)).toBe(true);
        expect(ModelRoute.authBenched(leg, "cred-live", now)).toBe(false);
    });
    test("an auth bench on one model never deads a sibling model on the same door", () => {
        const now = 4300000000;
        const dead = ModelRoute.ref({ providerID: "_commandcode", model: "reflection/beam:free" });
        const alive = ModelRoute.ref({ providerID: "_commandcode", model: "gpt-6.1-terra" });
        ModelRoute.failed(dead, policy, now, { auth: true }, undefined, undefined, undefined, "default");
        expect(ModelRoute.authBenched(alive, undefined, now, undefined, "default")).toBe(false);
        expect(ModelRoute.lastResortDead(alive, undefined, now, undefined, "default")).toBe(false);
    });
    test("after the auth bench lapses the leg is no longer dead: re-admission is the single probe, not the last resort", () => {
        const now = 4400000000;
        const beam = ModelRoute.ref({ providerID: "_commandcode", model: "reflection/beam:free" });
        ModelRoute.failed(beam, policy, now, { auth: true }, undefined, undefined, undefined, "default");
        const expiry = now + 900000;
        expect(ModelRoute.authBenched(beam, undefined, expiry + 1, undefined, "default")).toBe(false);
        expect(ModelRoute.lastResortDead(beam, undefined, expiry + 1, undefined, "default")).toBe(false);
        expect(ModelRoute.probeDue(beam, undefined, expiry + 1, "default")).toBe(true);
    });
    test("an ordinary failure bench is not auth-dead and keeps its last-resort grace", () => {
        const now = 4500000000;
        const leg = ModelRoute.ref({ providerID: "some-door", model: "flaky-model" });
        ModelRoute.failed(leg, policy, now, {});
        expect(ModelRoute.authBenched(leg, undefined, now)).toBe(false);
        expect(ModelRoute.lastResortDead(leg, undefined, now)).toBe(false);
    });
});
