import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { InvalidRequestError, LocationNotFoundError, ServiceUnavailableError } from "../errors.js"

// OpenAI-compatible completions door for external harnesses (#1146).
// The wire format is the caller's (OpenAI chat completions), so payloads
// and responses stay deliberately unopinionated here: the server handler
// owns translation to and from the internal LLM shapes and answers raw.
// What this group pins is the route surface itself — paths, methods, and
// that server authorization applies like everywhere else.
export const CompletionsGroup = HttpApiGroup.make("server.completions")
  .add(
    HttpApiEndpoint.post("completions.chat", "/v1/chat/completions", {
      payload: Schema.Record(Schema.String, Schema.Unknown),
      success: Schema.Unknown,
      error: [InvalidRequestError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "completions.chat",
        summary: "Create a chat completion (OpenAI-compatible)",
        description:
          "Run one stateless chat completion for an external harness. The model is a route reference (opencode-route/workhorse or a bare route id) resolved in-process through the server's own route and provider resolution; no session is created or stored. Answers in the OpenAI chat-completions wire format, streamed as SSE when the payload asks for it.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("completions.responses", "/v1/responses", {
      payload: Schema.Record(Schema.String, Schema.Unknown),
      success: Schema.Unknown,
      error: [InvalidRequestError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "completions.responses",
        summary: "Create a response (OpenAI-compatible)",
        description:
          "The universal door in the Responses dialect: the same models the completions endpoint serves — route references and direct catalog provider/model refs — resolved in-process through the server's own route and provider resolution; no session is created or stored and no response is retained (previous_response_id is rejected). Answers in the OpenAI Responses wire format, streamed as typed SSE events when the payload asks for it.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("completions.embeddings", "/v1/embeddings", {
      payload: Schema.Record(Schema.String, Schema.Unknown),
      success: Schema.Unknown,
      error: [InvalidRequestError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "completions.embeddings",
        summary: "Create embeddings (OpenAI-compatible)",
        description:
          "Embed text with a registered embedding model. The model is a catalog ref (local-embed/snowflake-arctic-embed-m-v2.0, the first registered backend — a local Snowflake Arctic Embed server) or a bare embedding model id, resolved in-process against the embedding catalog; each registered model carries its own dimension and supported dimensions values, and an unsupported dimensions request is rejected. Input arrays pass through faithfully (varied lengths, no truncation at this layer). Answers in the OpenAI embeddings wire format; every call records a route_attempt row with session_id NULL like the other doors.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("completions.models", "/v1/models", {
      success: Schema.Unknown,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "completions.models",
        summary: "List completion models (OpenAI-compatible)",
        description: "The route models the completions door serves, in the OpenAI models-list wire format.",
      }),
    ),
  )
  .add(
    // The id a caller names is a single path segment here: a bare route
    // id from the models list (workhorse), or a full provider/model ref
    // with its slash URL-encoded (opencode-route%2Fworkhorse,
    // deepseek%2Fdeepseek-chat). The handler URL-decodes the segment.
    HttpApiEndpoint.get("completions.model", "/v1/models/:id", {
      params: { id: Schema.String },
      success: Schema.Unknown,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "completions.model",
        summary: "Get a completion model (OpenAI-compatible)",
        description:
          "The single model the completions door serves under the given id — a route reference (opencode-route/workhorse, or the bare route id from the models list) or a concrete catalog provider/model ref — in the same shape as a models-list entry. Unknown ids answer 404 in the OpenAI error shape.",
      }),
    ),
  )
  .add(
    // The same lookup for callers that send the id's slash raw instead
    // of URL-encoding it: /v1/models/opencode-route/workhorse and
    // /v1/models/deepseek/deepseek-chat. (A wildcard route cannot sit
    // next to the exact /v1/models route in this router, so the raw
    // two-segment form is its own endpoint; both share one handler.)
    HttpApiEndpoint.get("completions.modelRef", "/v1/models/:provider/:model", {
      params: { provider: Schema.String, model: Schema.String },
      success: Schema.Unknown,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "completions.modelRef",
        summary: "Get a completion model by provider/model ref (OpenAI-compatible)",
        description:
          "The single model the completions door serves under the given provider/model ref — a route reference (opencode-route/workhorse) or a concrete catalog ref (deepseek/deepseek-chat) — in the same shape as a models-list entry. Unknown ids answer 404 in the OpenAI error shape.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "completions",
      description: "OpenAI-compatible completions routes for external harnesses.",
    }),
  )
