import { beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Integration } from "@opencode/core/integration"
import { WebSearch } from "@opencode/core/websearch"
import { WebSearchExa } from "@opencode/core/plugin/websearch/exa"
import { WebSearchFirecrawl } from "@opencode/core/plugin/websearch/firecrawl"
import { WebSearchParallel } from "@opencode/core/plugin/websearch/parallel"
import { WebSearchTavily } from "@opencode/core/plugin/websearch/tavily"
import { WebSearchTinyFish } from "@opencode/core/plugin/websearch/tinyfish"
import { host, integrationHost, webSearchHost } from "./host"
import {
  requests,
  signals,
  resetWebSearchFixture,
  setResponseHeaders,
  webSearchIntegrationTest,
} from "./websearch-fixture"

beforeEach(() => {
  resetWebSearchFixture(
    `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: "Title: Effect\nURL: https://effect.website\nPublished: 2026-07-25T00:00:00.000Z\nAuthor: N/A\nHighlights:\nEffect documentation",
            _meta: { searchTime: 123 },
          },
        ],
      },
    })}\n\n`,
  )
})

const it = webSearchIntegrationTest

describe("built-in web search providers", () => {
  ;[
    WebSearchExa.Plugin,
    WebSearchParallel.Plugin,
    WebSearchFirecrawl.Plugin,
    WebSearchTavily.Plugin,
    WebSearchTinyFish.Plugin,
  ].forEach((plugin) => {
    it.effect(`releases rate-limited HTTP requests for ${plugin.id} before caching their errors`, () =>
      Effect.gen(function* () {
        resetWebSearchFixture("Rate limited", 429)
        const integrations = yield* Integration.Service
        const websearch = yield* WebSearch.Service
        yield* plugin.effect(host({ integration: integrationHost(integrations), websearch: webSearchHost(websearch) }))
        yield* websearch.select("random")
        expect(yield* websearch.query({ query: "limited" }).pipe(Effect.flip)).toBeInstanceOf(WebSearch.RequestError)
        expect(signals).toHaveLength(1)
        expect(signals[0]?.aborted).toBe(true)
      }),
    )
  })

  it.effect("registers a provider without an integration", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const websearch = yield* WebSearch.Service
      const registration = yield* webSearchHost(websearch).transform((editor) => {
        editor.add({
          id: "test-websearch",
          name: "Test Web Search",
          execute: (input) => Effect.succeed([{ url: "https://example.com", content: input.query, time: {} }]),
        })
      })

      expect(yield* integrations.get(Integration.ID.make("test-websearch"))).toBeUndefined()
      expect(yield* websearch.providers()).toContainEqual({
        id: WebSearch.ID.make("test-websearch"),
        name: "Test Web Search",
      })
      yield* registration.dispose
      expect(yield* websearch.providers()).not.toContainEqual({
        id: WebSearch.ID.make("test-websearch"),
        name: "Test Web Search",
      })
    }),
  )

  it.effect("registers Firecrawl with the standard key method", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const websearch = yield* WebSearch.Service
      yield* WebSearchFirecrawl.Plugin.effect(
        host({ integration: integrationHost(integrations), websearch: webSearchHost(websearch) }),
      )

      expect(yield* integrations.get(Integration.ID.make("firecrawl"))).toMatchObject({
        id: "firecrawl",
        name: "Firecrawl",
        methods: [{ type: "key" }, { type: "env", names: ["FIRECRAWL_API_KEY"] }],
      })
    }),
  )

  it.effect("registers Exa with its MCP schema", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const websearch = yield* WebSearch.Service
      yield* WebSearchExa.Plugin.effect(
        host({ integration: integrationHost(integrations), websearch: webSearchHost(websearch) }),
      )

      const info = yield* integrations.get(Integration.ID.make("exa"))
      expect(info).toMatchObject({
        id: "exa",
        name: "Exa",
        methods: [{ type: "key" }, { type: "env", names: ["EXA_API_KEY"] }],
      })
      yield* integrations.connection.key({ integrationID: Integration.ID.make("exa"), key: "exa secret" })
      expect(yield* websearch.query({ query: "effect typescript", providerID: WebSearch.ID.make("exa") })).toEqual(
        new WebSearch.Response({
          providerID: WebSearch.ID.make("exa"),
          results: [
            {
              url: "https://effect.website",
              title: "Effect",
              content: "Effect documentation",
              time: { published: Date.parse("2026-07-25T00:00:00.000Z") },
            },
          ],
        }),
      )
      expect(requests).toEqual([
        {
          url: `${WebSearchExa.endpoint}?exaApiKey=exa+secret`,
          headers: expect.any(Object),
          body: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "web_search_exa",
              arguments: { query: "effect typescript", numResults: 8 },
            },
          },
        },
      ])
    }),
  )

  it.effect("registers Parallel and keeps its credential in the authorization header", () =>
    Effect.gen(function* () {
      resetWebSearchFixture(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "search results" }],
            structuredContent: {
              search_id: "search_1",
              results: [
                {
                  url: "https://effect.website",
                  title: "Effect",
                  publish_date: null,
                  excerpts: ["Effect documentation"],
                },
              ],
              warnings: null,
              usage: [{ name: "sku_search", count: 1 }],
              session_id: "ses_parallel",
            },
          },
        }),
      )
      const integrations = yield* Integration.Service
      const websearch = yield* WebSearch.Service
      yield* WebSearchParallel.Plugin.effect(
        host({ integration: integrationHost(integrations), websearch: webSearchHost(websearch) }),
      )
      expect(yield* integrations.get(Integration.ID.make("parallel"))).toMatchObject({
        methods: [{ type: "key" }, { type: "env", names: ["PARALLEL_API_KEY"] }],
      })
      yield* integrations.connection.key({
        integrationID: Integration.ID.make("parallel"),
        key: "parallel-secret",
      })

      const output = yield* websearch.query({
        query: "effect layers",
        providerID: WebSearch.ID.make("parallel"),
      })
      expect(output).toEqual(
        new WebSearch.Response({
          providerID: WebSearch.ID.make("parallel"),
          results: [
            {
              url: "https://effect.website",
              title: "Effect",
              content: "Effect documentation",
              time: {},
            },
          ],
        }),
      )
      expect(requests[0]).toMatchObject({
        url: WebSearchParallel.endpoint,
        headers: { authorization: "Bearer parallel-secret" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "web_search",
            arguments: {
              objective: "effect layers",
              search_queries: ["effect layers"],
            },
          },
        },
      })
      expect(JSON.stringify(output)).not.toContain("parallel-secret")
    }),
  )


  it.effect("omits calendar-invalid Exa published dates and keeps valid ones (#785)", () =>
    Effect.gen(function* () {
      const text = [
        "Title: Bad Date\nURL: https://bad.example\nPublished: 2026-02-30T00:00:00.000Z\nHighlights:\nBad date content",
        "Title: Good Date\nURL: https://good.example\nPublished: 2026-07-25T00:00:00.000Z\nHighlights:\nGood date content",
      ].join("\n\n---\n\n")
      resetWebSearchFixture(
        "event: message\ndata: " +
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text, _meta: { searchTime: 123 } }] },
          }) +
          "\n\n",
      )
      const integrations = yield* Integration.Service
      const websearch = yield* WebSearch.Service
      yield* WebSearchExa.Plugin.effect(
        host({ integration: integrationHost(integrations), websearch: webSearchHost(websearch) }),
      )
      yield* integrations.connection.key({ integrationID: Integration.ID.make("exa"), key: "exa secret" })
      expect(yield* websearch.query({ query: "dates", providerID: WebSearch.ID.make("exa") })).toEqual(
        new WebSearch.Response({
          providerID: WebSearch.ID.make("exa"),
          results: [
            { url: "https://bad.example", title: "Bad Date", content: "Bad date content", time: {} },
            {
              url: "https://good.example",
              title: "Good Date",
              content: "Good date content",
              time: { published: Date.parse("2026-07-25T00:00:00.000Z") },
            },
          ],
        }),
      )
    }),
  )

  it.effect("omits calendar-invalid Parallel publish dates and keeps valid ones (#785)", () =>
    Effect.gen(function* () {
      resetWebSearchFixture(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "search results" }],
            structuredContent: {
              search_id: "search_1",
              results: [
                { url: "https://bad.example", title: "Bad Date", publish_date: "2026-04-31", excerpts: ["Bad"] },
                {
                  url: "https://hour.example",
                  title: "Hour Date",
                  publish_date: "2026-01-01T24:00:00Z",
                  excerpts: ["Hour"],
                },
                { url: "https://good.example", title: "Good Date", publish_date: "2026-07-25", excerpts: ["Good"] },
              ],
              warnings: null,
              usage: [{ name: "sku_search", count: 1 }],
              session_id: "ses_parallel",
            },
          },
        }),
      )
      const integrations = yield* Integration.Service
      const websearch = yield* WebSearch.Service
      yield* WebSearchParallel.Plugin.effect(
        host({ integration: integrationHost(integrations), websearch: webSearchHost(websearch) }),
      )
      yield* integrations.connection.key({
        integrationID: Integration.ID.make("parallel"),
        key: "parallel-secret",
      })
      expect(yield* websearch.query({ query: "dates", providerID: WebSearch.ID.make("parallel") })).toEqual(
        new WebSearch.Response({
          providerID: WebSearch.ID.make("parallel"),
          results: [
            { url: "https://bad.example", title: "Bad Date", content: "Bad", time: {} },
            { url: "https://hour.example", title: "Hour Date", content: "Hour", time: {} },
            {
              url: "https://good.example",
              title: "Good Date",
              content: "Good",
              time: { published: Date.parse("2026-07-25") },
            },
          ],
        }),
      )
    }),
  )

  it.effect("registers Tavily with keyless and keyed Search API access", () =>
    Effect.gen(function* () {
      resetWebSearchFixture(
        JSON.stringify({
          query: "effect typescript",
          results: [
            {
              url: "https://effect.website",
              title: "Effect",
              content: "Effect documentation",
              score: 0.99,
            },
          ],
        }),
      )
      const integrations = yield* Integration.Service
      const websearch = yield* WebSearch.Service
      yield* WebSearchTavily.Plugin.effect(
        host({ integration: integrationHost(integrations), websearch: webSearchHost(websearch) }),
      )

      expect(yield* integrations.get(Integration.ID.make("tavily"))).toMatchObject({
        id: "tavily",
        name: "Tavily",
        methods: [{ type: "key" }, { type: "env", names: ["TAVILY_API_KEY"] }],
      })
      const query = {
        query: "effect typescript",
        providerID: WebSearch.ID.make("tavily"),
      }
      expect(yield* websearch.query(query)).toEqual(
        new WebSearch.Response({
          providerID: WebSearch.ID.make("tavily"),
          results: [
            {
              url: "https://effect.website",
              title: "Effect",
              content: "Effect documentation",
              time: {},
            },
          ],
        }),
      )
      expect(requests[0]).toMatchObject({
        url: WebSearchTavily.endpoint,
        headers: { "x-client-name": "opencode2", "x-tavily-access-mode": "keyless" },
        body: {
          query: "effect typescript",
          search_depth: "basic",
          chunks_per_source: 3,
          max_results: 8,
        },
      })
      expect(requests[0]?.headers.authorization).toBeUndefined()

      yield* integrations.connection.key({
        integrationID: Integration.ID.make("tavily"),
        key: "tavily-secret",
      })
      yield* websearch.query(query)
      expect(requests[1]).toMatchObject({
        headers: { authorization: "Bearer tavily-secret", "x-client-name": "opencode2" },
      })
      expect(requests[1]?.headers["x-tavily-access-mode"]).toBeUndefined()
    }),
  )

  it.effect("registers TinyFish with keyless and keyed MCP search access", () =>
    Effect.gen(function* () {
      resetWebSearchFixture(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  query: "effect typescript",
                  results: [
                    {
                      position: 1,
                      site_name: "effect.website",
                      snippet: "Effect documentation",
                      title: "Effect",
                      url: "https://effect.website",
                    },
                  ],
                  total_results: 1,
                  page: 0,
                }),
              },
            ],
          },
        }),
      )
      const integrations = yield* Integration.Service
      const websearch = yield* WebSearch.Service
      yield* WebSearchTinyFish.Plugin.effect(
        host({ integration: integrationHost(integrations), websearch: webSearchHost(websearch) }),
      )

      expect(yield* integrations.get(Integration.ID.make("tinyfish"))).toMatchObject({
        id: "tinyfish",
        name: "TinyFish",
        methods: [{ type: "key" }, { type: "env", names: ["TINYFISH_API_KEY"] }],
      })
      expect(yield* websearch.query({ query: "effect typescript", providerID: WebSearch.ID.make("tinyfish") })).toEqual(
        new WebSearch.Response({
          providerID: WebSearch.ID.make("tinyfish"),
          results: [
            {
              url: "https://effect.website",
              title: "Effect",
              content: "Effect documentation",
              time: {},
            },
          ],
        }),
      )
      expect(requests[0]).toMatchObject({
        url: WebSearchTinyFish.endpoint,
        headers: { "x-tinyfish-access-mode": "keyless" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "search",
            arguments: { query: "effect typescript" },
          },
        },
      })
      expect(requests[0]?.headers.authorization).toBeUndefined()

      yield* integrations.connection.key({
        integrationID: Integration.ID.make("tinyfish"),
        key: "tinyfish-secret",
      })
      setResponseHeaders({ "mcp-session-id": "ses_tinyfish" })
      yield* websearch.query({ query: "effect typescript", providerID: WebSearch.ID.make("tinyfish") })
      expect(requests[1]?.body).toMatchObject({ method: "initialize" })
      expect(requests[2]?.body).toMatchObject({ method: "notifications/initialized" })
      expect(requests[3]).toMatchObject({
        headers: { "x-api-key": "tinyfish-secret", "mcp-session-id": "ses_tinyfish" },
        body: { method: "tools/call" },
      })
      expect(requests[3]?.headers["x-tinyfish-access-mode"]).toBeUndefined()
    }),
  )
})

describe("WebSearch cooldownMillis retry-after grammar", () => {
  const now = 1_700_000_000_000

  test("rejects hex and exponent spellings to the 60-second fallback", () => {
    expect(WebSearch.cooldownMillis("1e3", now)).toBe(60_000)
    expect(WebSearch.cooldownMillis("0x10", now)).toBe(60_000)
    expect(WebSearch.cooldownMillis("1.5", now)).toBe(60_000)
    expect(WebSearch.cooldownMillis("+7", now)).toBe(60_000)
  })

  test("keeps authored plain delay-seconds unchanged", () => {
    expect(WebSearch.cooldownMillis("0", now)).toBe(0)
    expect(WebSearch.cooldownMillis("7", now)).toBe(7_000)
    expect(WebSearch.cooldownMillis(" 12 ", now)).toBe(12_000)
  })

  test("keeps the existing fallbacks for unusable values", () => {
    expect(WebSearch.cooldownMillis(undefined, now)).toBe(60_000)
    expect(WebSearch.cooldownMillis("", now)).toBe(60_000)
    expect(WebSearch.cooldownMillis(" ", now)).toBe(60_000)
    expect(WebSearch.cooldownMillis("-5", now)).toBe(60_000)
    expect(WebSearch.cooldownMillis("garbage", now)).toBe(60_000)
  })

  test("keeps HTTP-date retry-after values", () => {
    expect(WebSearch.cooldownMillis(new Date(now + 90_000).toUTCString(), now)).toBe(90_000)
    expect(WebSearch.cooldownMillis(new Date(now - 90_000).toUTCString(), now)).toBe(0)
  })

  test("rejects calendar-invalid ISO dates to the 60-second fallback (#713)", () => {
    expect(WebSearch.cooldownMillis("2026-02-30T00:00:00Z", now)).toBe(60_000)
    expect(WebSearch.cooldownMillis("2026-13-01T00:00:00Z", now)).toBe(60_000)
    expect(WebSearch.cooldownMillis("2026-01-01T24:00:00Z", now)).toBe(60_000)
  })

  test("keeps valid ISO retry-after dates (#713)", () => {
    expect(WebSearch.cooldownMillis(new Date(now + 90_000).toISOString(), now)).toBe(90_000)
    expect(WebSearch.cooldownMillis(new Date(now - 90_000).toISOString(), now)).toBe(0)
  })
})
