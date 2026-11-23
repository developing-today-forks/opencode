import { expect, test } from "bun:test"
import { nestRunning } from "./running-sessions"

// Oracle: the tree the parent map describes, walked depth-first in input order.
const parents: Record<string, string | undefined> = {
  a: "root",
  b: "root",
  a1: "a",
  a1x: "a1",
  b1: "b",
  // Its parent finished and is not listed: it hangs under the nearest listed ancestor.
  gone1: "gone",
  gone: "a",
  loop1: "loop2",
  loop2: "loop1",
}
const item = (sessionID: string) => ({ sessionID })

test("nests running subagents under the nearest listed ancestor, depth first, in input order", () => {
  const rows = nestRunning(["b1", "a", "b", "a1x", "a1", "gone1"].map(item), (id) => parents[id])
  expect(rows.map((row) => [row.item.sessionID, row.depth])).toEqual([
    ["a", 0],
    ["a1", 1],
    ["a1x", 2],
    ["gone1", 1],
    ["b", 0],
    ["b1", 1],
  ])
})

test("keeps every item exactly once, also with a parent cycle", () => {
  const ids = ["loop1", "loop2", "a"]
  const rows = nestRunning(ids.map(item), (id) => parents[id])
  expect(rows.map((row) => row.item.sessionID).toSorted()).toEqual(ids.toSorted())
})
