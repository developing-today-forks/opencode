import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { MAX_DEVICE_LIFETIME_SECONDS } from "@opencode/core/plugin/provider/expires"
import { deviceDeadline, deviceIntervalMs, XAIPlugin } from "@opencode/core/plugin/provider/xai"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* XAIPlugin.effect(host)
})

describe("XAIPlugin", () => {
  it.effect("registers device OAuth and API key methods", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      const integration = yield* integrations.get(Integration.ID.make("xai"))
      expect(integration?.name).toBe("xAI")
      expect(integration?.methods).toEqual([
        {
          id: Integration.MethodID.make("device"),
          type: "oauth",
          label: "SuperGrok Subscription",
        },
        { type: "key", label: "Manually enter API Key" },
      ])
    }),
  )

  it.effect("migrates browser OAuth credentials to the device method", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const original = yield* credentials.create({
        integrationID: Integration.ID.make("xai"),
        label: "personal",
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("browser"),
          access: "access",
          refresh: "refresh",
          expires: 123,
          metadata: { account: "account" },
        }),
      })

      yield* addPlugin()

      expect(yield* credentials.get(original.id)).toEqual({
        ...original,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access: "access",
          refresh: "refresh",
          expires: 123,
          metadata: { account: "account" },
        }),
      })
    }),
  )

  it.effect("enables xAI Responses WebSockets", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const models = yield* Model.Service
      const providerID = Provider.ID.make("xai")
      yield* providers.transform((editor) => {
        editor.update(providerID, (provider) => {
          provider.package = "@opencode/ai/providers/xai"
          provider.activation = "enabled"
        })
        editor.models.update(providerID, Model.ID.make("grok-4.6"), () => {})
      })

      yield* addPlugin()

      const provider = yield* providers.get(providerID)
      const model = yield* models.get(providerID, Model.ID.make("grok-4.6"))
      expect(provider?.settings?.transport).toBe("websocket")
      expect(model?.settings?.transport).toBeUndefined()
    }),
  )
})

describe("xAI device poll deadline (#900)", () => {
  test("an oversized device expires_in is clamped to the 10-minute attempt lifetime", () => {
    // 600000 is 10 minutes in milliseconds; unclamped it would poll for
    // ~6.9 days.
    expect(deviceDeadline(1_000, 600_000)).toBe(1_000 + MAX_DEVICE_LIFETIME_SECONDS * 1000)
    expect(deviceDeadline(0, MAX_DEVICE_LIFETIME_SECONDS + 1)).toBe(MAX_DEVICE_LIFETIME_SECONDS * 1000)
  })

  test("bounds the initial device poll interval and falls back on unusable values (#941)", () => {
    expect(deviceIntervalMs(5)).toBe(5000)
    expect(deviceIntervalMs(10)).toBe(10_000)
    expect(deviceIntervalMs(1)).toBe(1000)
    // Sub-second values are floored to 1 second instead of flooding the
    // token endpoint.
    expect(deviceIntervalMs(0.5)).toBe(1000)
    // An oversized or unit-confused interval is clamped to the 60-second
    // ceiling instead of overshooting the device deadline.
    expect(deviceIntervalMs(600)).toBe(60_000)
    expect(deviceIntervalMs(999_999)).toBe(60_000)
    // Zero, negative, non-finite, and absent values take the 5-second
    // fallback instead of busy-polling or never polling.
    for (const value of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, undefined])
      expect(deviceIntervalMs(value)).toBe(5000)
  })

  test("valid lifetimes pass through and absent or non-positive values take the 300-second default", () => {
    expect(deviceDeadline(0, 60)).toBe(60_000)
    expect(deviceDeadline(0, undefined)).toBe(300_000)
    expect(deviceDeadline(0, 0)).toBe(300_000)
    expect(deviceDeadline(0, -30)).toBe(300_000)
  })
})
