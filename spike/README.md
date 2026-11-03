# Spike #1554 — native in-process embeddings under Bun

Step 1 of opencode#1554 (bake the :18752 sidecar into the fork).
Verdict: FEASIBLE — proven 2026-11-03 on the laptop (amd-6), Bun 1.4.2.

## What was proven
- `onnxruntime-node` 1.31.1 (same version as the sidecars python
  onnxruntime) loads and runs `onnx/model_int8.onnx` in-process under
  Bun. No WASM fallback needed.
- Tokenization: `@huggingface/transformers` AutoTokenizer (pure JS:
  Precompiled normalizer + Metaspace + Unigram Viterbi — this model is
  NOT BERT WordPiece) reproduces the sidecars token ids EXACTLY on all
  five test vectors, incl. mixed Japanese text (tokenizer-bun.ts).
- Inference parity vs the live sidecar, 5 texts (3..41 tokens):
  single-text output BIT-IDENTICAL (maxAbsDelta 0.0); mixed-length
  batch BIT-IDENTICAL per element once batching replicates the
  tokenizer padding config (pad right with pad_id=1, mask 0) —
  pad-probe.ts shows pad_id=0 degrades cosine to ~0.97, pad_id=1
  restores >=0.99999949 cosine with 0.0 max element delta. The int8
  graph is padding-sensitive; the sidecar itself shows the same
  single-vs-batch divergence, so "parity" = replicate its padding.
- Matryoshka 256: truncate + renormalize in JS matches sidecar at
  cosine 1.0, maxAbsDelta ~7e-9 (float64-vs-32 rounding in the
  truncation math, negligible).
- Lazy load works: import is 26 ms / +0 MB; session creation happens
  on first embed call (~1.2-1.5 s, +~380 MB RSS). Nothing loads at boot.
- Warm latency (medians, shared laptop, rough): single 15-token
  in-process 36 ms vs sidecar 22 ms; batch-32 short 288 ms vs 526 ms;
  single ~700-token 888 ms vs 1418 ms. In-process wins at batch and
  length, roughly ties on tiny singles, and drops the HTTP hop.

## Gotchas recorded for step 2
- Pin ONE onnxruntime-node version: @huggingface/transformers nests
  its own (1.30.x); two versions in one process fail on VERS_* symbol
  mismatch. Dedupe/override to a single copy (this spike forced
  1.31.1). Alternatively depend on transformers own runtime only.
- The .node binding needs libstdc++/libz on the loader path. In a bare
  dev shell on NixOS that means LD_LIBRARY_PATH (same store paths as
  ~/local-embed/run.sh); the packaged servers nix closure must
  provide them — verify in the step-2 dev loop.
- Replicate sidecar semantics exactly in the native backend: no
  truncation (tokenizer.json ships a 512 setting the sidecar
  deliberately disables), loud rejection over 8192 tokens, padding
  pad_id=1/BatchLongest/right, Matryoshka truncate+renormalize,
  prompt_tokens = summed attention-mask counts.

## Files
- ort-bun.ts — runtime proof + parity + lazy-load + timings
- pad-probe.ts — the padding-sensitivity isolation
- tokenizer-bun.ts — JS-vs-python token id parity
- warm-timing.ts — warm latency comparison
Test vectors/reference outputs were generated from the sidecars own
tokenizer + live HTTP API and kept in /tmp during the spike
(spike_texts.json / spike_ids.json / spike_sidecar_*.json).
