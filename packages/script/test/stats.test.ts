import { describe, expect, test } from "bun:test"
import { STATS_RESPONSE_MAX_BYTES, fetchNpmDownloads, fetchReleases, sendToPostHog } from "../../../script/stats"

const timeouts = {
  posthog: 25,
  npmDownloads: 25,
  githubReleases: 25,
}

function stalledBody() {
  return new ReadableStream<Uint8Array>({
    start() {
      // Keep the stream open until production code cancels it on timeout.
    },
  })
}

/** A fetch that never settles until its request signal aborts. */
function stalledFetch(onSignal?: (signal: AbortSignal | null | undefined) => void): typeof fetch {
  return async (_input, init) => {
    onSignal?.(init?.signal)
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    })
  }
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  })
}

const npmRange = {
  start: "2020-01-01",
  end: "2031-12-31",
  package: "opencode-ai",
  downloads: [
    { downloads: 10, day: "2020-01-01" },
    { downloads: 32, day: "2020-01-02" },
  ],
}

describe("stats.ts fetch deadlines and bounded JSON reads (#1337)", () => {
  test("the response byte cap is 16 MiB", () => {
    expect(STATS_RESPONSE_MAX_BYTES).toBe(16 * 1024 * 1024)
  })

  test("npm downloads sum an answered response as before", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(npmRange)
    await expect(fetchNpmDownloads("opencode-ai", { fetchImpl, timeouts })).resolves.toBe(42)
  })

  test("a stalled npm fetch settles at its deadline as warn-and-0", async () => {
    let signal: AbortSignal | null | undefined
    const fetchImpl = stalledFetch((value) => {
      signal = value
    })
    await expect(fetchNpmDownloads("opencode-ai", { fetchImpl, timeouts })).resolves.toBe(0)
    expect(signal?.aborted).toBe(true)
  })

  test("an over-cap npm body settles as warn-and-0", async () => {
    const fetchImpl: typeof fetch = async () => new Response("x".repeat(STATS_RESPONSE_MAX_BYTES + 1))
    await expect(fetchNpmDownloads("opencode-ai", { fetchImpl, timeouts })).resolves.toBe(0)
  })

  test("npm non-OK still warns and returns 0", async () => {
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 503 })
    await expect(fetchNpmDownloads("opencode-ai", { fetchImpl, timeouts })).resolves.toBe(0)
  })

  test("releases pagination terminates on a short page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      tag_name: `v${i}`,
      name: `release ${i}`,
      assets: [{ name: "a", download_count: 1 }],
    }))
    const short = [{ tag_name: "v100", name: "release 100", assets: [] }]
    const pages = [full, short]
    let call = 0
    const fetchImpl: typeof fetch = async () => jsonResponse(pages[call++])
    const releases = await fetchReleases({ fetchImpl, timeouts })
    expect(releases).toHaveLength(101)
    expect(call).toBe(2)
  })

  test("a stalled releases page settles at its deadline as an error, not a partial result", async () => {
    let signal: AbortSignal | null | undefined
    const fetchImpl = stalledFetch((value) => {
      signal = value
    })
    await expect(fetchReleases({ fetchImpl, timeouts })).rejects.toThrow()
    expect(signal?.aborted).toBe(true)
  })

  test("a stalled releases body is cancelled at its deadline", async () => {
    const fetchImpl: typeof fetch = async () => new Response(stalledBody())
    await expect(fetchReleases({ fetchImpl, timeouts })).rejects.toThrow()
  })

  test("an over-cap releases page is rejected naming the operation and cap", async () => {
    const fetchImpl: typeof fetch = async () => new Response("x".repeat(STATS_RESPONSE_MAX_BYTES + 1))
    await expect(fetchReleases({ fetchImpl, timeouts })).rejects.toThrow(
      `GitHub releases response exceeded ${STATS_RESPONSE_MAX_BYTES} bytes`,
    )
  })

  test("releases non-OK still throws the GitHub API error", async () => {
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 500, statusText: "Server Error" })
    await expect(fetchReleases({ fetchImpl, timeouts })).rejects.toThrow("GitHub API error: 500 Server Error")
  })

  test("PostHog send carries a deadline and a stall stays non-fatal", async () => {
    const previous = process.env["POSTHOG_KEY"]
    process.env["POSTHOG_KEY"] = "test-key"
    try {
      let signal: AbortSignal | null | undefined
      const fetchImpl = stalledFetch((value) => {
        signal = value
      })
      await expect(sendToPostHog("download", { count: 1 }, { fetchImpl, timeouts })).resolves.toBeUndefined()
      expect(signal?.aborted).toBe(true)
    } finally {
      if (previous === undefined) delete process.env["POSTHOG_KEY"]
      else process.env["POSTHOG_KEY"] = previous
    }
  })

  test("PostHog without a key makes no request", async () => {
    const previous = process.env["POSTHOG_KEY"]
    delete process.env["POSTHOG_KEY"]
    try {
      let calls = 0
      const fetchImpl: typeof fetch = async () => {
        calls++
        return new Response(null, { status: 200 })
      }
      await sendToPostHog("download", { count: 1 }, { fetchImpl, timeouts })
      expect(calls).toBe(0)
    } finally {
      if (previous !== undefined) process.env["POSTHOG_KEY"] = previous
    }
  })
})
