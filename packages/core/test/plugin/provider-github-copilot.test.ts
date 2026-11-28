import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { decodeOAuthDevice, decodeOAuthToken } from "@opencode/core/plugin/provider/github-copilot"

describe("GitHub Copilot OAuth decode (#2884)", () => {
  // Oracle: the failure channel. A wrong-shape 200 body must arrive as a typed
  // failure carrying the unreadable-response error; a defect (die) in the
  // cause means the schema throw escaped through Effect.map again.
  const expectTypedFailure = async (run: () => Effect.Effect<unknown, Error>, message: string) => {
    const exit = await Effect.runPromise(Effect.exit(run()))
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    expect(Cause.hasDies(exit.cause)).toBe(false)
    const reason = exit.cause.reasons.find(Cause.isFailReason)
    expect(reason).toBeDefined()
    const error = reason?.error
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : undefined).toBe(message)
  }

  test("a wrong-shape device 200 body fails typed instead of dying", async () => {
    await expectTypedFailure(
      () => decodeOAuthDevice({ verification_uri: "https://github.com/login/device" }),
      "GitHub Copilot device authorization returned an unreadable response body",
    )
  })

  test("a string-interval device 200 body fails typed instead of dying", async () => {
    await expectTypedFailure(
      () =>
        decodeOAuthDevice({
          verification_uri: "https://github.com/login/device",
          user_code: "ABCD-EFGH",
          device_code: "device-code",
          interval: "5",
        }),
      "GitHub Copilot device authorization returned an unreadable response body",
    )
  })

  test("a wrong-typed token 200 body fails typed instead of dying", async () => {
    await expectTypedFailure(
      () => decodeOAuthToken({ access_token: 123 }),
      "GitHub Copilot token poll returned an unreadable response body",
    )
  })

  test("a non-object token 200 body fails typed instead of dying", async () => {
    await expectTypedFailure(
      () => decodeOAuthToken("captive portal"),
      "GitHub Copilot token poll returned an unreadable response body",
    )
  })

  test("well-formed bodies still decode", async () => {
    const device = await Effect.runPromise(
      decodeOAuthDevice({
        verification_uri: "https://github.com/login/device",
        user_code: "ABCD-EFGH",
        device_code: "device-code",
        interval: 5,
      }),
    )
    expect(device).toEqual({
      verification_uri: "https://github.com/login/device",
      user_code: "ABCD-EFGH",
      device_code: "device-code",
      interval: 5,
    })
    const token = await Effect.runPromise(decodeOAuthToken({ error: "authorization_pending" }))
    expect(token).toEqual({ error: "authorization_pending" })
  })
})
