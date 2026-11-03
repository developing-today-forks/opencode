// Spike #1554 part 2: can a JS tokenizer under Bun reproduce the sidecars
// token ids exactly? Uses @huggingface/transformers AutoTokenizer against
// the local snapshot (its JS implementation of the HF tokenizers spec:
// Precompiled normalizer + Metaspace + Unigram Viterbi).
import { readFileSync } from "node:fs"
const SNAPSHOT =
  process.env.HOME +
  "/.cache/huggingface/hub/models--Snowflake--snowflake-arctic-embed-m-v2.0/snapshots/95c2741480856aa9666782eb4afe11959938017f"
const texts: string[] = JSON.parse(readFileSync("/tmp/spike_texts.json", "utf8"))
const truth: number[][] = JSON.parse(readFileSync("/tmp/spike_ids.json", "utf8"))
const { AutoTokenizer } = await import("@huggingface/transformers")
const tok = await AutoTokenizer.from_pretrained(SNAPSHOT)
let allOk = true
texts.forEach((text, i) => {
  const got: number[] = tok.encode(text)
  const ok = JSON.stringify(got) === JSON.stringify(truth[i])
  allOk &&= ok
  console.log(`text${i}: js=${got.length} py=${truth[i].length} identical=${ok}${ok ? "" : ` js-head=${got.slice(0, 8)} py-head=${truth[i].slice(0, 8)}`}`)
})
console.log(`TOKENIZER PARITY: ${allOk ? "ALL IDENTICAL" : "MISMATCH"}`)
