import { GeminiJsonSchema } from "./src/protocols/utils/gemini-json-schema.js"
const show = (name: string, input: unknown) => console.log(name, JSON.stringify(GeminiJsonSchema.normalize(input as never)))
// control: recursion through optional property (no required) — kept per design
show("optional-prop", { type: "object", properties: { child: { $ref: "#" } } })
// recursion through additionalProperties (values need not exist; empty object terminates)
show("additionalProps", { type: "object", additionalProperties: { $ref: "#" } })
// recursion through an anyOf alternative (branch need not be taken)
show("anyOf-alt", { anyOf: [{ $ref: "#" }, { type: "string" }] })
// recursion through prefixItems (array may be shorter than the tuple)
show("prefixItems", { type: "array", prefixItems: [{ $ref: "#" }] })
