import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@opencode/core/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ModelAlias } from "@opencode/core/model-alias"
import { Info } from "@opencode/schema/config"

describe("ConfigNormalize with Aliases", () => {
  test("resolves aliases in default model, agents, commands, and model_routes", () => {
    const rawConfig = {
      aliases: {
        providers: {
          ds: "deepseek",
          cf: "cloudflare-gateway",
        },
        models: {
          flash: "deepseek/deepseek-chat#high",
          "deepseek/pro": "deepseek-v4-pro",
        },
        variants: {
          hi: "high",
          "deepseek/*#hi": "max",
        },
      },
      model: "flash",
      agents: {
        coder: {
          model: "ds/pro#hi",
        },
      },
      commands: {
        review: {
          template: "Review code",
          model: "ds/deepseek-chat#hi",
        },
      },
      experimental: {
        model_routes: {
          "fast-pool": {
            targets: ["flash", "ds/pro"],
            selection: "ordered",
          },
        },
      },
    }

    const result = ConfigNormalize.normalize(rawConfig)
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return

    // 1. Default model resolved from "flash" -> providerID: "deepseek", model: "deepseek-chat", variant: "high"
    expect(result.encoded.model).toEqual({
      providerID: "deepseek",
      model: "deepseek-chat",
      variant: "high",
    })

    // 2. Agent model resolved from "ds/pro#hi" -> providerID: "deepseek", model: "deepseek-v4-pro", variant: "max" (deepseek/*#hi -> max)
    const agents = result.encoded.agents as Record<string, any>
    expect(agents.coder.model).toEqual({
      providerID: "deepseek",
      model: "deepseek-v4-pro",
      variant: "max",
    })

    // 3. Command model resolved from "ds/deepseek-chat#hi" -> providerID: "deepseek", model: "deepseek-chat", variant: "max"
    const commands = result.encoded.commands as Record<string, any>
    expect(commands.review.model).toEqual({
      providerID: "deepseek",
      model: "deepseek-chat",
      variant: "max",
    })

    // 4. Route targets resolved to structured model targets
    const experimental = result.encoded.experimental as Record<string, any>
    const targets = experimental.routes.models["fast-pool"].targets
    expect(targets[0]).toEqual({
      providerID: "deepseek",
      model: "deepseek-chat",
      variant: "high",
    })
    expect(targets[1]).toEqual({
      providerID: "deepseek",
      model: "deepseek-v4-pro",
    })

    // 5. Aliases preserved in encoded config
    expect(result.encoded.aliases).toEqual(rawConfig.aliases)
  })

  test("preserves entries named __proto__ in agents and model_routes", () => {
    const rawConfig = {
      aliases: {
        models: {
          flash: "deepseek/deepseek-chat#high",
        },
      },
      agents: JSON.parse('{"__proto__": {"model": "flash"}}'),
      experimental: {
        model_routes: JSON.parse('{"__proto__": {"targets": ["flash"], "selection": "ordered"}}'),
      },
    }

    const result = ConfigNormalize.normalize(rawConfig)
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return

    const agents = result.encoded.agents as Record<string, any>
    expect(Object.prototype.hasOwnProperty.call(agents, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(agents)).toBe(Object.prototype)
    expect(agents["__proto__"].model).toEqual({
      providerID: "deepseek",
      model: "deepseek-chat",
      variant: "high",
    })

    const routes = (result.encoded.experimental as Record<string, any>).routes.models as Record<string, any>
    expect(Object.prototype.hasOwnProperty.call(routes, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(routes)).toBe(Object.prototype)
    expect(routes["__proto__"].targets[0]).toEqual({
      providerID: "deepseek",
      model: "deepseek-chat",
      variant: "high",
    })
  })

  test("accepts aliases placed under experimental.aliases as well", () => {
    const rawConfig = {
      experimental: {
        aliases: {
          providers: {
            ds: "deepseek",
          },
          models: {
            fast: "ds/fast-model",
          },
        },
      },
      model: "fast",
    }

    const result = ConfigNormalize.normalize(rawConfig)
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return

    expect(result.encoded.model).toEqual({
      providerID: "deepseek",
      model: "fast-model",
    })
  })

  test("the resolver's config seam returns the aliases and expands a bare alias", () => {
    const rawConfig = {
      aliases: {
        providers: { ds: "deepseek" },
        models: { flash: "deepseek/deepseek-chat#high", "deepseek/pro": "deepseek-v4-pro" },
        variants: { hi: "high", "deepseek/*#hi": "max" },
      },
    }

    const result = ConfigNormalize.normalize(rawConfig)
    if (result.type !== "normalized") throw new Error("expected normalized config")
    const info = Schema.decodeUnknownSync(Info, { errors: "all", onExcessProperty: "ignore" })(
      result.encoded,
    ) as Info
    const entries = [{ type: "document" as const, info }]

    // This is exactly what ModelResolver.resolve and SessionRunnerModel.resolve read.
    const aliases = Config.latest(entries, "aliases")
    expect(aliases).toBeDefined()

    // A bare alias arrives from the CLI as providerID with an empty model id.
    expect(ModelAlias.resolve(aliases, "flash")).toBe("deepseek/deepseek-chat#high")
    expect(ModelAlias.resolve(aliases, "ds/pro")).toBe("deepseek/deepseek-v4-pro")
    expect(ModelAlias.resolve(aliases, "ds/deepseek-chat#hi")).toBe("deepseek/deepseek-chat#max")
  })
})
