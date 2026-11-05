import { expect, test } from "bun:test"
import { isWildcardSearch, matchesWildcardSearch } from "../../src/component/model-search"

// Same cases as the app picker's search.test.ts wildcard suite (#230): the
// two pickers must agree on slash/no-slash patterns and hidden-reveal matches.
test.each([
  ["gpt-*", ["GPT-5.5", "gpt-5.5", "OpenAI"], true],
  ["*luna*", ["luna-6", "openai/luna-6"], true],
  ["*-mini", ["gpt-5-mini", "openai/gpt-5-mini"], true],
  ["gpt-*", ["claude-sonnet-5", "anthropic/claude-sonnet-5"], false],
  ["a*", ["anthropic/claude-sonnet-5"], false],
  ["c*", ["anthropic/claude-sonnet-5"], true],
  ["GPT-*", ["gpt-5.5"], true],
  ["openai/*", ["gpt-5.5", "openai/gpt-5.5"], true],
  ["openai/gpt-*", ["gpt-5.5", "openai/gpt-5.5"], true],
  ["anthropic/*", ["gpt-5.5", "openai/gpt-5.5"], false],
  ["*/gpt-*", ["openai/gpt-5.5"], true],
  ["gpt-5", ["gpt-5.5"], false],
  ["", ["gpt-5.5"], false],
])("matchesWildcardSearch(%p, %p) is %p", (query, fields, expected) => {
  expect(matchesWildcardSearch(query, fields)).toBe(expected)
})

test("isWildcardSearch only fires on a * in the query", () => {
  expect(isWildcardSearch("gpt-*")).toBe(true)
  expect(isWildcardSearch("gpt-5")).toBe(false)
  expect(isWildcardSearch("")).toBe(false)
})
