import { describe, expect, test } from "bun:test";
import { ModelRouteAutonomy } from "@opencode/core/model-route-autonomy";
describe("ModelRouteAutonomy", () => {
    test("fixed drops weights and budgets; every higher level and an unset level keeps them", () => {
        expect(ModelRouteAutonomy.usesRules("fixed")).toBe(false);
        for (const level of [undefined, "rules", "adaptive", "predictive", "agent"])
            expect(ModelRouteAutonomy.usesRules(level)).toBe(true);
    });
    test("the review runs for adaptive and above, or when tuning is enabled", () => {
        expect(ModelRouteAutonomy.reviews(["fixed", "rules"], false)).toBe(false);
        expect(ModelRouteAutonomy.reviews(["rules", "adaptive"], false)).toBe(true);
        expect(ModelRouteAutonomy.reviews([undefined], false)).toBe(false);
        expect(ModelRouteAutonomy.reviews(["fixed"], true)).toBe(true);
    });
    test("prediction needs predictive or above, and stays on when no level is set", () => {
        expect(ModelRouteAutonomy.predicts(["adaptive"])).toBe(false);
        expect(ModelRouteAutonomy.predicts(["adaptive", "predictive"])).toBe(true);
        expect(ModelRouteAutonomy.predicts([undefined])).toBe(true);
    });
    test("the agent tools are offered only for agent or unset routes", () => {
        expect(ModelRouteAutonomy.offersTools(["predictive"])).toBe(false);
        expect(ModelRouteAutonomy.offersTools(["predictive", "agent"])).toBe(true);
        expect(ModelRouteAutonomy.offersTools([undefined])).toBe(true);
    });
    test("a route races its next target after repeated give-ups only from adaptive up, and unset keeps that", () => {
        expect(ModelRouteAutonomy.races(undefined)).toBe(true);
        expect(ModelRouteAutonomy.races("fixed")).toBe(false);
        expect(ModelRouteAutonomy.races("rules")).toBe(false);
        expect(ModelRouteAutonomy.races("adaptive")).toBe(true);
        expect(ModelRouteAutonomy.races("predictive")).toBe(true);
        expect(ModelRouteAutonomy.races("agent")).toBe(true);
    });
    test("a learned adjustment reaches a route only when the route's level reaches its floor", () => {
        expect(ModelRouteAutonomy.reaches("rules", "adaptive")).toBe(false);
        expect(ModelRouteAutonomy.reaches("adaptive", "adaptive")).toBe(true);
        expect(ModelRouteAutonomy.reaches("adaptive", "predictive")).toBe(false);
        expect(ModelRouteAutonomy.reaches(undefined, "predictive")).toBe(true);
    });
    test("the review's floor is rules when tuning is enabled, and adaptive otherwise", () => {
        expect(ModelRouteAutonomy.reviewFloor(true)).toBe("rules");
        expect(ModelRouteAutonomy.reviewFloor(false)).toBe("adaptive");
    });
});
