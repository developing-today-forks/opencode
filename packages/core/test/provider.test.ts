import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Provider } from "@opencode/core/provider"

describe("Provider timeouts (#972)", () => {
  test("passes valid timeouts through unchanged, including the largest honourable one", () => {
    expect(Provider.timeout(300_000)).toBe(300_000)
    expect(Provider.timeout(2_147_483_647)).toBe(2_147_483_647)
    expect(Provider.timeout(false)).toBe(false)
    expect(Provider.timeout(undefined)).toBeUndefined()
  })

  test("clamps timeouts the raw timers cannot honour instead of inverting them", () => {
    // setTimeout would fire these after ~1 ms; AbortSignal.timeout(Infinity) would throw.
    expect(Provider.timeout(2_147_483_648)).toBe(2_147_483_647)
    expect(Provider.timeout(3_000_000_000)).toBe(2_147_483_647)
    expect(Provider.timeout(Number.POSITIVE_INFINITY)).toBe(2_147_483_647)
  })

  test("still drops invalid timeouts", () => {
    expect(Provider.timeout(Number.NaN)).toBeUndefined()
    expect(Provider.timeout(0)).toBeUndefined()
    expect(Provider.timeout(-5)).toBeUndefined()
  })

  test("timeouts() clamps every resolved timeout and keeps defaults and false", () => {
    expect(
      Provider.timeouts({ timeout: Number.POSITIVE_INFINITY, headerTimeout: 3_000_000_000, chunkTimeout: 900_000 }),
    ).toEqual({ timeout: 2_147_483_647, headerTimeout: 2_147_483_647, chunkTimeout: 900_000 })
    expect(Provider.timeouts({ headerTimeout: false })).toEqual({
      timeout: undefined,
      headerTimeout: false,
      chunkTimeout: 900_000,
    })
    expect(Provider.timeouts({})).toEqual({ timeout: undefined, headerTimeout: 300_000, chunkTimeout: 900_000 })
  })
})

describe("Provider", () => {
  test("bundles every native provider entrypoint that exports model()", async () => {
    const providers = path.join(import.meta.dir, "../../ai/src/providers")
    const entrypoints = await Promise.all(
      Array.from(new Bun.Glob("**/*.ts").scanSync(providers)).map(async (file) => {
        // Bun.Glob yields native separators, and package specifiers always use "/".
        const specifier = `@opencode/ai/providers/${file.replace(/\.ts$/, "").replaceAll(path.sep, "/")}`
        const module = await import(specifier)
        return typeof module.model === "function" ? specifier : undefined
      }),
    )
    const packages = entrypoints.filter((specifier) => specifier !== undefined).toSorted()

    expect(packages.filter((specifier) => !Provider.builtinPackages.has(specifier))).toEqual([])
    expect(Array.from(Provider.builtinPackages).toSorted()).toEqual(packages)
    for (const specifier of packages) {
      const loaded = await Effect.runPromise(Provider.loadPackage(specifier))
      expect(loaded.model).toBeFunction()
    }
  })

  test("passes flat settings to native packages without Core settings", () => {
    expect(
      Provider.nativeSettings({
        apiKey: "secret",
        reasoningEffort: "high",
        chunkTimeout: 1000,
        compaction: { type: "native" },
        transport: "websocket",
      }),
    ).toEqual({
      apiKey: "secret",
      reasoningEffort: "high",
    })
  })

  test("inherits shared and loose settings without provider-only policies", () => {
    expect(
      Provider.modelSettings({
        timeout: 60_000,
        chunkTimeout: 30_000,
        transport: "websocket",
        compaction: { type: "native" },
        reasoningEffort: "high",
      }),
    ).toEqual({
      compaction: { type: "native" },
      reasoningEffort: "high",
    })
  })
})
