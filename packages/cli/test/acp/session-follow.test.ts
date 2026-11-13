import { describe, expect, test } from "bun:test"
import { RequestError, type SessionNotification } from "@agentclientprotocol/sdk"
import type { OpenCodeClient } from "@opencode/client/effect"
import type { Session } from "@opencode/schema/session"
import { Effect, Queue, Stream } from "effect"
import type { Catalog } from "../../src/acp/catalog"
import { availableCommands, configOptions } from "../../src/acp/config-option"
import type { ACPConnection } from "../../src/acp/connection"
import { ACPSessions } from "../../src/acp/sessions"

// Oracle for opencode#2391: a sessionUpdate write that fails once must not be
// dropped silently. The follower keeps the pre-write catalog as `previous`, so
// the next catalog step re-sends the complete configOptions and
// availableCommands state, and the client ends with the current state.
describe("acp session follower failed writes", () => {
  test("re-sends the complete config and command state after a one-time sessionUpdate failure", async () => {
    const model = {
      id: "test-model",
      providerID: "test",
      name: "Test Model",
      hidden: false,
      variants: [{ id: "default" }, { id: "high" }],
    }
    const catalogA = {
      models: [model],
      defaultModel: { providerID: "test", id: "test-model" },
      modes: [{ id: "build", name: "Build" }],
      defaultModeID: "build",
      commands: [{ name: "review", description: "Review changes" }],
    } as unknown as Catalog
    const catalogB = {
      models: [model],
      defaultModel: { providerID: "test", id: "test-model" },
      modes: [
        { id: "build", name: "Build" },
        { id: "plan", name: "Plan" },
      ],
      defaultModeID: "build",
      commands: [
        { name: "review", description: "Review changes" },
        { name: "deploy", description: "Deploy it" },
      ],
    } as unknown as Catalog

    const received: SessionNotification[] = []
    let configAttempts = 0
    let failuresLeft = 1
    const connection = {
      sessionUpdate: (params: SessionNotification) =>
        Effect.suspend(() => {
          if (params.update.sessionUpdate === "config_option_update") {
            configAttempts++
            if (failuresLeft > 0) {
              failuresLeft--
              return Effect.fail(RequestError.internalError({}, "write failed"))
            }
          }
          received.push(params)
          return Effect.void
        }),
      requestPermission: () => Effect.die("unused"),
      extNotification: () => Effect.void,
      createElicitation: () => Effect.die("unused"),
      responded: () => Effect.void,
    } as unknown as ACPConnection.Interface

    const client = {
      event: {
        subscribe: () => Stream.make({ type: "server.connected" } as never).pipe(Stream.concat(Stream.never)),
      },
      mcp: { add: () => Effect.void },
    } as unknown as OpenCodeClient

    const until = (check: () => boolean, what: string) =>
      Effect.gen(function* () {
        const start = Date.now()
        while (!check()) {
          if (Date.now() - start > 5_000) return yield* Effect.die(`timed out waiting for ${what}`)
          yield* Effect.sleep("10 millis")
        }
      })

    const program = Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* Queue.unbounded<Catalog>()
        const catalog = {
          get: () => Effect.succeed(catalogA),
          reload: () => Effect.void,
          changes: () => Stream.fromQueue(changes),
        }
        const sessions = yield* ACPSessions.make({ client, connection, catalog })
        yield* sessions.attach({ id: "ses_follow" } as unknown as Session.Info, "/workspace", [])
        // The attach publishes the current (A) commands before any catalog step.
        yield* until(
          () => received.some((item) => item.update.sessionUpdate === "available_commands_update"),
          "initial commands",
        )
        // Step to B: the first config_option_update write fails.
        yield* Queue.offer(changes, catalogB)
        yield* until(() => configAttempts === 1 && failuresLeft === 0, "the failed write")
        // The next step to the same catalog must re-send the complete B state:
        // with the old fold this step was a no-op because `previous` had already
        // advanced past the failed write.
        yield* Queue.offer(changes, catalogB)
        yield* until(
          () =>
            received.some((item) => item.update.sessionUpdate === "config_option_update") &&
            received.some(
              (item) =>
                item.update.sessionUpdate === "available_commands_update" &&
                JSON.stringify(item.update.availableCommands) === JSON.stringify(availableCommands(catalogB)),
            ),
          "the re-sent B state",
        )
      }),
    )
    await Effect.runPromise(program)

    // The failed write was attempted, then retried by the next step.
    expect(configAttempts).toBe(2)
    const config = received.find((item) => item.update.sessionUpdate === "config_option_update")
    expect(config?.update.sessionUpdate === "config_option_update" ? config.update.configOptions : undefined).toEqual(
      configOptions(catalogB, {}),
    )
    const commands = received.filter((item) => item.update.sessionUpdate === "available_commands_update")
    expect(commands.at(-1)?.update).toEqual({
      sessionUpdate: "available_commands_update",
      availableCommands: availableCommands(catalogB),
    })
  })
})
