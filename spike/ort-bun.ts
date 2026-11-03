// Spike #1554 part 1: does onnxruntime-node run the arctic-embed int8
// model in-process under Bun, lazily, with sidecar-identical output?
// Token ids come from /tmp/spike_ids.json (produced by the sidecars own
// tokenizer stack) so this isolates the inference runtime question.
import { readFileSync } from "node:fs"

const SNAPSHOT =
  process.env.HOME +
  "/.cache/huggingface/hub/models--Snowflake--snowflake-arctic-embed-m-v2.0/snapshots/95c2741480856aa9666782eb4afe11959938017f"
const texts: string[] = JSON.parse(readFileSync("/tmp/spike_texts.json", "utf8"))
const idsList: number[][] = JSON.parse(readFileSync("/tmp/spike_ids.json", "utf8"))
const sidecar768: number[][] = JSON.parse(readFileSync("/tmp/spike_sidecar_768.json", "utf8"))
const sidecar256: number[][] = JSON.parse(readFileSync("/tmp/spike_sidecar_256.json", "utf8"))
const sidecarSingle: number[][] = JSON.parse(readFileSync("/tmp/spike_sidecar_single.json", "utf8"))

const rss = () => Math.round(process.memoryUsage().rss / 1048576)
const compare = (label: string, mine: number[][], theirs: number[][]) => {
  for (let i = 0; i < mine.length; i++) {
    let dot = 0, maxDelta = 0
    for (let j = 0; j < mine[i].length; j++) {
      dot += mine[i][j] * theirs[i][j]
      maxDelta = Math.max(maxDelta, Math.abs(mine[i][j] - theirs[i][j]))
    }
    console.log(`${label} vec${i}: cosine=${dot.toFixed(8)} maxAbsDelta=${maxDelta.toExponential(3)} dims=${mine[i].length}`)
  }
}

console.log(`rss before load: ${rss()} MB`)
const t0 = performance.now()
const ort = await import("onnxruntime-node")
console.log(`onnxruntime-node import: ${(performance.now() - t0).toFixed(0)} ms (version ${ort.env.versions?.onnxruntime ?? "?"})`)

// Lazy session: created on first embed call, not at module scope.
let session: any
const getSession = async () => {
  if (!session) {
    const start = performance.now()
    session = await ort.InferenceSession.create(`${SNAPSHOT}/onnx/model_int8.onnx`)
    console.log(`session create (lazy, first call): ${(performance.now() - start).toFixed(0)} ms; rss after load: ${rss()} MB`)
    console.log(`inputs=${session.inputNames} outputs=${session.outputNames}`)
  }
  return session
}

const embedIds = async (batch: number[][]) => {
  const s = await getSession()
  const width = Math.max(...batch.map((x) => x.length))
  const ids = new BigInt64Array(batch.length * width).fill(1n) // pad_id=1 per tokenizer.json padding config
  const mask = new BigInt64Array(batch.length * width)
  batch.forEach((row, i) => row.forEach((id, j) => { ids[i * width + j] = BigInt(id); mask[i * width + j] = 1n }))
  const out = await s.run({
    input_ids: new ort.Tensor("int64", ids, [batch.length, width]),
    attention_mask: new ort.Tensor("int64", mask, [batch.length, width]),
  })
  const data = out.sentence_embedding.data as Float32Array
  const dims = out.sentence_embedding.dims[1]
  return batch.map((_, i) => Array.from(data.subarray(i * dims, (i + 1) * dims)))
}

// single-text latency
let start = performance.now()
const single = await embedIds([idsList[0]])
console.log(`single-text in-process: ${(performance.now() - start).toFixed(1)} ms`)
compare("single vs sidecar", single, sidecarSingle)

// mixed-length batch (all five texts, lengths 15/12/31/3/41) in one call
start = performance.now()
const batch = await embedIds(idsList)
console.log(`batch-of-5 in-process: ${(performance.now() - start).toFixed(1)} ms`)
compare("batch768 vs sidecar", batch, sidecar768)

// Matryoshka 256: truncate + renormalize (sidecar semantics)
const trunc = (v: number[], d: number) => {
  const s = v.slice(0, d); const n = Math.hypot(...s); return n > 0 ? s.map((x) => x / n) : s
}
compare("batch256(mine-trunc) vs sidecar", batch.map((v) => trunc(v, 256)), sidecar256)

// sidecar latency for comparison (same payloads, warm)
for (const [label, payload] of [["single", { input: texts[0] }], ["batch5", { input: texts }]] as const) {
  const t = performance.now()
  await fetch("http://127.0.0.1:18752/v1/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "snowflake-arctic-embed-m-v2.0", ...payload }) })
  console.log(`sidecar ${label}: ${(performance.now() - t).toFixed(1)} ms (incl. HTTP loopback)`)
}
console.log(`rss at end: ${rss()} MB`)
