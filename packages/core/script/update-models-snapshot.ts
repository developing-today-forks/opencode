#!/usr/bin/env bun
/**
 * Refreshes the bundled models.dev catalog snapshot at src/models-dev/snapshot.txt.
 * The snapshot is the boot-time floor for the catalog when no cache entry exists
 * and fetching is disabled or unavailable; live fetch still refreshes on top.
 */
import { deadlineSignal, readBoundedResponseText } from "@opencode/util/http-body"

const source = process.env.OPENCODE_MODELS_URL || "https://models.opencode.ai"
// Bounded by default (#1127): a stalled endpoint must not hang the refresh
// and an oversized body must not land in the committed snapshot. The real
// catalog is ~6 MB (235 providers, measured 2026-11-01); 32 MiB leaves >5x
// headroom while still refusing a hostile or broken response.
const FETCH_DEADLINE_MS = 30_000
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const response = await fetch(`${source}/api.json`, { signal: deadlineSignal(undefined, FETCH_DEADLINE_MS) }).catch(
  (error: Error) => {
    console.error(
      error.name === "TimeoutError" || error.name === "AbortError"
        ? `Failed to fetch ${source}/api.json: no response within the ${FETCH_DEADLINE_MS / 1000}s deadline`
        : `Failed to fetch ${source}/api.json: ${error.message}`,
    )
    process.exit(1)
  },
)
if (!response.ok) {
  console.error(`Failed to fetch ${source}/api.json: ${response.status} ${response.statusText}`)
  process.exit(1)
}
const text = await readBoundedResponseText(
  response,
  MAX_RESPONSE_BYTES,
  () => new Error(`Catalog response from ${source}/api.json exceeded the ${MAX_RESPONSE_BYTES}-byte cap`),
).catch((error: Error) => {
  console.error(
    error.name === "TimeoutError" || error.name === "AbortError"
      ? `Failed to read ${source}/api.json: body did not finish within the ${FETCH_DEADLINE_MS / 1000}s deadline`
      : `Failed to read ${source}/api.json: ${error.message}`,
  )
  process.exit(1)
})
const parsed: unknown = JSON.parse(text)
// A floor, not equality: guards against committing an error page or a
// truncated body that still parses as a small object.
const MINIMUM_PROVIDERS = 100
if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).length < MINIMUM_PROVIDERS) {
  console.error(`Fetched catalog has fewer than ${MINIMUM_PROVIDERS} providers; refusing to write snapshot`)
  process.exit(1)
}
const target = new URL("../src/models-dev/snapshot.txt", import.meta.url)
await Bun.write(target, text)
console.log(`Wrote ${Object.keys(parsed).length} providers (${text.length} bytes) to ${Bun.fileURLToPath(target)}`)
