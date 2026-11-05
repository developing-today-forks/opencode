import { expect, test } from "bun:test"
import { MAX_FRECENCY_ENTRIES, parseFrecency } from "../../src/prompt/frecency"
import { MAX_STASH_ENTRIES, parsePromptStash } from "../../src/prompt/stash"

test("stash JSONL skips corruption and retains newest entries", () => {
  const entries = Array.from({ length: MAX_STASH_ENTRIES + 2 }, (_, index) =>
    JSON.stringify({ prompt: { text: String(index), files: [], agents: [], pasted: [] }, timestamp: index }),
  )
  entries.splice(2, 0, "broken")
  const result = parsePromptStash(entries.join("\n"))
  expect(result).toHaveLength(MAX_STASH_ENTRIES)
  expect(result[0]?.prompt.text).toBe("2")
})

test("frecency JSONL skips corruption, keeps latest path state, and limits entries", () => {
  const entries = Array.from({ length: MAX_FRECENCY_ENTRIES + 1 }, (_, index) =>
    JSON.stringify({ path: String(index), frequency: 1, lastOpen: index }),
  )
  entries.push("broken", JSON.stringify({ path: "1000", frequency: 2, lastOpen: 2000 }))
  const result = parseFrecency(entries.join("\n"))
  expect(result).toHaveLength(MAX_FRECENCY_ENTRIES)
  expect(result[0]).toEqual({ path: "1000", frequency: 2, lastOpen: 2000 })
  expect(result.some((entry) => entry.path === "0")).toBe(false)
})

test("frecency JSONL drops entries with an invalid shape", () => {
  const entries = [
    "null",
    "123",
    '"hello"',
    "[1,2]",
    JSON.stringify({ path: 42, frequency: 1, lastOpen: 1 }),
    JSON.stringify({ path: "/wrong-frequency", frequency: "1", lastOpen: 1 }),
    JSON.stringify({ path: "/wrong-last-open", frequency: 1, lastOpen: "1" }),
    JSON.stringify({ path: "/missing-frequency", lastOpen: 1 }),
    JSON.stringify({ path: "/missing-last-open", frequency: 1 }),
    '{"path":"/infinite-frequency","frequency":1e400,"lastOpen":1}',
    '{"path":"/infinite-last-open","frequency":1,"lastOpen":-1e400}',
    JSON.stringify({ path: "/valid", frequency: 1.5, lastOpen: 2 }),
  ]

  expect(parseFrecency(entries.join("\n"))).toEqual([{ path: "/valid", frequency: 1.5, lastOpen: 2 }])
})
