import { ToolSchemaProjection } from "./src/protocols/utils/tool-schema.js"
const show = (name: string, input: unknown) =>
  console.log(name, "\n  in :", JSON.stringify(input), "\n  out:", JSON.stringify(ToolSchemaProjection.moonshot(input as never)))
// structured enum value: an object literal whose "items" key is DATA, not a tuple schema
show("enum-object-items", { type: "object", properties: { v: { enum: [{ items: ["a", "b"] }] } } })
show("enum-object-ref", { type: "object", properties: { v: { enum: [{ $ref: "#/x", extra: 1 }] } } })
show("enum-object-prefixItems", { type: "object", properties: { v: { enum: [{ prefixItems: [{ type: "string" }], note: "keep" }] } } })
show("default-object-items", { type: "object", properties: { v: { type: "object", default: { items: [1, 2, 3] } } } })
show("const-object", { type: "object", properties: { v: { const: { items: ["x"] } } } })
// controls: scalar enums + ordinary schema recursion must be unchanged
show("scalar-enum control", { type: "object", properties: { v: { enum: ["a", "b"] } } })
show("tuple control", { type: "object", properties: { v: { type: "array", items: [{ type: "string" }, { type: "number" }] } } })
show("plain control", { type: "object", properties: { v: { type: "string", minLength: 2 } }, required: ["v"] })
