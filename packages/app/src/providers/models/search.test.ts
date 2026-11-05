import { expect, test } from "bun:test"
import { isExactModelName, matchesModelSearch, matchesWildcardSearch } from "./search"

test.each([
  ["gpt 5", ["GPT-5.5"], true],
  ["gpt-5", ["GPT-5.5"], true],
  ["gpt5", ["GPT-5.5"], true],
  ["open ai", ["GPT-5.5", "gpt-5.5", "OpenAI"], true],
  ["gpt 5", ["GPT-5.5", "gpt-5.5", "OpenAI"], true],
  ["claude", ["GPT-5.5", "gpt-5.5", "OpenAI"], false],
])("matchesModelSearch(%p, %p) is %p", (query, fields, expected) => {
  expect(matchesModelSearch(query, fields)).toBe(expected)
})

test.each([
  ["Muse Wonder smoke", ["Muse Wonder smoke"], true],
  ["muse wonder smoke", ["Muse Wonder smoke"], true],
  [" custom/pooled ", ["custom/pooled"], true],
  ["pooled", ["Pooled", "pooled", "custom/pooled"], true],
  ["pool", ["Pooled", "pooled", "custom/pooled"], false],
  ["custom/pool", ["Pooled", "pooled", "custom/pooled"], false],
  ["", ["pooled"], false],
  ["pooled", [], false],
])("isExactModelName(%p, %p) is %p", (query, fields, expected) => {
  expect(isExactModelName(query, fields)).toBe(expected)
})

test.each([
  // No-slash patterns match the model id across providers (#230, PR #233 rule).
  ["gpt-*", ["GPT-5.5", "gpt-5.5", "OpenAI"], true],
  ["*luna*", ["luna-6", "openai/luna-6"], true],
  ["*-mini", ["gpt-5-mini", "openai/gpt-5-mini"], true],
  ["gpt-*", ["claude-sonnet-5", "anthropic/claude-sonnet-5"], false],
  ["a*", ["anthropic/claude-sonnet-5"], false],
  ["c*", ["anthropic/claude-sonnet-5"], true],
  ["GPT-*", ["gpt-5.5"], true],
  // Slash patterns match the full provider/model text.
  ["openai/*", ["gpt-5.5", "openai/gpt-5.5"], true],
  ["openai/gpt-*", ["gpt-5.5", "openai/gpt-5.5"], true],
  ["anthropic/*", ["gpt-5.5", "openai/gpt-5.5"], false],
  ["*/gpt-*", ["openai/gpt-5.5"], true],
  // Non-wildcard queries are not wildcard matches.
  ["gpt-5", ["gpt-5.5"], false],
  ["", ["gpt-5.5"], false],
])("matchesWildcardSearch(%p, %p) is %p", (query, fields, expected) => {
  expect(matchesWildcardSearch(query, fields)).toBe(expected)
})

test.each([
  ["gpt-*", ["GPT-5.5", "gpt-5.5", "OpenAI"], true],
  ["openai/*", ["GPT-5.5", "gpt-5.5", "OpenAI", "openai/gpt-5.5"], true],
  ["claude-*", ["GPT-5.5", "gpt-5.5", "OpenAI"], false],
])("matchesModelSearch wildcard (%p, %p) is %p", (query, fields, expected) => {
  expect(matchesModelSearch(query, fields)).toBe(expected)
})
