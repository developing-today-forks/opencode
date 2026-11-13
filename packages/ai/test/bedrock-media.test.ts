import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Media, Message } from "../src/index.js"
import { BedrockMedia } from "../src/protocols/utils/bedrock-media.js"
import { it } from "./lib/effect.js"

describe("BedrockMedia.lower", () => {
  it.effect("rejects prototype-named media types instead of reading the format tables through the prototype chain", () =>
    Effect.gen(function* () {
      for (const mediaType of ["constructor", "toString", "__proto__"]) {
        const error = yield* BedrockMedia.lower(Message.media(Media.base64("AQID", mediaType)), new Set()).pipe(
          Effect.flip,
        )
        expect(error.message).toContain(`Bedrock Converse does not support media type ${mediaType}`)
      }
    }),
  )

  it.effect("still lowers known image and document media types", () =>
    Effect.gen(function* () {
      const image = yield* BedrockMedia.lower(Message.media(Media.base64("AQID", "image/png")), new Set())
      expect(image).toEqual([{ image: { format: "png", source: { bytes: "AQID" } } }])
      const document = yield* BedrockMedia.lower(Message.media(Media.base64("AQID", "application/pdf")), new Set())
      expect(document).toEqual([{ document: { format: "pdf", name: "document", source: { bytes: "AQID" } } }])
    }),
  )
})
