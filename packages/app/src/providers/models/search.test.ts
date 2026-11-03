import { expect, test } from "bun:test"
import { isExactModelName, matchesModelSearch } from "./search"

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
