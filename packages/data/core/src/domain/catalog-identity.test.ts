import { describe, expect, test, spyOn } from "bun:test"
import { catalogIdentity } from "./catalog-identity"

describe("stats catalog identity", () => {
  test("resolves OpenCode offerings to canonical labs", () => {
    const identity = catalogIdentity({
      models: { "meituan/longcat-2.5-preview": {} },
      providers: {
        opencode: { models: { "longcat-2.5-preview-free": { canonical_model_id: "meituan/longcat-2.5-preview" } } },
        "opencode-go": {
          models: { "longcat-2.5-preview-free": { canonical_model_id: "meituan/longcat-2.5-preview" } },
        },
      },
    })

    expect(identity.offerings.get("opencode/longcat-2.5-preview-free")).toBe("meituan")
    expect(identity.offerings.get("opencode-go/longcat-2.5-preview-free")).toBe("meituan")
    expect(identity.models.get("longcat-2.5-preview")).toBe("meituan")
  })

  test("does not guess a lab for a name shared by different canonical models", () => {
    const identity = catalogIdentity({
      models: { "lab-a/model": {}, "lab-b/model": {} },
      providers: {
        opencode: { models: { "model-free": { canonical_model_id: "lab-a/model" } } },
        "opencode-go": { models: { model: { canonical_model_id: "lab-b/model" } } },
      },
    })

    expect(identity.offerings.get("opencode/model-free")).toBe("lab-a")
    expect(identity.offerings.get("opencode-go/model")).toBe("lab-b")
    expect(identity.models.has("model")).toBe(false)
  })

  test("accepts provider IDs that are already canonical catalog IDs", () => {
    const identity = catalogIdentity({
      models: { "opencode/direct-model": {} },
      providers: { opencode: { models: { "direct-model": {} } } },
    })

    expect(identity.offerings.get("opencode/direct-model")).toBe("opencode")
    expect(identity.models.get("direct-model")).toBe("opencode")
  })

  test("rejects a catalog without published canonical identities", () => {
    expect(() => catalogIdentity({ models: {}, providers: { opencode: { models: { model: {} } } } })).toThrow(
      "Model catalog has no canonical OpenCode offerings",
    )
  })
})

describe("catalog identity fetch", () => {
  // A fresh module instance per run (unique import query) so --rerun-each runs,
  // which re-evaluate this file in the same process, never observe a previous
  // run's module-level identity cache.
  test("fails softly on stalled and oversized bodies and accepts a healthy catalog", async () => {
    const timeout = spyOn(AbortSignal, "timeout")
    const fetcher = spyOn(globalThis, "fetch")
    const { loadCatalogIdentity } = await import(`./catalog-identity.ts?fetch=${Date.now()}-${Math.random()}`)
    try {
      let readStarted!: () => void
      const bodyReadStarted = new Promise<void>((resolve) => {
        readStarted = resolve
      })
      const controller = new AbortController()
      timeout.mockReturnValue(controller.signal)
      fetcher.mockResolvedValue(
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
      )
      const stalled = loadCatalogIdentity()
      await bodyReadStarted
      controller.abort()
      expect((await stalled).stale).toBe(true)

      timeout.mockRestore()
      let pulls = 0
      let cancelled = false
      fetcher.mockResolvedValue(new Response(new ReadableStream({
        pull(stream) {
          pulls++
          stream.enqueue(new Uint8Array(1024 * 1024))
        },
        cancel() { cancelled = true },
      })))
      expect((await loadCatalogIdentity()).stale).toBe(true)
      expect(cancelled).toBe(true)
      expect(pulls).toBeLessThan(40)

      fetcher.mockResolvedValue(Response.json({
        models: { "lab/model": {} },
        providers: { opencode: { models: { model: { canonical_model_id: "lab/model" } } } },
      }))
      const result = await loadCatalogIdentity()
      expect(result.stale).toBe(false)
      expect(result.catalog?.offerings.get("opencode/model")).toBe("lab")
    } finally {
      timeout.mockRestore()
      fetcher.mockRestore()
    }
  })
})
