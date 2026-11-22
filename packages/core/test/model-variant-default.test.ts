import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import FastCheck from "fast-check"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Provider } from "@opencode/core/provider"

// A model's configured default effort (provider model config defaultVariant and lockVariant).
// Oracle: the rules stated on Config.Model: a request that names no variant, or asks for "default"
// (what clients send when the user picked none), runs at defaultVariant; one that names a variant
// runs as asked; lockVariant runs every request at defaultVariant; a configured variant the model
// does not offer is ignored, leaving the provider's own default.
// Each variant marks the request body with its id, so the body says which variant ran.

const model = (variants: readonly string[], defaultVariant?: string, lockVariant?: boolean): Model.Info => ({
  ...Model.Info.default(Provider.ID.make("p"), Model.ID.make("m")),
  variants: variants.map((id) => ({ id: Model.VariantID.make(id), body: { effort: id } })),
  ...(defaultVariant === undefined ? {} : { defaultVariant: Model.VariantID.make(defaultVariant) }),
  ...(lockVariant === undefined ? {} : { lockVariant }),
})

const ran = (info: Model.Info, requested: string | undefined) => {
  const exit = Effect.runSyncExit(
    ModelResolver.withVariant(info, requested === undefined ? undefined : Model.VariantID.make(requested)),
  )
  return Exit.isSuccess(exit) ? (exit.value.body?.effort ?? "none") : "unavailable"
}

describe("a model's default effort", () => {
  test("applies when a request names none or asks for the default, and never over a named one", () => {
    const info = model(["low", "high"], "high")
    expect(ran(info, undefined)).toBe("high")
    expect(ran(info, "default")).toBe("high")
    expect(ran(info, "low")).toBe("low")
    expect(ran(model(["low", "high"]), undefined)).toBe("none")
    expect(ran(model(["low", "high"]), "default")).toBe("none")
  })

  test("a locked default runs every request at it, the provider default included", () => {
    const info = model(["low", "high"], "high", true)
    expect([ran(info, undefined), ran(info, "low"), ran(info, "default")]).toEqual(["high", "high", "high"])
  })

  test("a default the model does not offer is ignored instead of failing requests", () => {
    expect(ran(model(["low"], "max"), undefined)).toBe("none")
    expect(ran(model(["low"], "max", true), "low")).toBe("low")
  })

  test("every combination follows the stated rules (property)", () => {
    const ids = ["none", "low", "medium", "high", "max"]
    FastCheck.assert(
      FastCheck.property(
        FastCheck.subarray(ids, { minLength: 0 }),
        FastCheck.option(FastCheck.constantFrom(...ids), { nil: undefined }),
        FastCheck.boolean(),
        FastCheck.option(FastCheck.constantFrom(...ids, "default"), { nil: undefined }),
        (variants, configured, locked, requested) => {
          const offered = configured !== undefined && variants.includes(configured) ? configured : undefined
          const expected =
            offered !== undefined && locked
              ? offered
              : requested === undefined || requested === "default"
                ? (offered ?? "none")
                : variants.includes(requested)
                  ? requested
                  : "unavailable"
          expect(ran(model(variants, configured, locked), requested)).toBe(expected)
        },
      ),
      { numRuns: 1000 },
    )
  })
})
