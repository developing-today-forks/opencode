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

// Coverage for #964: Shell.output pages a finished command's file by cursor/limit, and in-process
// callers reach the service without the HTTP schema's NonNegativeInt validation. Invalid paging
// inputs must be normalised at the service boundary instead of defecting (negative/NaN limit or
// NaN cursor fed Buffer.alloc), stalling (limit 0 returned a non-advancing empty page), or
// leaking a fractional cursor the Output schema forbids.
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

  const setup = Effect.gen(function* () {
    const shell = yield* Shell.Service
    const info = yield* shell.create({ shell: "/bin/sh", command: "printf 0123456789", timeout: 0 })
    yield* shell.wait(info.id)
    return { shell, info }
  })

  it.live("valid paging inputs behave exactly as before, including the caught-up page", () =>
    provide(
      Effect.gen(function* () {
        const { shell, info } = yield* setup
        expect(yield* shell.output(info.id, { cursor: 0, limit: 4 })).toEqual({
          output: "0123",
          cursor: 4,
          size: 10,
          truncated: false,
        })
        expect(yield* shell.output(info.id, { cursor: 4, limit: 4 })).toEqual({
          output: "4567",
          cursor: 8,
          size: 10,
          truncated: false,
        })
        expect(yield* shell.output(info.id)).toEqual({
          output: "0123456789",
          cursor: 10,
          size: 10,
          truncated: false,
        })
        expect(yield* shell.output(info.id, { cursor: 10 })).toEqual({
          output: "",
          cursor: 10,
          size: 10,
          truncated: false,
        })
        expect(yield* shell.output(info.id, { cursor: 999 })).toEqual({
          output: "",
          cursor: 10,
          size: 10,
          truncated: false,
        })
        // result()'s tail read (cursor/size arithmetic over the same method) is unchanged.
        expect((yield* shell.result(info)).capture).toEqual({ output: "0123456789", truncated: false })
      }),
    ),
  )

  it.live("negative and non-finite paging inputs take the defaults instead of defecting", () =>
    provide(
      Effect.gen(function* () {
        const { shell, info } = yield* setup
        for (const input of [
          { cursor: -5, limit: 3 },
          { cursor: Number.NaN, limit: 3 },
          { cursor: Number.POSITIVE_INFINITY, limit: 3 },
          { cursor: -0.5, limit: 3 },
        ]) {
          expect(yield* shell.output(info.id, input)).toEqual({
            output: "012",
            cursor: 3,
            size: 10,
            truncated: false,
          })
        }
        for (const input of [
          { cursor: 0, limit: -5 },
          { cursor: 0, limit: Number.NaN },
          { cursor: 0, limit: Number.POSITIVE_INFINITY },
        ]) {
          expect(yield* shell.output(info.id, input)).toEqual({
            output: "0123456789",
            cursor: 10,
            size: 10,
            truncated: false,
          })
        }
      }),
    ),
  )

  it.live("limit 0 returns an advancing page instead of a non-advancing empty one", () =>
    provide(
      Effect.gen(function* () {
        const { shell, info } = yield* setup
        const page = yield* shell.output(info.id, { cursor: 0, limit: 0 })
        expect(page.output).toBe("0")
        expect(page.cursor).toBe(1)
        expect(page.size).toBe(10)
      }),
    ),
  )

  it.live("fractional paging inputs are floored and the returned cursor stays an integer", () =>
    provide(
      Effect.gen(function* () {
        const { shell, info } = yield* setup
        const page = yield* shell.output(info.id, { cursor: 1.5, limit: 2.9 })
        expect(page).toEqual({ output: "12", cursor: 3, size: 10, truncated: false })
        expect(Number.isInteger(page.cursor)).toBe(true)
        expect(yield* shell.output(info.id, { cursor: 0, limit: 3.7 })).toEqual({
          output: "012",
          cursor: 3,
          size: 10,
          truncated: false,
        })
      }),
    ),
  )
}
