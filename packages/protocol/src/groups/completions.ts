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
  .annotateMerge(
    OpenApi.annotations({
      title: "completions",
      description: "OpenAI-compatible completions routes for external harnesses.",
    }),
  )
