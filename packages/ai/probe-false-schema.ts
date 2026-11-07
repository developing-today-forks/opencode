import { convertSchema } from "./src/protocols/antigravity.ts"
console.log("prop false:", JSON.stringify(convertSchema({ type: "object", properties: { extra: false, name: { type: "string" } }, required: ["name"] })))
console.log("items false:", JSON.stringify(convertSchema({ type: "array", items: false })))
console.log("anyOf false branch:", JSON.stringify(convertSchema({ type: "object", properties: { v: { anyOf: [{ type: "string" }, false] } } })))
console.log("top-level false:", JSON.stringify(convertSchema(false)))
console.log("enum null:", JSON.stringify(convertSchema({ type: "object", properties: { mode: { type: "string", enum: ["a", null] } } })))
