import { expect } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { LLM } from "../src/index.js"
import { LLMClient } from "../src/route/client.js"
import { ClaudeCode } from "../src/providers/claude-code.js"
import { ClaudeCodeMessages } from "../src/protocols/claude-code-messages.js"
import { testEffect } from "./lib/effect.js"
import { runtimeLayer } from "./lib/http.js"
import { sseEvents } from "./lib/sse.js"

// #1834 criterion 3 (remainder, task 12821): the auth-layer tests assert
// claudeCodeAuth re-stamps the CLI User-Agent over the harness/session UA,
// but nothing asserted the UA that actually arrives on the wire after the
// HTTP transport merges request headers. This test compiles a claude-code
// request carrying the session UA in request.http.headers, runs it through
// the real HTTP transport (FetchHttpClient) against a stub listener, and
// asserts the listener receives the provider's stamped CLI UA — so a
// merge-order regression in the transport fails here, not in production.
testEffect(runtimeLayer(FetchHttpClient.layer)).live(
  "on-the-wire User-Agent is the claude-code CLI UA, not the session UA (#1834)",
  () =>
    Effect.gen(function* () {
      const seen: Array<{ path: string; userAgent: string | null; authorization: string | null }> = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
              seen.push({
                path: new URL(request.url).pathname,
                userAgent: request.headers.get("user-agent"),
                authorization: request.headers.get("authorization"),
              })
              return new Response(
                sseEvents(
                  { type: "message_start", message: { usage: { input_tokens: 9 } } },
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "Hi" },
                  },
                  { type: "content_block_stop", index: 0 },
                  {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn" },
                    usage: { output_tokens: 2 },
                  },
                  { type: "message_stop" },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const model = ClaudeCode.configure({
        accessToken: "fixture-oauth-token",
        baseURL: `http://127.0.0.1:${server.port}`,
      }).model("claude-haiku-5-5")
      const response = yield* LLMClient.generate(
        LLM.request({
          model,
          prompt: "Hello",
          // The harness/session UA, exactly as session requests carry it:
          // if the transport merge order regresses, this is the value the
          // stub listener would receive instead of the CLI UA.
          http: { headers: { "User-Agent": "opencode/prod/test/cli" } },
        }),
      )
      expect(response.text).toBe("Hi")
      expect(seen).toHaveLength(1)
      expect(seen[0]!.path).toEndWith("/messages")
      expect(seen[0]!.authorization).toBe("Bearer fixture-oauth-token")
      expect(seen[0]!.userAgent).toBe(ClaudeCodeMessages.CLI_USER_AGENT)
      expect(seen[0]!.userAgent).not.toBe("opencode/prod/test/cli")
    }),
)
