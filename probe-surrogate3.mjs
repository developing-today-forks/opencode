// Probe: verbatim truncation expressions from main 24200c35a4, astral char straddling each cut.
// Oracle: String.prototype.isWellFormed() + U+FFFD appearance after JSON.stringify round-trip.
const E = "\u{1F600}" // 😀 = 2 UTF-16 code units
const check = (name, out) => {
  const wf = out.isWellFormed()
  const json = JSON.stringify(out)
  console.log(`${name}: len=${out.length} isWellFormed=${wf} jsonHasFFFD=${json.includes("\uFFFD")} tail=${JSON.stringify(out.slice(-3))} head=${JSON.stringify(out.slice(0,3))}`)
  return wf
}
let bad = 0
const t = (name, out) => { if (!check(name, out)) bad++ }

// 1. core tool/read-filesystem.ts:336 clampLine — line.slice(0, MAX_LINE_LENGTH=2000) + suffix
{
  const line = "a".repeat(1999) + E + "b".repeat(10)
  const clamped = line.length > 2000 ? line.slice(0, 2000) + "... (line truncated to 2000 chars)" : line
  t("read-filesystem clampLine head", clamped)
}
// 2. core session/title.ts:222 — firstUser.text.slice(0, MAX_FIRST_MESSAGE_LENGTH=2000)
{
  const text = "a".repeat(1999) + E + "b".repeat(10)
  t("title generate head :222", `Original request:\n${text.slice(0, 2000)}`)
}
// 3. core session/title.ts:236 — recent.slice(-(MAX_CONTEXT_LENGTH - prefix.length)) tail cut
{
  const prefix = "Original request:\nX\n\nRecent conversation:\n" // length governs keep
  const keep = 8000 - prefix.length
  // Build recent so the tail cut lands between the pair: total length = keep + 1, pair at index 0..1, cut starts at index 1 (low surrogate)
  const recent = E + "b".repeat(keep - 1)
  // recent.length == keep+1, slice(-keep) starts at index 1
  t("title generate tail :236", `${prefix}${recent.slice(-(8000 - prefix.length))}`)
}
// 4. ai route/executor.ts:167 providerMessage — text.slice(0, MAX_BODY_CHARS=2000)
{
  const text = "a".repeat(1999) + E + "b".repeat(100)
  t("ai executor providerMessage :167", text.length > 2000 ? `${text.slice(0, 2000)}…` : text)
}
// 5. core messaging/embedding.ts:734 + core embeddings.ts:359 — text.slice(0, 500) error excerpts
{
  const text = "a".repeat(499) + E + "b".repeat(100)
  t("embedding error excerpt :734/:359", text.slice(0, 500))
}
// 6. core messaging/search.ts:176 — errors.join("").slice(0, 500)
{
  const joined = "a".repeat(499) + E + "b".repeat(100)
  t("messaging search error :176", joined.slice(0, 500))
}
// 7. core mcp/stdio.ts:150 — (stderr + output).slice(-STDERR_TAIL=1000) tail cut
{
  const acc = E + "b".repeat(1000) // len 1002, slice(-1000) starts at index 2? adjust: want start at low surrogate index 1
  const acc2 = E + "b".repeat(999) // len 1001, slice(-1000) starts at index 1 = low surrogate
  t("mcp stdio stderr tail :150", acc2.slice(-1000))
}
// 8. core messaging/embedding.ts:798 — (tail.text + text).slice(-4096); :804/:816 slice(-1000)
{
  const acc = E + "b".repeat(4095) // len 4097, slice(-4096) starts at index 1
  t("embedding stderr tail :798", acc.slice(-4096))
  const tail = E + "b".repeat(999)
  t("embedding stderr excerpt :804", tail.trim().slice(-1000))
}
// 9. ai providers/antigravity-auth.ts:349-350 + muse-direct-auth.ts:159 — text.slice(0, 200)
{
  const text = "a".repeat(199) + E + "b".repeat(50)
  t("auth token error excerpt :200", text.slice(0, 200))
}
// 10. ai quota/cdp.ts:182 — JSON.stringify(result.exceptionDetails).slice(0, 300)
{
  const s = JSON.stringify({ text: "a".repeat(290) + E + "b".repeat(50) })
  t("quota cdp exception excerpt :182", s.slice(0, 300))
}
// Controls: guarded precedent compaction.ts truncateToolOutput (code-point counting) and a non-straddling cut
{
  const value = "a".repeat(1999) + E + "b".repeat(10)
  let end = 0, kept = 0
  for (const ch of value) { if (kept === 2000) break; end += ch.length; kept++ }
  t("CONTROL compaction guarded", `${value.slice(0, end)}\n[truncated]`)
  t("CONTROL non-straddling", ("a".repeat(1998) + E + "b".repeat(10)).slice(0, 2000))
}
console.log(`RESULT: ${bad} unguarded cuts produced lone surrogates`)
