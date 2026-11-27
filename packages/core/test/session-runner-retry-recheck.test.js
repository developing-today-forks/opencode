import { describe, expect, test } from "bun:test";
import { SessionRunnerRetry } from "../src/session/runner/retry.js";
describe("SessionRunnerRetry.withRecheckFloor (#1806)", () => {
    const decision = { retry: true, attempt: 1, delay: 2000 };
    test("raises the delay to the recheck instant", () => {
        const now = 1000000;
        expect(SessionRunnerRetry.withRecheckFloor(decision, now + 300000, now).delay).toBe(300000);
    });
    test("caps the wait at the retry-after bound", () => {
        const now = 1000000;
        expect(SessionRunnerRetry.withRecheckFloor(decision, now + 10000000, now).delay).toBe(900000);
    });
    test("never reduces a longer existing delay to the recheck cap", () => {
        const now = 1000000;
        const longer = { retry: true, attempt: 1, delay: 1200000 };
        expect(SessionRunnerRetry.withRecheckFloor(longer, now + 1800000, now).delay).toBe(1200000);
    });
    test("leaves the decision alone when the instant is nearer, past, or absent", () => {
        const now = 1000000;
        expect(SessionRunnerRetry.withRecheckFloor(decision, now + 1000, now)).toBe(decision);
        expect(SessionRunnerRetry.withRecheckFloor(decision, now - 5000, now)).toBe(decision);
        expect(SessionRunnerRetry.withRecheckFloor(decision, undefined, now)).toBe(decision);
    });
});
