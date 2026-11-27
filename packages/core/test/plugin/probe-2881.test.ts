import { test } from "bun:test"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { decode } from "@opencode/core/plugin/provider/xai"

const TokenShape = Schema.Struct({ access_token: Schema.String })
const run = () => Effect.runPromise(Effect.exit(decode(new Response("<html>captive portal</html>"), TokenShape)))

test("A1 isFailure", async () => {
  const exit = await run()
  if (!Exit.isFailure(exit)) throw new Error("not failure")
})

test("A2 noDies", async () => {
  const exit = await run()
  if (!Exit.isFailure(exit)) throw new Error("not failure")
  if (Cause.hasDies(exit.cause)) throw new Error("has dies")
})

test("A3 failureSome", async () => {
  const exit = await run()
  if (!Exit.isFailure(exit)) throw new Error("not failure")
  if (!Option.isSome(Cause.failureOption(exit.cause))) throw new Error("no failure option")
})

test("A4 message", async () => {
  const exit = await run()
  if (!Exit.isFailure(exit)) throw new Error("not failure")
  const error = Option.getOrUndefined(Cause.failureOption(exit.cause))
  if (!(error instanceof Error)) throw new Error("not an Error")
  if (error.message !== "xAI request returned an unreadable response body") throw new Error(`message: ${error.message}`)
})
