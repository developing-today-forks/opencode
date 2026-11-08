import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Image, ImageClient } from "../src/index.js"
import { BlackForestLabs, Replicate, Stability } from "../src/providers.js"
import { it } from "./lib/effect.js"
import { dynamicResponse, json } from "./lib/http.js"

const recordingLayer = (urls: Array<string>, body: unknown) =>
  ImageClient.layer.pipe(
    Layer.provideMerge(
      dynamicResponse((input) =>
        Effect.sync(() => {
          urls.push(`${input.request.method} ${input.request.url}`)
          return json(input, body)
        }),
      ),
    ),
  )

const attempt = (effect: Effect.Effect<unknown, unknown, ImageClient>, urls: Array<string>, body: unknown) =>
  effect.pipe(Effect.provide(recordingLayer(urls, body)), Effect.result)

describe("probe: image routes with version-suffixed baseURL", () => {
  it.effect("captures submit URLs", () =>
    Effect.gen(function* () {
      // BFL, version-suffixed base vs bare control
      const bflV: Array<string> = []
      yield* attempt(
        Image.start({
          model: BlackForestLabs.configure({ apiKey: "test", baseURL: "https://bfl.test/v1" }).image("flux-2-pro"),
          prompt: "A lighthouse",
        }),
        bflV,
        { id: "req_1", polling_url: "https://bfl.test/v1/get_result?id=req_1" },
      )
      const bflBare: Array<string> = []
      yield* attempt(
        Image.start({
          model: BlackForestLabs.configure({ apiKey: "test", baseURL: "https://bfl.test" }).image("flux-2-pro"),
          prompt: "A lighthouse",
        }),
        bflBare,
        { id: "req_1", polling_url: "https://bfl.test/v1/get_result?id=req_1" },
      )
      console.log("BFL versioned:", JSON.stringify(bflV), "bare:", JSON.stringify(bflBare))

      // Replicate official model, version-suffixed base vs bare control
      const repV: Array<string> = []
      yield* attempt(
        Image.start({
          model: Replicate.configure({ apiKey: "test", baseURL: "https://replicate.test/v1" }).image("owner/model"),
          prompt: "A lighthouse",
        }),
        repV,
        { id: "p_1", status: "starting", urls: { get: "https://replicate.test/p_1", cancel: "https://replicate.test/p_1/cancel" } },
      )
      const repBare: Array<string> = []
      yield* attempt(
        Image.start({
          model: Replicate.configure({ apiKey: "test", baseURL: "https://replicate.test" }).image("owner/model"),
          prompt: "A lighthouse",
        }),
        repBare,
        { id: "p_1", status: "starting", urls: { get: "https://replicate.test/p_1", cancel: "https://replicate.test/p_1/cancel" } },
      )
      console.log("Replicate versioned:", JSON.stringify(repV), "bare:", JSON.stringify(repBare))

      // Stability generate (sync), version-suffixed base vs bare control
      const stabV: Array<string> = []
      yield* attempt(
        Image.generate({
          model: Stability.configure({ apiKey: "test", baseURL: "https://stability.test/v2beta" }).image("sd3.5-large"),
          prompt: "A lighthouse",
        }),
        stabV,
        { image: "aGVsbG8=", seed: 1, finish_reason: "SUCCESS" },
      )
      const stabBare: Array<string> = []
      yield* attempt(
        Image.generate({
          model: Stability.configure({ apiKey: "test", baseURL: "https://stability.test" }).image("sd3.5-large"),
          prompt: "A lighthouse",
        }),
        stabBare,
        { image: "aGVsbG8=", seed: 1, finish_reason: "SUCCESS" },
      )
      console.log("Stability generate versioned:", JSON.stringify(stabV), "bare:", JSON.stringify(stabBare))

      // Stability upscale (queued submit), version-suffixed base vs bare control
      const upV: Array<string> = []
      yield* attempt(
        Image.start({
          model: Stability.configure({ apiKey: "test", baseURL: "https://stability.test/v2beta" }).upscale(),
        }),
        upV,
        { id: "up_1" },
      )
      const upBare: Array<string> = []
      yield* attempt(
        Image.start({
          model: Stability.configure({ apiKey: "test", baseURL: "https://stability.test" }).upscale(),
        }),
        upBare,
        { id: "up_1" },
      )
      console.log("Stability upscale versioned:", JSON.stringify(upV), "bare:", JSON.stringify(upBare))

      expect(bflV.length + repV.length + stabV.length + upV.length).toBeGreaterThan(0)
    }),
  )
})
