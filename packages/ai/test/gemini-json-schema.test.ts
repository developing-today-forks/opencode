import { describe, expect, test } from "bun:test"
import { GeminiJsonSchema } from "../src/protocols/utils/gemini-json-schema.js"
import type { JsonSchema } from "../src/schema/index.js"

const normalize = (schema: unknown) => GeminiJsonSchema.normalize(schema as JsonSchema)

describe("GeminiJsonSchema.normalize loop cutting", () => {
  test("cuts a direct self-loop through a required property (control)", () => {
    const out = normalize({
      $defs: {
        node: {
          type: "object",
          properties: { child: { $ref: "#/$defs/node" } },
          required: ["child"],
        },
      },
      properties: { root: { $ref: "#/$defs/node" } },
    }) as Record<string, any>
    expect(out.$defs.node.properties.child).toEqual({})
    expect(out.properties.root).toEqual({ $ref: "#/$defs/node" })
  })

  test("cuts a mutually recursive pair whose steps are all required (#1585)", () => {
    const out = normalize({
      $defs: {
        A: { type: "object", properties: { b: { $ref: "#/$defs/B" } }, required: ["b"] },
        B: { type: "object", properties: { a: { $ref: "#/$defs/A" } }, required: ["a"] },
      },
      properties: { root: { $ref: "#/$defs/A" } },
    }) as Record<string, any>
    const aRef = out.$defs.A.properties.b.$ref
    const bRef = out.$defs.B.properties.a.$ref
    // At least one link of the cycle is cut; the cycle no longer closes.
    expect(aRef === undefined || bRef === undefined).toBe(true)
    expect(out.properties.root).toEqual({ $ref: "#/$defs/A" })
  })

  test("keeps a mutually recursive pair with one optional step (#1585)", () => {
    const schema = {
      $defs: {
        A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
        B: { type: "object", properties: { a: { $ref: "#/$defs/A" } }, required: ["a"] },
      },
      properties: { root: { $ref: "#/$defs/A" } },
    }
    const out = normalize(schema) as Record<string, any>
    expect(out.$defs.A.properties.b).toEqual({ $ref: "#/$defs/B" })
    expect(out.$defs.B.properties.a).toEqual({ $ref: "#/$defs/A" })
  })

  test("cuts a three-def required cycle (#1585)", () => {
    const out = normalize({
      $defs: {
        A: { type: "object", properties: { b: { $ref: "#/$defs/B" } }, required: ["b"] },
        B: { type: "object", properties: { c: { $ref: "#/$defs/C" } }, required: ["c"] },
        C: { type: "object", properties: { a: { $ref: "#/$defs/A" } }, required: ["a"] },
      },
      properties: { root: { $ref: "#/$defs/A" } },
    }) as Record<string, any>
    const refs = [out.$defs.A.properties.b.$ref, out.$defs.B.properties.c.$ref, out.$defs.C.properties.a.$ref]
    expect(refs.some((ref) => ref === undefined)).toBe(true)
  })

  test("cuts a mutual cycle through items with minItems > 0 and keeps the potentially-empty-items cycle", () => {
    const cut = normalize({
      $defs: {
        A: { type: "object", properties: { bs: { type: "array", items: { $ref: "#/$defs/B" }, minItems: 1 } }, required: ["bs"] },
        B: { type: "object", properties: { a: { $ref: "#/$defs/A" } }, required: ["a"] },
      },
    }) as Record<string, any>
    expect(cut.$defs.A.properties.bs.items.$ref === undefined || cut.$defs.B.properties.a.$ref === undefined).toBe(true)

    const kept = normalize({
      $defs: {
        A: { type: "object", properties: { bs: { type: "array", items: { $ref: "#/$defs/B" } } }, required: ["bs"] },
        B: { type: "object", properties: { a: { $ref: "#/$defs/A" } }, required: ["a"] },
      },
    }) as Record<string, any>
    expect(kept.$defs.A.properties.bs.items).toEqual({ $ref: "#/$defs/B" })
    expect(kept.$defs.B.properties.a).toEqual({ $ref: "#/$defs/A" })
  })

  test("cuts a mutual cycle under definitions as well as $defs", () => {
    const out = normalize({
      definitions: {
        A: { type: "object", properties: { b: { $ref: "#/definitions/B" } }, required: ["b"] },
        B: { type: "object", properties: { a: { $ref: "#/definitions/A" } }, required: ["a"] },
      },
    }) as Record<string, any>
    expect(out.definitions.A.properties.b.$ref === undefined || out.definitions.B.properties.a.$ref === undefined).toBe(
      true,
    )
  })
})
