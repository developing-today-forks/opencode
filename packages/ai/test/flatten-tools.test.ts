import { describe, expect, test } from "bun:test"
import { ai, LanguageModel } from "../src/effect.js"
import * as OpenAIResponses from "../src/protocols/openai-responses.js"
import { ProviderShared } from "../src/protocols/shared.js"
import { ToolEntry } from "../src/schema/index.js"

// Issue #2233 (decomposed from #1707): flattenTools joins namespace + leaf
// names with an unescaped "_" and dedupes the result through a Map, so two
// distinct tools can flatten to the same provider-facing name and one of
// them is silently dropped. These tests pin that current behavior — the
// collision case is named here so a future guard or escaping change has to
// update this file deliberately instead of changing wire behavior silently.
describe("flattenTools namespace flattening (#2233)", () => {
  const tool = (name: string, description: string) =>
    ToolEntry.make({ name, description, inputSchema: { type: "object" } })
  const namespace = (name: string, tools: ReadonlyArray<ToolEntry>) =>
    ToolEntry.make({ type: "namespace", name, tools })

  test("joins namespace path and leaf name with an underscore", () => {
    const flat = ProviderShared.flattenTools([namespace("a", [tool("b", "namespaced b")])])
    expect(flat.map((entry) => entry.name)).toEqual(["a_b"])
    expect(flat[0]?.description).toBe("namespaced b")
  })

  test("keeps non-colliding namespaced and top-level tools side by side", () => {
    const flat = ProviderShared.flattenTools([
      namespace("a", [tool("b", "namespaced b"), tool("c", "namespaced c")]),
      tool("d", "top-level d"),
    ])
    expect(flat.map((entry) => entry.name)).toEqual(["a_b", "a_c", "d"])
  })

  test("collision: tool b_c in namespace a silently collides with tool c in namespace a_b (last definition wins)", () => {
    const flat = ProviderShared.flattenTools([
      namespace("a", [tool("b_c", "tool b_c in namespace a")]),
      namespace("a_b", [tool("c", "tool c in namespace a_b")]),
    ])
    // Both leaves flatten to "a_b_c"; the Map dedupe keeps exactly one entry —
    // the later definition — and the earlier tool is dropped with no error.
    expect(flat).toHaveLength(1)
    expect(flat[0]?.name).toBe("a_b_c")
    expect(flat[0]?.description).toBe("tool c in namespace a_b")
  })

  test("collision: a top-level tool named a_b silently collides with tool b in namespace a (last definition wins)", () => {
    const flat = ProviderShared.flattenTools([
      tool("a_b", "top-level a_b"),
      namespace("a", [tool("b", "tool b in namespace a")]),
    ])
    expect(flat).toHaveLength(1)
    expect(flat[0]?.name).toBe("a_b")
    expect(flat[0]?.description).toBe("tool b in namespace a")
  })

  test("flattenToolRequest projects the same collision onto the request tools", () => {
    const request = ai.request({
      model: LanguageModel.make({ id: "fake-model", provider: "fake", route: OpenAIResponses.route }),
      messages: [],
      tools: [
        {
          type: "namespace",
          name: "a",
          tools: [{ name: "b", description: "tool b in namespace a", inputSchema: { type: "object" } }],
        },
        { name: "a_b", description: "top-level a_b", inputSchema: { type: "object" } },
      ],
    })
    const { tools } = ProviderShared.flattenToolRequest(request)
    expect(tools.map((entry) => entry.name)).toEqual(["a_b"])
    expect(tools[0]?.description).toBe("top-level a_b")
  })
})
