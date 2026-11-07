import { ToolSchemaProjection } from "./src/protocols/utils/tool-schema.ts"
const m = ToolSchemaProjection.moonshot as any
const REF = "$" + "ref", DEFS = "$" + "defs"
console.log("ref siblings:", JSON.stringify(m({ type: "object", properties: { a: { [REF]: "#//x", description: "hello", maxLength: 5 } }, [DEFS]: { x: { type: "string" } } })))
console.log("prefix+items:", JSON.stringify(m({ type: "object", properties: { pair: { type: "array", prefixItems: [{ type: "string" }], items: { type: "integer" } } } })))
console.log("prefix only:", JSON.stringify(m({ type: "object", properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }] } } })))
