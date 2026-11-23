import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Provider } from "@opencode/core/provider"
import { ConfigMigrateV1 } from "@opencode/core/v1/config/migrate"
import { ai } from "@opencode/ai/effect"
import { compileRequest } from "@opencode/ai/route/client"

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
    const manifest = await Bun.file(path.join(import.meta.dir, "../../ai/package.json")).json()
    const entrypoints = await Promise.all(
      Object.keys(manifest.exports)
        .filter((key) => key.startsWith("./providers/"))
        .map(async (key) => {
          const specifier = `@opencode/ai${key.slice(1)}`
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

  test("loads every @opencode/ai entrypoint the bundled models.dev snapshot names", async () => {
    const manifest = await Bun.file(path.join(import.meta.dir, "../../ai/package.json")).json()
    const snapshot: Record<
      string,
      { models?: Record<string, { api?: Record<string, { sdk?: { opencodeai?: string } }> }> }
    > = await Bun.file(path.join(import.meta.dir, "../src/models-dev/snapshot.txt")).json()
    const specifiers = new Set(
      Object.values(snapshot)
        .flatMap((provider) => Object.values(provider.models ?? {}))
        .flatMap((model) => Object.values(model.api ?? {}))
        .map((api) => api.sdk?.opencodeai)
        .filter((specifier): specifier is string => specifier?.startsWith("@opencode/ai/") === true),
    )
    // Protocol entrypoints export no model(), so Core skips the APIs that name them.
    const protocolOnly = new Set(["@opencode/ai/protocols/openai-decisions"])

    expect(
      [...specifiers].filter((specifier) => !(`.${specifier.slice("@opencode/ai".length)}` in manifest.exports)),
    ).toEqual([])
    expect([...specifiers].filter((specifier) => !Provider.builtinPackages.has(specifier)).toSorted()).toEqual(
      [...protocolOnly].filter((specifier) => specifiers.has(specifier)),
    )
  })

  test("keeps loading the hyphenated provider paths existing configs reference", async () => {
    for (const name of ["google-vertex-messages", "openai-compatible-responses"]) {
      const specifier = `@opencode/ai/providers/${name}`
      expect(Provider.builtinPackages.has(specifier)).toBe(true)
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
        cache: { ttl: "1h" },
        encoding: "gzip",
        transport: "websocket",
      }),
    ).toEqual({
      apiKey: "secret",
      reasoningEffort: "high",
    })
  })

  test("normalizes every v1-dialect effort spelling to reasoningEffort (#2203)", () => {
    // Oracle: muse-direct's four spellings (#1872) — each must land as
    // the native camel key, with the v1 spellings consumed, not copied.
    expect(Provider.nativeSettings({ reasoningEffort: "medium" })).toEqual({ reasoningEffort: "medium" })
    expect(Provider.nativeSettings({ reasoning_effort: "low" })).toEqual({ reasoningEffort: "low" })
    expect(Provider.nativeSettings({ options: { reasoningEffort: "high" } })).toEqual({ reasoningEffort: "high" })
    expect(Provider.nativeSettings({ options: { reasoning_effort: "xhigh" } })).toEqual({ reasoningEffort: "xhigh" })
  })

  test("v1 effort normalization keeps muse-direct precedence: native camel wins (#2203)", () => {
    expect(
      Provider.nativeSettings({
        reasoningEffort: "medium",
        reasoning_effort: "low",
        options: { reasoningEffort: "high", reasoning_effort: "xhigh" },
      }),
    ).toEqual({ reasoningEffort: "medium" })
    expect(Provider.nativeSettings({ reasoning_effort: "low", options: { reasoningEffort: "high" } })).toEqual({
      reasoningEffort: "low",
    })
    expect(Provider.nativeSettings({ options: { reasoningEffort: "high", reasoning_effort: "xhigh" } })).toEqual({
      reasoningEffort: "high",
    })
  })

  test("v1 effort normalization preserves unrelated settings and nested options (#2203)", () => {
    expect(
      Provider.nativeSettings({
        apiKey: "fixture",
        chunkTimeout: 1000,
        options: { reasoning_effort: "low", temperature: 0.5 },
      }),
    ).toEqual({ apiKey: "fixture", reasoningEffort: "low", options: { temperature: 0.5 } })
    expect(Provider.nativeSettings({ options: { temperature: 0.5 } })).toEqual({ options: { temperature: 0.5 } })
    expect(Provider.nativeSettings({ apiKey: "fixture" })).toEqual({ apiKey: "fixture" })
  })

  test("a v1-spelled variant effort reaches the Meta Responses wire via nativeSettings (#2203)", async () => {
    const loaded = await Effect.runPromise(Provider.loadPackage("@opencode/ai/providers/meta"))
    const model = loaded.model(
      "muse-spark-1.3",
      Provider.nativeSettings({ apiKey: "fixture", options: { reasoning_effort: "high" } }),
    )
    const compiled = await Effect.runPromise(compileRequest(ai.request({ model, prompt: "Hi" })))
    expect((compiled.body as { reasoning?: { effort?: string } }).reasoning?.effort).toBe("high")
  })

  test("a v1-spelled variant effort reaches the Antigravity wire via nativeSettings (#2203)", async () => {
    const loaded = await Effect.runPromise(Provider.loadPackage("@opencode/ai/providers/antigravity"))
    const model = loaded.model(
      "gemini-3.8-flash",
      Provider.nativeSettings({ accessToken: "fixture-token", options: { reasoning_effort: "low" } }),
    )
    const compiled = await Effect.runPromise(compileRequest(ai.request({ model, prompt: "Hi" })))
    const body = compiled.body as {
      model?: string
      request?: { generationConfig?: { thinkingConfig?: { thinkingLevel?: string } } }
    }
    expect(body.model).toBe("gemini-3.8-flash-low")
    expect(body.request?.generationConfig?.thinkingConfig?.thinkingLevel).toBe("LOW")
  })

  test("a v1 variant options bag reaches the native Gemini request", async () => {
    const migrated = ConfigMigrateV1.migrateProvider("google", {
      npm: "@ai-sdk/google",
      models: {
        "gemini-3.1-flash": {
          options: { thinkingConfig: { thinkingLevel: "high" } },
          variants: { high: { options: { thinkingConfig: { thinkingLevel: "high" } } } },
        },
      },
    })
    const migratedModel = migrated.models?.["gemini-3.1-flash"]
    const variant = migratedModel?.variants?.[0]
    expect(migratedModel?.settings).toEqual(variant?.settings)
    expect(variant?.settings).toEqual({ thinkingConfig: { thinkingLevel: "high" } })

    const loaded = await Effect.runPromise(Provider.loadPackage("@opencode/ai/providers/google"))
    const model = loaded.model("gemini-3.1-flash", Provider.nativeSettings({ apiKey: "fixture", ...variant?.settings }))
    const compiled = await Effect.runPromise(compileRequest(ai.request({ model, prompt: "Hi" })))
    expect((compiled.body as { generationConfig?: { thinkingConfig?: { thinkingLevel?: string } } }).generationConfig
      ?.thinkingConfig?.thinkingLevel).toBe("high")
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
