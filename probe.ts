import { convertSchema } from "/home/user/git/fleet/probe-2026-11-03-creator/packages/ai/src/protocols/antigravity.ts"
const show = (label: string, v: unknown) => console.log(label, JSON.stringify(v))
show("multi-type prop:", convertSchema({ type: "object", properties: { mode: { type: ["string", "integer"] } } }))
show("multi-type anthropic:", convertSchema({ type: "object", properties: { mode: { type: ["string", "integer"] } } }, true))
show("type+null:", convertSchema({ type: "object", properties: { mode: { type: ["string", "null"] } } }))
show("const prop:", convertSchema({ type: "object", properties: { kind: { const: "fixed" } } }))
show("enum prop:", convertSchema({ type: "object", properties: { kind: { type: "string", enum: ["a", "b"] } } }))
show("multi-type root:", convertSchema({ type: ["string", "integer"] }))
