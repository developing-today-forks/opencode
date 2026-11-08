import { expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { Shell } from "@opencode/core/shell"
import { Global } from "@opencode/util/global"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { it } from "./lib/effect"

// Coverage for #999: Shell timeout durations are normalised at the service boundary.
// In-process callers (and plugin hooks mutating the invocation) reach Shell.create /
// Shell.timeout without the schemas' NonNegativeInt validation: a negative or NaN
// duration used to complete the timeout sleep immediately and kill a just-started
// command as "timed out", and Infinity silently disabled the timeout. Policy pinned
// here: non-finite or negative durations take the disabled sentinel (0), a finite
// oversized duration clamps to the house bound (2^31-1 ms) so it stays a set timeout,
// and valid durations behave exactly as before.
if (process.platform !== "win32") {
  const provide = <A, E>(effect: Effect.Effect<A, E, Shell.Service>) =>
    effect.pipe(
      Effect.provide(
        AppNodeBuilder.build(Shell.node, [
          Location.node.replace(tempLocationLayer),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(hostEnvironmentLayer),
        ]),
      ),
    )

  const running = Effect.fnUntraced(function* (shell: Shell.Interface, duration: number) {
    const info = yield* shell.create({ shell: "/bin/sh", command: "sleep 10", timeout: duration })
    // Long enough for an unnormalised negative/NaN sleep (fires at ~0 ms) to kill the
    // command, far short of the 10 s the command itself would run.
    yield* Effect.sleep("300 millis")
    return { info, status: (yield* shell.get(info.id)).status }
  })

  it.live("negative, NaN, and infinite create durations disable the timeout instead of killing instantly", () =>
    provide(
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        for (const duration of [-1, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
          const { info, status } = yield* running(shell, duration)
          expect(status).toBe("running")
          // Re-setting a valid timeout afterwards still replaces the (absent) fiber
          // and ends the command as a timeout.
          yield* shell.timeout(info.id, 60)
          expect((yield* shell.wait(info.id)).status).toBe("timeout")
        }
      }),
    ),
  )

  it.live("a very large finite duration stays a set timeout (clamped, not disabled or instant)", () =>
    provide(
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        const { info, status } = yield* running(shell, 3e9)
        expect(status).toBe("running")
        yield* shell.timeout(info.id, 60)
        expect((yield* shell.wait(info.id)).status).toBe("timeout")
      }),
    ),
  )

  it.live("Shell.timeout with an invalid duration disables a previously set timeout", () =>
    provide(
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        const info = yield* shell.create({ shell: "/bin/sh", command: "sleep 10", timeout: 120 })
        yield* shell.timeout(info.id, -1)
        yield* Effect.sleep("300 millis")
        expect((yield* shell.get(info.id)).status).toBe("running")
        yield* shell.timeout(info.id, 60)
        expect((yield* shell.wait(info.id)).status).toBe("timeout")
      }),
    ),
  )

  it.live("valid durations are unchanged: 0 disables and a positive duration fires", () =>
    provide(
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        const zero = yield* running(shell, 0)
        expect(zero.status).toBe("running")
        yield* shell.timeout(zero.info.id, 60)
        expect((yield* shell.wait(zero.info.id)).status).toBe("timeout")

        const timed = yield* shell.create({ shell: "/bin/sh", command: "sleep 10", timeout: 80 })
        expect((yield* shell.wait(timed.id)).status).toBe("timeout")
      }),
    ),
  )
}
