import { describe, expect, it } from "bun:test"
import { OpenResponses } from "../../src/protocols/open-responses.js"

// An item without an id gets a locally minted one, so this exercises the fallback
// rather than the id the provider sent.
const mintedID = (type: string) =>
  OpenResponses.normalize(
    { outputItems: {} },
    { type: "response.output_item.added", item: { type } } as OpenResponses.Event,
  ).item?.id

describe("Open Responses minted item ids", () => {
  // #908: `type` is provider-supplied, and a plain-object lookup read through
  // Object.prototype — "constructor" minted an ID holding the Object function
  // source and "__proto__" minted "[object Object]_<uuid>".
  it("uses the item fallback for prototype names", () => {
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      const id = mintedID(type)
      expect(id).toMatch(/^item_[0-9a-f]{32}$/)
      expect(id).not.toContain("function")
      expect(id).not.toContain("[object Object]")
      expect(id).not.toContain("prototype")
    }
  })

  it("keeps the known-type prefixes", () => {
    expect(mintedID("message")).toMatch(/^msg_[0-9a-f]{32}$/)
    expect(mintedID("reasoning")).toMatch(/^rs_[0-9a-f]{32}$/)
    expect(mintedID("function_call")).toMatch(/^fc_[0-9a-f]{32}$/)
    expect(mintedID("compaction")).toMatch(/^cmp_[0-9a-f]{32}$/)
  })
})
