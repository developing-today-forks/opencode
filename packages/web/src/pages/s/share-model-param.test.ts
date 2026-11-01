import { describe, expect, test } from "bun:test"
import { shareModelParam } from "./share-model-param"

describe("shareModelParam", () => {
  test.each([
    { models: [], expected: "" },
    { models: ["gpt-x"], expected: "gpt-x" },
    { models: ["m1", "m2"], expected: "m1%20%26%20m2" },
    { models: ["m1", "m2", "m3"], expected: "m1%20%26%202%20others" },
    { models: ["m1", "m2", "m3", "m4"], expected: "m1%20%26%203%20others" },
  ])("maps $models to $expected", ({ models, expected }) => {
    expect(shareModelParam(models)).toBe(expected)
  })
})
