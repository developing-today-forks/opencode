import { afterEach, describe, expect, test } from "bun:test";
import { ModelRoute } from "@opencode/core/model-route";
import { RouteAdjustTool } from "@opencode/core/tool/plugin/route-adjust";
afterEach(() => {
    ModelRoute.resetHealth();
    ModelRoute.setAdjustments([]);
});
describe("route_adjust", () => {
    test("adds, lists and removes an expiring weight adjustment", () => {
        const added = RouteAdjustTool.apply({
            action: "add",
            match: "claude",
            effect: "weight",
            factor: 4,
            hours: 72,
            note: "promo credits expire in three days",
        });
        expect(added.content).toContain("weight x4");
        const target = ModelRoute.ref({ providerID: "anthropic", model: "claude-opus-5" });
        expect(ModelRoute.weightFactor(target)).toBe(4);
        expect(ModelRoute.weightFactor(ModelRoute.ref({ providerID: "openai", model: "gpt-6-luna" }))).toBe(1);
        expect(RouteAdjustTool.apply({ action: "list" }).content).toContain("promo credits");
        expect(RouteAdjustTool.apply({ action: "remove", id: "weight-claude" }).content).toBe("Removed weight-claude");
        expect(ModelRoute.weightFactor(target)).toBe(1);
    });
    test("refuses an incomplete add and a skip applies to matching targets only", () => {
        expect(RouteAdjustTool.apply({ action: "add", match: "glm" }).content).toContain("needs match");
        RouteAdjustTool.apply({ action: "add", match: "glm", effect: "skip", hours: 8 });
        expect(ModelRoute.skipped(ModelRoute.ref({ providerID: "zai", model: "glm-5" }))).toBe(true);
        expect(ModelRoute.skipped(ModelRoute.ref({ providerID: "openai", model: "gpt-6-luna" }))).toBe(false);
    });
    test("records a recurring window without hours and applies it only inside the window", () => {
        const now = Date.now();
        const added = RouteAdjustTool.apply({
            action: "add",
            match: "deepseek",
            effect: "weight",
            factor: 0.4,
            daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
            start: "9:00",
            end: "17:00",
            timezone: "UTC",
            note: "peak hours",
        });
        expect(added.content).toContain("during Mon, Tue, Wed, Thu, Fri 09:00-17:00 (UTC)");
        const adjustment = ModelRoute.activeAdjustments(now).at(-1);
        expect(adjustment.until).toBeUndefined();
        expect(adjustment.schedule).toEqual({
            daysOfWeek: [1, 2, 3, 4, 5],
            start: "09:00",
            end: "17:00",
            timezone: "UTC",
        });
        expect(ModelRoute.activeAdjustments(now)).toHaveLength(1);
        // The adjustment is listed even though it has no end date.
        expect(RouteAdjustTool.apply({ action: "list" }).content).toContain("peak hours");
        // Judged at a Monday noon UTC the window is open; after 17:00 it is not.
        const mondayNoon = Date.UTC(2026, 0, 5, 12, 0);
        const target = ModelRoute.ref({ providerID: "deepseek", model: "deepseek-chat" });
        expect(ModelRoute.weightFactor(target, mondayNoon)).toBe(0.4);
        expect(ModelRoute.weightFactor(target, Date.UTC(2026, 0, 5, 18, 0))).toBe(1);
        RouteAdjustTool.apply({ action: "remove", id: "weight-deepseek" });
        expect(ModelRoute.activeAdjustments(now)).toEqual([]);
        expect(RouteAdjustTool.apply({ action: "add", match: "x", effect: "weight" }).content).toContain("needs hours");
        expect(RouteAdjustTool.apply({ action: "add", match: "x", effect: "weight", daysOfWeek: ["someday"] }).content).toContain("could not be read");
    });
});
