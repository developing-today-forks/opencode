import { convertSchema } from "./src/protocols/antigravity.js"
const show = (name: string, input: unknown) => console.log(name, JSON.stringify(convertSchema(input as never)), "| anthropic:", JSON.stringify(convertSchema(input as never, true)))
// candidate roots: constraint keywords that apply to exactly one non-object type, with no type/items/enum/branch keyword
show("minItems-only", { minItems: 2 })
show("maxItems-only", { maxItems: 3 })
show("minLength-only", { minLength: 2 })
show("pattern-only", { pattern: "^a+$" })
show("minimum-only", { minimum: 5 })
show("exclusiveMin-via-minimum", { minimum: 5, maximum: 9 })
// controls pinned by #1901 / #1667 / ordinary shapes
show("enum-only control", { enum: ["a", "b"] })
show("items-only control", { items: { type: "string" } })
show("plain-object control", { type: "object", properties: { v: { type: "string", minLength: 2 } }, required: ["v"] })
show("empty control", {})
show("minProperties-only (object keyword)", { minProperties: 1 })
show("nested minItems (non-root, no forcing expected)", { type: "object", properties: { v: { minItems: 2 } } })
