import { expect, test } from "bun:test"
import { CopilotModels } from "@opencode/core/github-copilot/models"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"

test("defensively syncs advertised Copilot models", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        data: [
          {
            model_picker_enabled: true,
            id: "gpt-5",
            name: "GPT-5 remote",
            version: "gpt-5-2026-06-01",
            supported_endpoints: ["/responses"],
            billing: {
              token_prices: {
                batch_size: 0,
                default: { input_price: 10, output_price: 20, cache_price: 5 },
              },
            },
            capabilities: {
              family: "gpt",
              limits: {
                max_context_window_tokens: 200000,
                max_output_tokens: 16384,
                max_prompt_tokens: 180000,
                vision: {
                  max_prompt_image_size: 10000000,
                  max_prompt_images: 10,
                  supported_media_types: ["image/png", "application/pdf"],
                },
              },
              supports: { tool_calls: true, vision: true, reasoning_effort: ["low", "high"] },
            },
          },
          {
            model_picker_enabled: true,
            id: "claude-sonnet",
            name: "Claude Sonnet",
            version: "claude-sonnet-2026-06-01",
            supported_endpoints: ["/v1/messages"],
            capabilities: {
              family: "claude",
              limits: { max_output_tokens: 16384, max_prompt_tokens: 180000 },
              supports: { tool_calls: true },
            },
          },
          {
            model_picker_enabled: true,
            id: "vision-only",
            name: "Vision only",
            version: "vision-only-2026-06-01",
            capabilities: {
              family: "vision",
              limits: {
                max_output_tokens: 16384,
                max_prompt_tokens: 180000,
                vision: {
                  max_prompt_image_size: 10000000,
                  max_prompt_images: 10,
                  supported_media_types: ["image/png"],
                },
              },
              supports: { tool_calls: true, vision: true },
            },
          },
          {
            model_picker_enabled: false,
            id: "utility",
            name: "Utility",
            version: "utility-2026-06-01",
            capabilities: {
              family: "utility",
              limits: { max_output_tokens: 1000, max_prompt_tokens: 8000 },
              supports: { tool_calls: false },
            },
          },
          { model_picker_enabled: true, id: "incomplete" },
        ],
      }),
  })

  try {
    const existing = Model.Info.make({
      ...Model.Info.default(Provider.ID.githubCopilot, Model.ID.make("gpt-5")),
      modelID: Model.ID.make("gpt-5"),
      name: "GPT-5 local",
    })
    const stale = Model.Info.make({
      ...Model.Info.default(Provider.ID.githubCopilot, Model.ID.make("stale")),
      modelID: Model.ID.make("stale"),
    })
    const models = await CopilotModels.get(server.url.origin, {}, [existing, stale])
    const model = models.get(Model.ID.make("gpt-5"))

    expect(model?.name).toBe("GPT-5 local")
    expect(model?.package).toBe(Provider.aisdk("@ai-sdk/github-copilot"))
    expect(model?.settings).toMatchObject({ baseURL: server.url.origin, endpoint: "responses" })
    expect(model?.cost[0]).toMatchObject({ input: 0, output: 0, cache: { read: 0, write: 0 } })
    expect(model?.variants.map((variant) => variant.id)).toEqual([
      Model.VariantID.make("low"),
      Model.VariantID.make("high"),
    ])
    expect(model?.capabilities.input).toEqual(["text", "image", "pdf"])
    expect(models.get(Model.ID.make("claude-sonnet"))?.package).toBe("@opencode/ai/providers/anthropic")
    expect(models.get(Model.ID.make("claude-sonnet"))?.settings).toMatchObject({
      baseURL: `${server.url.origin}/v1`,
      endpoint: "messages",
    })
    expect(models.get(Model.ID.make("vision-only"))?.capabilities.input).toEqual(["text", "image"])
    expect(models.get(Model.ID.make("utility"))?.enabled).toBe(false)
    expect(models.has(Model.ID.make("stale"))).toBe(false)
    expect(models.has(Model.ID.make("incomplete"))).toBe(false)
  } finally {
    await server.stop(true)
  }
})

test("prices cache reads from either token price spelling", async () => {
  // API version 2026-08-01 renamed cache_price to cache_read_price; older payloads still use cache_price.
  const item = (id: string, prices: Record<string, number>) => ({
    model_picker_enabled: true,
    id,
    name: id,
    version: `${id}-2026-08-01`,
    supported_endpoints: ["/chat/completions"],
    billing: { token_prices: { batch_size: 1_000_000, default: { input_price: 250, output_price: 1500, ...prices } } },
    capabilities: {
      family: "gpt",
      limits: { max_output_tokens: 1000, max_prompt_tokens: 8000 },
      supports: { tool_calls: true },
    },
  })
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        data: [
          item("renamed", { cache_read_price: 25, cache_write_price: 0 }),
          item("legacy", { cache_price: 25 }),
          item("unpriced", {}),
        ],
      }),
  })

  try {
    const models = await CopilotModels.get(server.url.origin, {}, [])
    expect(models.get(Model.ID.make("renamed"))?.cost[0]).toMatchObject({ input: 2.5, output: 15, cache: { read: 0.25 } })
    expect(models.get(Model.ID.make("legacy"))?.cost[0]).toMatchObject({ input: 2.5, output: 15, cache: { read: 0.25 } })
    expect(models.get(Model.ID.make("unpriced"))?.cost[0]).toMatchObject({ cache: { read: 0 } })
  } finally {
    await server.stop(true)
  }
})

test("does not roll calendar-invalid version dates over into release instants (#886)", async () => {
  const item = (id: string, suffix: string) => ({
    model_picker_enabled: true,
    id,
    name: id,
    version: `${id}-${suffix}`,
    supported_endpoints: ["/chat/completions"],
    capabilities: {
      family: "gpt",
      limits: { max_output_tokens: 1000, max_prompt_tokens: 8000 },
      supports: { tool_calls: true },
    },
  })
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        data: [
          item("feb30", "2026-02-30"),
          item("feb29", "2026-02-29"),
          item("month13", "2026-13-01"),
          item("leap", "2024-02-29"),
          item("valid", "2026-06-01"),
          item("preview", "preview"),
        ],
      }),
  })

  try {
    const models = await CopilotModels.get(server.url.origin, {}, [])
    // Calendar-invalid suffixes are unknown dates (the 0 sentinel), not
    // rolled-over instants: Date.parse("2026-02-30") is 2026-03-02.
    expect(models.get(Model.ID.make("feb30"))?.time.released).toBe(0)
    expect(models.get(Model.ID.make("feb29"))?.time.released).toBe(0)
    expect(models.get(Model.ID.make("month13"))?.time.released).toBe(0)
    // Real dates — including a genuine leap day — keep their exact instant.
    expect(models.get(Model.ID.make("leap"))?.time.released).toBe(Date.UTC(2024, 1, 29))
    expect(models.get(Model.ID.make("valid"))?.time.released).toBe(Date.UTC(2026, 5, 1))
    // Non-date suffixes keep the 0-when-unparseable behavior.
    expect(models.get(Model.ID.make("preview"))?.time.released).toBe(0)
  } finally {
    await server.stop(true)
  }
})


test("rejects an over-cap Copilot models body with a declared length (#1017)", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ data: [], pad: "x".repeat(CopilotModels.modelsMaxResponseBytes) }),
  })
  try {
    await expect(CopilotModels.load(server.url.origin, {})).rejects.toThrow(
      `Copilot models response from ${server.url.origin}/models exceeded ${CopilotModels.modelsMaxResponseBytes} bytes`,
    )
  } finally {
    await server.stop(true)
  }
})

test("rejects a streamed over-cap Copilot models body in flight (#1017)", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(120)
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk)
    },
  })
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(stream, { headers: { "content-type": "application/json" } }),
  })
  try {
    await expect(CopilotModels.load(server.url.origin, {})).rejects.toThrow(
      `Copilot models response from ${server.url.origin}/models exceeded ${CopilotModels.modelsMaxResponseBytes} bytes`,
    )
  } finally {
    await server.stop(true)
  }
})
