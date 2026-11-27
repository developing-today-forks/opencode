import { describe, expect, test } from "bun:test";
import { Model } from "@opencode/core/model";
describe("Model.parseReleaseDate (#471)", () => {
    test("parses valid YYYY-MM, YYYY-MM-DD and leap-day dates to the expected instant", () => {
        expect(Model.parseReleaseDate("2026-02")).toBe(Date.UTC(2026, 1, 1));
        expect(Model.parseReleaseDate("2026-02-03")).toBe(Date.UTC(2026, 1, 3));
        expect(Model.parseReleaseDate("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
        expect(Model.parseReleaseDate("2026-12-31")).toBe(Date.UTC(2026, 11, 31));
    });
    test("rejects calendar-invalid dates instead of yielding NaN or a rolled-over date", () => {
        for (const input of ["2026-99-99", "2026-13", "2026-00-10", "2026-02-30", "2025-02-29", "2026-04-31", "2026-01-00"])
            expect(Model.parseReleaseDate(input)).toBeUndefined();
    });
});
