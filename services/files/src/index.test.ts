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

// The Cache API is a worker runtime global; tests stub it as a miss by
// default with an opt-in stored hit. Requests also send no-store where
// they must not depend on it.
let cachedHit = null
// @ts-expect-error runtime global stub
globalThis.caches = { default: { match: async () => (cachedHit ? cachedHit.clone() : undefined), put: async () => {} } }

const storeHit = () => {
  cachedHit = new Response(CONTENT, {
    status: 200,
    headers: {
      ETag: '"etag-1"',
      "Last-Modified": UPLOADED.toUTCString(),
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/plain",
    },
  })
}

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

describe("files worker cache-hit conditionals (#2786)", () => {
  test("matching If-None-Match on a hit serves a bodyless 304 with cached headers", async () => {
    storeHit()
    try {
      const response = await fetchFile({ "If-None-Match": '"etag-1"' })
      expect(response.status).toBe(304)
      expect(await response.text()).toBe("")
      expect(response.headers.get("ETag")).toBe('"etag-1"')
      expect(response.headers.get("Last-Modified")).toBe(UPLOADED.toUTCString())
    } finally {
      cachedHit = null
    }
  })

  test("non-matching If-None-Match on a hit serves the stored 200 with body", async () => {
    storeHit()
    try {
      const response = await fetchFile({ "If-None-Match": '"other"' })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(CONTENT)
    } finally {
      cachedHit = null
    }
  })

  test("If-Modified-Since at the cached Last-Modified serves 304", async () => {
    storeHit()
    try {
      const response = await fetchFile({ "If-Modified-Since": UPLOADED.toUTCString() })
      expect(response.status).toBe(304)
      expect(await response.text()).toBe("")
    } finally {
      cachedHit = null
    }
  })

  test("stale If-Modified-Since on a hit serves the stored 200", async () => {
    storeHit()
    try {
      const response = await fetchFile({ "If-Modified-Since": "Wed, 31 Dec 2025 00:00:00 GMT" })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(CONTENT)
    } finally {
      cachedHit = null
    }
  })

  test("matching If-None-Match on a HEAD hit serves a bodyless 304", async () => {
    storeHit()
    try {
      const response = await fetchFile({ "If-None-Match": '"etag-1"' }, "HEAD")
      expect(response.status).toBe(304)
      expect(await response.text()).toBe("")
      expect(response.headers.get("ETag")).toBe('"etag-1"')
    } finally {
      cachedHit = null
    }
  })
})
