import { summarize } from "../packages/core/src/codemode/catalog.ts"
const EMOJI = "\u{1F600}"
const desc = "a".repeat(116) + EMOJI + "b".repeat(10)
const inv: any = { tools: [{ type: "tool", name: "ns.tool", description: desc, signature: "tool()" }] }
const s: any = summarize(inv, { budget: 100000 })
const line = s.namespaces[0].entries[0].line
console.log("line tail:", JSON.stringify(line.slice(-8)))
console.log("isWellFormed:", (line as any).isWellFormed())
console.log("utf8 roundtrip changed:", new TextDecoder().decode(new TextEncoder().encode(line)) !== line)
// control: pair fully before the cut
const desc2 = "a".repeat(114) + EMOJI + "b".repeat(12)
const s2: any = summarize({ tools: [{ type: "tool", name: "ns.tool", description: desc2, signature: "tool()" }] } as any, { budget: 100000 })
const line2 = s2.namespaces[0].entries[0].line
console.log("control isWellFormed:", (line2 as any).isWellFormed())
