import { readFileSync } from "node:fs"
const SNAPSHOT = process.env.HOME + "/.cache/huggingface/hub/models--Snowflake--snowflake-arctic-embed-m-v2.0/snapshots/95c2741480856aa9666782eb4afe11959938017f"
const texts: string[] = JSON.parse(readFileSync("/tmp/spike_texts.json", "utf8"))
const ort = await import("onnxruntime-node")
const { AutoTokenizer } = await import("@huggingface/transformers")
const tok = await AutoTokenizer.from_pretrained(SNAPSHOT)
const session = await ort.InferenceSession.create(`${SNAPSHOT}/onnx/model_int8.onnx`)
const embed = async (batch: string[]) => {
  const rows = batch.map((t) => tok.encode(t) as number[])
  const width = Math.max(...rows.map((x) => x.length))
  const ids = new BigInt64Array(rows.length * width).fill(1n)
  const mask = new BigInt64Array(rows.length * width)
  rows.forEach((row, i) => row.forEach((id, j) => { ids[i * width + j] = BigInt(id); mask[i * width + j] = 1n }))
  await session.run({ input_ids: new ort.Tensor("int64", ids, [rows.length, width]), attention_mask: new ort.Tensor("int64", mask, [rows.length, width]) })
}
await embed([texts[0]]) // warm
const bench = async (label: string, batch: string[], n = 5) => {
  const times: number[] = []
  for (let i = 0; i < n; i++) { const t = performance.now(); await embed(batch); times.push(performance.now() - t) }
  console.log(`${label}: median ${times.sort((a, b) => a - b)[Math.floor(n / 2)].toFixed(1)} ms  all=[${times.map((x) => x.toFixed(0)).join(",")}]`)
}
await bench("in-process warm single (15 tok)", [texts[0]])
await bench("in-process warm batch5 (mixed 3..41 tok)", texts)
await bench("in-process warm batch32 short", Array(32).fill(texts[0]))
const longText = ("The history of embedding models spans word2vec to transformers. " ).repeat(60) // ~700+ tokens
await bench("in-process warm single long (~700 tok)", [longText], 3)
const side = async (label: string, input: unknown, n = 5) => {
  const times: number[] = []
  for (let i = 0; i < n; i++) { const t = performance.now(); await fetch("http://127.0.0.1:18752/v1/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "snowflake-arctic-embed-m-v2.0", input }) }); times.push(performance.now() - t) }
  console.log(`${label}: median ${times.sort((a, b) => a - b)[Math.floor(n / 2)].toFixed(1)} ms  all=[${times.map((x) => x.toFixed(0)).join(",")}]`)
}
await side("sidecar warm single (15 tok)", texts[0])
await side("sidecar warm batch32 short", Array(32).fill(texts[0]))
await side("sidecar warm single long (~700 tok)", longText, 3)
console.log(`rss: ${Math.round(process.memoryUsage().rss / 1048576)} MB (model resident)`)
