import { readFileSync } from "node:fs"
const SNAPSHOT = process.env.HOME + "/.cache/huggingface/hub/models--Snowflake--snowflake-arctic-embed-m-v2.0/snapshots/95c2741480856aa9666782eb4afe11959938017f"
const texts: string[] = JSON.parse(readFileSync("/tmp/spike_texts.json", "utf8"))
const idsList: number[][] = JSON.parse(readFileSync("/tmp/spike_ids.json", "utf8"))
const sidecarBatch: number[][] = JSON.parse(readFileSync("/tmp/spike_sidecar_768.json", "utf8"))
const ort = await import("onnxruntime-node")
const session = await ort.InferenceSession.create(`${SNAPSHOT}/onnx/model_int8.onnx`)
const run = async (rows: number[][], padId: number) => {
  const width = Math.max(...rows.map((x) => x.length))
  const ids = new BigInt64Array(rows.length * width).fill(BigInt(padId))
  const mask = new BigInt64Array(rows.length * width)
  rows.forEach((row, i) => row.forEach((id, j) => { ids[i * width + j] = BigInt(id); mask[i * width + j] = 1n }))
  const out = await session.run({ input_ids: new ort.Tensor("int64", ids, [rows.length, width]), attention_mask: new ort.Tensor("int64", mask, [rows.length, width]) })
  const d = out.sentence_embedding.data as Float32Array; const dims = out.sentence_embedding.dims[1]
  return rows.map((_, i) => Array.from(d.subarray(i * dims, (i + 1) * dims)))
}
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0)
// hypothesis 1: each text run individually (no padding) vs sidecar BATCH output
const singles = []
for (const ids of idsList) singles.push((await run([ids], 0))[0])
singles.forEach((v, i) => console.log(`individual-run vec${i} vs sidecar-batch: cosine=${cos(v, sidecarBatch[i]).toFixed(8)}`))
// hypothesis 2: batch padded with pad_id=1 (tokenizer.json pad_id) instead of 0
const batchPad1 = await run(idsList, 1)
batchPad1.forEach((v, i) => console.log(`batch-pad1 vec${i} vs sidecar-batch: cosine=${cos(v, sidecarBatch[i]).toFixed(8)}`))
// hypothesis 3: sidecar singles vs sidecar batch (is the sidecar itself padding-sensitive?)
for (let i = 1; i < texts.length; i++) {
  const r = await fetch("http://127.0.0.1:18752/v1/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "snowflake-arctic-embed-m-v2.0", input: texts[i] }) })
  const j = await r.json()
  console.log(`sidecar-single vec${i} vs sidecar-batch: cosine=${cos(j.data[0].embedding, sidecarBatch[i]).toFixed(8)}`)
}
