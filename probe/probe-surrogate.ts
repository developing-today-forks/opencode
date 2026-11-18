// Probe: unguarded truncation sites outside messaging split surrogate pairs.
// 1) REAL function: CodeModeCatalog.summarize (catalog.ts:69, DESCRIPTION_LIMIT=120, cut at 117)
// 2) Title truncate expression, verbatim from session/title.ts:35 (MAX_LENGTH=100, cut at 97)
// 3) Embedding clip expression, verbatim from messaging/embedding.ts:1022 (text.slice(0, limit))
import { summarize } from "../packages/core/src/codemode/catalog.ts"

const EMOJI = "\u{1F600}" // 😀 astral: 2 UTF-16 code units

function check(name: string, out: string) {
  const well = (out as any).isWellFormed ? (out as any).isWellFormed() : undefined
  const encoded = new TextEncoder().encode(out)
  const decoded = new TextDecoder().decode(encoded)
  console.log(`${name}: isWellFormed=${well} roundTripChanged=${decoded !== out} tail=${JSON.stringify(out.slice(-6))}`)
}

// 1) catalog summarize — description first line: 116*'a' + emoji + 10*'b' (128 units > 120)
const desc = "a".repeat(116) + EMOJI + "b".repeat(10)
const inv: any = {
  tools: [{ path: "ns.tool", signature: "tool()", description: desc }],
  namespaces: [{ name: "ns", description: "ns" }],
}
try {
  const s: any = summarize(inv)
  const line = JSON.stringify(s)
  const nsLine = s.namespaces?.[0]?.tools?.[0]?.line ?? s.namespaces?.[0]?.listings?.[0]?.line ?? ""
  console.log("catalog summary keys:", Object.keys(s), JSON.stringify(s).slice(0, 400))
  if (nsLine) check("catalog-line", nsLine)
  check("catalog-json", line)
} catch (e) { console.log("catalog summarize threw:", String(e).slice(0, 300)) }

// 2) title truncate verbatim (title.ts:35)
const MAX_LENGTH = 100
const truncate = (value: string) => (value.length <= MAX_LENGTH ? value : `${value.slice(0, MAX_LENGTH - 3)}...`)
check("title-truncate", truncate("a".repeat(96) + EMOJI + "b".repeat(10)))
// control: boundary not straddling
check("title-control", truncate("a".repeat(95) + EMOJI + "b".repeat(10)))

// 3) embedding clip verbatim (embedding.ts:1022) with limit straddling a pair
const limit = 51
const clipped = ("x".repeat(50) + EMOJI + "y".repeat(10)).slice(0, limit)
check("embedding-clip", clipped)

// 4) inputExcerpt verbatim (publish-llm-event.ts) INPUT_EXCERPT_LIMIT unknown here; same slice semantics at any limit
check("excerpt-2000", ("z".repeat(1999) + EMOJI + "w".repeat(5)).slice(0, 2000))
