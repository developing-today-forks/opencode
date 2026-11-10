import { describe, expect, test } from "bun:test"
import {
  AuthenticationError,
  InvalidRequestError,
  NoRouteError,
  AIError,
  HttpContext,
  ModelID,
  ProviderID,
} from "@opencode/ai"
import { toSessionError } from "@opencode/core/session/to-session-error"

const llm = (reason: AIError["reason"]) => new AIError({ reason })

// code#7073 step 4: a session outcome records the provider error text (already in
// `message`) plus the provider/model that failed — the endpoint identity, as the
// case-(b) dig named it (provider opencode-go.drewrypope serving claude-haiku-5-5).
// Oracle: every test here fails on unpatched code, where the outcome carried neither.
describe("toSessionError outcome recording (code#7073 step 4)", () => {
  test("records the serving provider/model from caller context on an auth failure", () => {
    expect(
      toSessionError(llm(new AuthenticationError({ message: "OAuth access token has been revoked." })), {
        model: { providerID: "claude-code", id: "claude-haiku-5-5" },
      }),
    ).toEqual({
      type: "provider.auth",
      message: "OAuth access token has been revoked.",
      provider: "claude-code",
      model: "claude-haiku-5-5",
    })
  })

  test("records provider and model for a routing 404", () => {
    expect(
      toSessionError(
        llm(
          new InvalidRequestError({
            message: "Provider request failed with HTTP 404",
            http: new HttpContext({ url: "https://opencode-go.example/v1", status: 404, headers: {} }),
          }),
        ),
        { model: { providerID: "opencode-go.drewrypope", id: "claude-haiku-5-5" } },
      ),
    ).toEqual({
      type: "provider.invalid-request",
      message: "Provider request failed with HTTP 404",
      status: 404,
      provider: "opencode-go.drewrypope",
      model: "claude-haiku-5-5",
    })
  })

  test("reason-carried provider/model win over caller context (no-route)", () => {
    expect(
      toSessionError(
        llm(
          new NoRouteError({
            message: "failed",
            route: "route",
            provider: ProviderID.make("provider"),
            model: ModelID.make("model"),
          }),
        ),
        { model: { providerID: "other", id: "other-model" } },
      ),
    ).toMatchObject({ type: "provider.no-route", provider: "provider", model: "model" })
  })

  test("omits provider/model when nothing is known", () => {
    expect(toSessionError(llm(new AuthenticationError({ message: "auth" })))).toEqual({
      type: "provider.auth",
      message: "auth",
    })
  })
})
