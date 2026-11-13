import { expect, test } from "bun:test"
import { SessionsCursor } from "@opencode/protocol/groups/session"
import { Session } from "@opencode/schema/session"
import { Project } from "@opencode/schema/project"
import { AbsolutePath, RelativePath } from "@opencode/schema/schema"
import { Effect } from "effect"
import {
  decodeSessionListCursor,
  encodeSessionListCursor,
  type SessionListFilter,
} from "@opencode/core/plugin/session-list"

const anchor = { id: Session.ID.make("ses_anchor_1"), time: 1_700_000_000_000, direction: "next" as const }

const filters: ReadonlyArray<{ readonly name: string; readonly filter: SessionListFilter }> = [
  { name: "empty", filter: {} },
  { name: "parentID", filter: { parentID: Session.ID.make("ses_parent_1") } },
  { name: "root sessions", filter: { parentID: null } },
  { name: "search and order", filter: { search: "tokenscope", order: "asc" } },
  { name: "directory", filter: { directory: AbsolutePath.make("/tmp/opencode-test") } },
  {
    name: "project and subpath",
    filter: { project: Project.ID.make("prj_test"), subpath: RelativePath.make("src/index.ts") },
  },
]

for (const { name, filter } of filters) {
  test(`session list cursor round-trips ${name}`, async () => {
    const cursor = encodeSessionListCursor(filter, anchor)
    const decoded = await Effect.runPromise(decodeSessionListCursor(cursor))
    expect(decoded).toEqual({ ...filter, anchor })
  })

  test(`session list cursor matches the HTTP codec (${name})`, async () => {
    const viaProtocol = SessionsCursor.make({ ...filter, anchor })
    const decoded = await Effect.runPromise(decodeSessionListCursor(viaProtocol))
    expect(decoded).toEqual({ ...filter, anchor })
    const parsed = await Effect.runPromise(SessionsCursor.parse(encodeSessionListCursor(filter, anchor)))
    expect(parsed).toEqual({ ...filter, anchor })
  })
}

test("session list cursor encodes a null parentID as the HTTP codec does", () => {
  const body = JSON.parse(Buffer.from(encodeSessionListCursor({ parentID: null }, anchor), "base64url").toString())
  expect(body.parentID).toBe("null")
})

test("session list cursor rejects invalid input", async () => {
  await expect(Effect.runPromise(decodeSessionListCursor("!!!"))).rejects.toThrow("Invalid session list cursor")
  const missingAnchor = Buffer.from(JSON.stringify({ parentID: null })).toString("base64url")
  await expect(Effect.runPromise(decodeSessionListCursor(missingAnchor))).rejects.toThrow(
    "Invalid session list cursor",
  )
})
