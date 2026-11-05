// @ts-nocheck — worker test driving the fetch handler with a mocked R2
// bucket; the services/files package has no test-time type setup yet.
// Range behavior pins the #1646 probe table against RFC 9110 14.1-14.2
// and the README contract: invalid range sets are ignored (full 200),
// only truly unsatisfiable ranges get 416.
import { describe, expect, test } from "bun:test"
import worker from "./index.ts"

const CONTENT = "0123456789"
const UPLOADED = new Date("2026-01-01T00:00:00Z")

const objectMeta = {
  size: CONTENT.length,
  etag: "etag-1",
  httpEtag: '"etag-1"',
  uploaded: UPLOADED,
  writeHttpMetadata: (headers) => headers.set("Content-Type", "text/plain"),
}

const bucket = {
  head: async (key) => (key === "a.txt" ? objectMeta : null),
  get: async (key, options) => {
    if (key !== "a.txt") return null
    const range = options?.range
    const bytes = range
      ? CONTENT.slice(range.offset, range.offset + range.length)
      : CONTENT
    return { ...objectMeta, body: new TextEncoder().encode(bytes) }
  },
}

const env = { FILES: bucket }
const ctx = { waitUntil: () => {} }

// The Cache API is a worker runtime global; tests stub it as an always-miss
// cache. Requests also send no-store where they must not depend on it.
// @ts-expect-error runtime global stub
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } }

const fetchFile = (headers = {}, method = "GET") =>
  worker.fetch(new Request("https://files.test/files/a.txt", { method, headers }), env, ctx)

describe("files worker range handling (#1646)", () => {
  test("no Range serves the full object with 200", async () => {
    const response = await fetchFile({ "Cache-Control": "no-store" })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(CONTENT)
  })

  test("bytes=-0 is an invalid range set: ignored, full 200 (RFC 9110 14.2)", async () => {
    const response = await fetchFile({ Range: "bytes=-0", "Cache-Control": "no-store" })
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Range")).toBeNull()
    expect(await response.text()).toBe(CONTENT)
  })

  test("bytes=5-3 is an invalid range set: ignored, full 200 (RFC 9110 14.2)", async () => {
    const response = await fetchFile({ Range: "bytes=5-3", "Cache-Control": "no-store" })
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Range")).toBeNull()
    expect(await response.text()).toBe(CONTENT)
  })

  test("bytes=50- is well-formed but unsatisfiable: 416", async () => {
    const response = await fetchFile({ Range: "bytes=50-", "Cache-Control": "no-store" })
    expect(response.status).toBe(416)
    expect(response.headers.get("Content-Range")).toBe("bytes */10")
  })

  test("a multipart range is ignored, full 200", async () => {
    const response = await fetchFile({ Range: "bytes=0-1,3-4", "Cache-Control": "no-store" })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(CONTENT)
  })

  test("bytes=2-5 serves 206 with exactly those bytes", async () => {
    const response = await fetchFile({ Range: "bytes=2-5", "Cache-Control": "no-store" })
    expect(response.status).toBe(206)
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10")
    expect(await response.text()).toBe("2345")
  })

  test("bytes=-3 serves the last three bytes with 206", async () => {
    const response = await fetchFile({ Range: "bytes=-3", "Cache-Control": "no-store" })
    expect(response.status).toBe(206)
    expect(response.headers.get("Content-Range")).toBe("bytes 7-9/10")
    expect(await response.text()).toBe("789")
  })

  test("bytes=0- serves the whole object as a 206 range", async () => {
    const response = await fetchFile({ Range: "bytes=0-", "Cache-Control": "no-store" })
    expect(response.status).toBe(206)
    expect(await response.text()).toBe(CONTENT)
  })

  test("If-None-Match with the current etag serves 304", async () => {
    const response = await fetchFile({ "If-None-Match": '"etag-1"' })
    expect(response.status).toBe(304)
  })

  test("If-Match with a stale etag serves 412", async () => {
    const response = await fetchFile({ "If-Match": '"other"' })
    expect(response.status).toBe(412)
  })
})
