import { describe, expect, test } from "bun:test"
import { LLM } from "../src/index.js"
import * as OpenAIChat from "../src/protocols/openai-chat.js"
import { Endpoint } from "../src/route.js"
import { LanguageModel } from "../src/schema/index.js"

const request = () =>
  LLM.request({
    model: LanguageModel.make({
      id: "model-1",
      provider: "test",
      route: OpenAIChat.route,
    }),
    prompt: "hello",
  })

describe("Endpoint", () => {
  test("appends a static path to the model's baseURL", () => {
    const url = Endpoint.render(Endpoint.path("/chat", { baseURL: "https://api.example.test/v1/" }), {
      request: request(),
      body: {},
    })

    expect(url.toString()).toBe("https://api.example.test/v1/chat")
  })

  test("endpoint query params are appended to the rendered URL", () => {
    const url = Endpoint.render(
      Endpoint.path("/chat?alt=sse", {
        baseURL: "https://custom.example.test/root/",
        query: { "api-version": "2026-01-01", alt: "json" },
      }),
      {
        request: request(),
        body: {},
      },
    )

    expect(url.toString()).toBe("https://custom.example.test/root/chat?alt=json&api-version=2026-01-01")
  })

  test("does not double a trailing /v1 baseURL segment against a /v1 path (#1956)", () => {
    const url = Endpoint.render(
      Endpoint.path("/v1/messages", { baseURL: "https://gateway.example.test/anthropic/v1" }),
      {
        request: request(),
        body: {},
      },
    )

    expect(url.toString()).toBe("https://gateway.example.test/anthropic/v1/messages")
  })

  test("does not double a matching /v2 baseURL segment against a /v2 path", () => {
    const url = Endpoint.render(Endpoint.path("/v2/transcript", { baseURL: "https://api.example.test/v2" }), {
      request: request(),
      body: {},
    })

    expect(url.toString()).toBe("https://api.example.test/v2/transcript")
  })

  test("keeps a /v1 path intact when the baseURL does not end in /v1", () => {
    const url = Endpoint.render(Endpoint.path("/v1/messages?beta=true", { baseURL: "https://api.example.test" }), {
      request: request(),
      body: {},
    })

    expect(url.toString()).toBe("https://api.example.test/v1/messages?beta=true")
  })

  test("path may be a function of the validated body", () => {
    const url = Endpoint.render(
      Endpoint.path<{ readonly modelId: string }>(
        ({ body }) => `/model/${encodeURIComponent(body.modelId)}/converse-stream`,
        { baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com" },
      ),
      {
        request: request(),
        body: { modelId: "us.amazon.nova-micro-v1:0" },
      },
    )

    expect(url.toString()).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-micro-v1%3A0/converse-stream",
    )
  })
})
