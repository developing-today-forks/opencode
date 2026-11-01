import { describe, expect, mock, test, spyOn } from "bun:test"

mock.module("@solidjs/router", () => ({ query: (load: () => unknown) => load }))

const { buildModelCatalog, findModelCatalogEntry } = await import("./model-catalog")

describe("model catalog pricing", () => {
  test("prefers OpenCode Go pricing over a zero-cost coding plan with the same model id", () => {
    const catalog = buildModelCatalog(
      {
        models: {
          "zhipuai/glm-5.3": {
            id: "zhipuai/glm-5.3",
            name: "GLM-5.3",
          },
        },
      },
      {
        "opencode-go": {
          id: "opencode-go",
          models: {
            "glm-5.3": {
              id: "glm-5.3",
              cost: { input: 1.4, output: 4.4, cache_read: 0.26 },
            },
          },
        },
        "zhipuai-coding-plan": {
          id: "zhipuai-coding-plan",
          models: {
            "glm-5.3": {
              id: "glm-5.3",
              cost: { input: 0, output: 0, cache_read: 0 },
            },
          },
        },
      },
    )

    expect(findModelCatalogEntry(catalog, "glm-5.3")?.cost).toEqual({
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
      cacheWrite: undefined,
    })
  })
})

describe("model catalog fetch", () => {
  // A fresh module instance per run (unique import query) so --rerun-each runs,
  // which re-evaluate this file in the same process, never observe a previous
  // run's module-level catalog cache.
  test("fails softly on stalled and oversized bodies and accepts healthy sources", async () => {
    const timeout = spyOn(AbortSignal, "timeout")
    const fetcher = spyOn(globalThis, "fetch")
    const { loadModelCatalog } = await import(`./model-catalog.ts?fetch=${Date.now()}-${Math.random()}`)
    try {
      let readStarted!: () => void
      const bodyReadStarted = new Promise<void>((resolve) => {
        readStarted = resolve
      })
      const controller = new AbortController()
      timeout.mockReturnValue(controller.signal)
      fetcher.mockImplementation(
        Object.assign(
          async () =>
            new Response(
              new ReadableStream(
                {
                  pull() {
                    readStarted()
                  },
                },
                { highWaterMark: 0 },
              ),
            ),
          { preconnect: fetch.preconnect },
        ),
      )
      const stalled = loadModelCatalog()
      await bodyReadStarted
      controller.abort()
      expect((await stalled).models).toHaveLength(0)

      timeout.mockRestore()
      let pulls = 0
      let cancelled = 0
      fetcher.mockImplementation(Object.assign(async () => new Response(new ReadableStream({
        pull(stream) {
          pulls++
          stream.enqueue(new Uint8Array(1024 * 1024))
        },
        cancel() { cancelled++ },
      })), { preconnect: fetch.preconnect }))
      expect((await loadModelCatalog()).models).toHaveLength(0)
      expect(cancelled).toBe(3)
      expect(pulls).toBeLessThan(120)

      fetcher.mockImplementation(Object.assign(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith("catalog.json")) return Response.json({ models: { "lab/model": { id: "lab/model", name: "Model" } } })
        if (url.endsWith("api.json")) return Response.json({})
        return new Response('<script id="search-index">[]</script>')
      }, { preconnect: fetch.preconnect }))
      expect((await loadModelCatalog()).models.length).toBeGreaterThan(0)
    } finally {
      timeout.mockRestore()
      fetcher.mockRestore()
    }
  })
})
