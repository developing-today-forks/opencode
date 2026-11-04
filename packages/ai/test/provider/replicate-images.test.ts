import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientRequest } from "effect/http"
import { Image, ImageClient } from "../../src/index.js"
import { Replicate } from "../../src/providers.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, json } from "../lib/http.js"
import { queuedPoll } from "./queued-recording.js"

const model = Replicate.configure({
apiKey: "x".repeat(4)
}).image("black-forest-labs/flux-schnell")

const prediction = (completed_at: string | null) => ({
  id: "pred-780",
  status: "succeeded",
  output: ["https://replicate.delivery/test/out-0.webp"],
  error: null,
  data_removed: false,
  completed_at,
  metrics: { predict_time: 0.25 },
  urls: {
    get: "https://api.replicate.com/v1/predictions/pred-780",
    cancel: "https://api.replicate.com/v1/predictions/pred-780/cancel",
  },
})

const generate = (completed_at: string | null) =>
  Image.generate({ model, prompt: "A simple flat black circle." }, { poll: queuedPoll }).pipe(
    Effect.provide(
      ImageClient.layer.pipe(
        Layer.provideMerge(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(["POST", "GET"]).toContain(request.method)
              return json(input, prediction(completed_at))
            }),
          ),
        ),
      ),
    ),
  )

describe("Replicate Images completed_at expiry", () => {
  it.effect("derives expiresAt as exactly completed_at + 1 hour for a valid timestamp", () =>
    Effect.gen(function* () {
      const response = yield* generate("2026-09-23T18:42:04.540Z")
      expect(response.images).toHaveLength(1)
      expect(response.image.expiresAt).toBe(Date.parse("2026-09-23T18:42:04.540Z") + 3_600_000)
    }),
  )

  it.effect("leaves expiresAt undefined for a calendar-invalid completed_at (Feb 30)", () =>
    Effect.gen(function* () {
      const response = yield* generate("2026-02-30T10:00:00Z")
      expect(response.image.expiresAt).toBeUndefined()
    }),
  )

  it.effect("leaves expiresAt undefined for a calendar-invalid completed_at (Apr 31)", () =>
    Effect.gen(function* () {
      const response = yield* generate("2026-04-31T10:00:00Z")
      expect(response.image.expiresAt).toBeUndefined()
    }),
  )

  it.effect("leaves expiresAt undefined for an unparseable completed_at", () =>
    Effect.gen(function* () {
      const response = yield* generate("garbage")
      expect(response.image.expiresAt).toBeUndefined()
    }),
  )

  it.effect("leaves expiresAt undefined for a calendar-invalid named-form completed_at (Feb 30 2026)", () =>
    Effect.gen(function* () {
      const response = yield* generate("Feb 30 2026")
      expect(response.image.expiresAt).toBeUndefined()
    }),
  )

  it.effect("derives expiresAt from a valid named-form completed_at", () =>
    Effect.gen(function* () {
      const response = yield* generate("Wed, 21 Oct 2015 07:28:00 GMT")
      expect(response.image.expiresAt).toBe(Date.parse("Wed, 21 Oct 2015 07:28:00 GMT") + 3_600_000)
    }),
  )

  it.effect("leaves expiresAt undefined when completed_at is absent", () =>
    Effect.gen(function* () {
      const response = yield* generate(null)
      expect(response.image.expiresAt).toBeUndefined()
    }),
  )
})
