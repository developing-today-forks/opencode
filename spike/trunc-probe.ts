const SNAPSHOT = process.env.HOME + "/.cache/huggingface/hub/models--Snowflake--snowflake-arctic-embed-m-v2.0/snapshots/95c2741480856aa9666782eb4afe11959938017f"
const long = "word ".repeat(3000)
const resp = await fetch("http://127.0.0.1:18752/v1/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "snowflake-arctic-embed-m-v2.0", input: long }) })
const body = await resp.json()
console.log("sidecar prompt_tokens for 3000-word text:", body.usage?.prompt_tokens)
const { AutoTokenizer } = await import("@huggingface/transformers")
const tok: any = await AutoTokenizer.from_pretrained(SNAPSHOT)
console.log("encode() length:", tok.encode(long).length)
try {
  const out = tok(long, { truncation: false, padding: false, return_tensor: false })
  console.log("callable truncation:false input_ids length:", out.input_ids?.length)
} catch (e) { console.log("callable form failed:", String(e).slice(0, 200)) }
try {
  const out2 = tok(long, { return_tensor: false })
  console.log("callable default input_ids length:", out2.input_ids?.length)
} catch (e) { console.log("callable default failed:", String(e).slice(0, 200)) }
