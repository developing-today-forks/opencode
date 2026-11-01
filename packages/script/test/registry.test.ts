import { describe, expect, test } from "bun:test"
import { MAX_REGISTRY_DOC_BYTES, REGISTRY_FETCH_TIMEOUT_MS, fetchRegistryVersion } from "../src/registry"

const doc = (version: string) => JSON.stringify({ name: "@opencode/cli", version })

const fetchReturning = (response: Response | (() => Response)) =>
  (async () => (typeof response === "function" ? response() : response)) as unknown as typeof fetch

describe("fetchRegistryVersion (#1275)", () => {
  test("the shipped bounds are 8s and 1 MiB", () => {
    expect(REGISTRY_FETCH_TIMEOUT_MS).toBe(8_000)
    expect(MAX_REGISTRY_DOC_BYTES).toBe(1024 * 1024)
  })

  test("a healthy registry doc yields its version", async () => {
    const fetchImpl = fetchReturning(
      new Response(doc("2.3.4"), { headers: { "content-type": "application/json" } }),
    )
    expect(await fetchRegistryVersion(fetchImpl)).toBe("2.3.4")
  })

  test("a non-OK status throws as before", async () => {
    const fetchImpl = fetchReturning(new Response("nope", { status: 503, statusText: "Service Unavailable" }))
    await expect(fetchRegistryVersion(fetchImpl)).rejects.toThrow("Service Unavailable")
  })

  test("a stalled registry settles as a thrown error at the deadline, not a hang", async () => {
    const stalled = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })) as unknown as typeof fetch
    const start = Date.now()
    await expect(fetchRegistryVersion(stalled, { timeoutMs: 50 })).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  test("a declared content-length over the cap fails fast", async () => {
    const fetchImpl = fetchReturning(
      new Response(doc("2.3.4"), { headers: { "content-length": String(2048) } }),
    )
    await expect(fetchRegistryVersion(fetchImpl, { maxBytes: 1024 })).rejects.toThrow("exceeded size limit")
  })

  test("a streamed body over the cap is rejected at the cap, not buffered whole", async () => {
    const chunk = new TextEncoder().encode(doc("2.3.4").padEnd(512, " "))
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
    })
    const fetchImpl = fetchReturning(new Response(stream))
    await expect(fetchRegistryVersion(fetchImpl, { maxBytes: 1024 })).rejects.toThrow("exceeded size limit")
  })

  test("a doc without a version string throws", async () => {
    const fetchImpl = fetchReturning(new Response(JSON.stringify({ name: "@opencode/cli" })))
    await expect(fetchRegistryVersion(fetchImpl)).rejects.toThrow("no version")
  })
})
