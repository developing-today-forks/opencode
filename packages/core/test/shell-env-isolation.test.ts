import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { SessionSchema } from "@opencode/core/session/schema"
import { Shell } from "@opencode/core/shell"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { it } from "./lib/effect"

// Regression coverage for #20: a plugin that rewrites TMPDIR in
// `shell.hook("create.before")` (the durable-tmpdir plugin) must affect only the
// spawned child shell — never the server's own process.env, the stored session
// environment, or later shells once the hook is gone.
if (process.platform !== "win32") {
  it.live("create.before env mutations reach the child shell only", () =>
    Effect.gen(function* () {
      // Real directories: the test fixtures create their own temp dirs under
      // whatever TMPDIR the process reports, so the sentinel values must exist.
      const base = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-env-isolation-")))
      const original = path.join(base, "server")
      const sessionValue = path.join(base, "session")
      const mutated = path.join(base, "hook")
      yield* Effect.promise(() => Promise.all([original, sessionValue, mutated].map((dir) => fs.mkdir(dir))))
      const previous = process.env.TMPDIR
      process.env.TMPDIR = original
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(base, { recursive: true, force: true })).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (previous === undefined) delete process.env.TMPDIR
              else process.env.TMPDIR = previous
            }),
          ),
          Effect.orDie,
        ),
      )

      yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        const hooks = yield* PluginHooks.Service
        const environments = yield* SessionEnvironment.Service
        const sessionID = SessionSchema.ID.make("ses_env_isolation")
        yield* environments.set(sessionID, { TMPDIR: sessionValue })

        const registration = yield* hooks.register("shell", "create.before", (invocation) =>
          Effect.sync(() => {
            invocation.env.TMPDIR = mutated
          }),
        )

        // Process-env base: the child sees the hook value, the server process does not.
        const first = yield* shell.create({ shell: "/bin/sh", command: `printf %s "$TMPDIR"`, timeout: 0 })
        expect((yield* shell.result(first)).capture?.output).toBe(mutated)
        expect(process.env.TMPDIR).toBe(original)

        // Session-env base: the child sees the hook value, the stored session env is unchanged.
        const second = yield* shell.create({
          shell: "/bin/sh",
          command: `printf %s "$TMPDIR"`,
          timeout: 0,
          metadata: { sessionID },
        })
        expect((yield* shell.result(second)).capture?.output).toBe(mutated)
        expect(yield* environments.get(sessionID)).toEqual({ TMPDIR: sessionValue })
        expect(process.env.TMPDIR).toBe(original)

        // Once the hook is disposed, later shells see the unmutated base env again.
        yield* registration.dispose
        const third = yield* shell.create({ shell: "/bin/sh", command: `printf %s "$TMPDIR"`, timeout: 0 })
        expect((yield* shell.result(third)).capture?.output).toBe(original)
        expect(process.env.TMPDIR).toBe(original)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Shell.node, PluginHooks.node, SessionEnvironment.node]), [
            Location.node.replace(tempLocationLayer),
            Global.node.replace(tempGlobalLayer),
            Config.node.replace(Config.testLayer()),
            Environment.node.replace(hostEnvironmentLayer),
          ]),
        ),
      )
    }),
  )
  // Regression coverage for #2266: a stored session environment is a partial
  // overlay, not a complete environment. The server itself stores a two-variable
  // environment (MCPX_SESSION_ID / MCPX_PARENT_SESSION_ID) for every subagent
  // child session, and clients may store snapshots carrying an empty HOME or a
  // broken PATH. Neither may strip HOME/PATH from other sessions shells: a
  // partial session environment inherits everything it does not set from the
  // server environment, and an empty HOME/PATH counts as unset.
  it.live("partial or broken session environments cannot strip HOME/PATH from other shells", () =>
    Effect.gen(function* () {
      const base = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-env-overlay-")))
      const home = path.join(base, "home")
      const bin = path.join(base, "bin")
      yield* Effect.promise(() => Promise.all([fs.mkdir(home), fs.mkdir(bin)]))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(bin, "fleetprobe"), "#!/bin/sh\nprintf probe-ok\n", { mode: 0o755 }),
      )
      const pathValue = [bin, "/usr/bin", "/bin"].join(path.delimiter)
      const previousHome = process.env.HOME
      const previousPath = process.env.PATH
      process.env.HOME = home
      process.env.PATH = pathValue
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(base, { recursive: true, force: true })).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (previousHome === undefined) delete process.env.HOME
              else process.env.HOME = previousHome
              if (previousPath === undefined) delete process.env.PATH
              else process.env.PATH = previousPath
            }),
          ),
          Effect.orDie,
        ),
      )

      yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        const environments = yield* SessionEnvironment.Service
        const broken = SessionSchema.ID.make("ses_env_broken")
        const partial = SessionSchema.ID.make("ses_env_partial")
        yield* environments.set(broken, { PATH: "/no-such-path", HOME: "" })
        yield* environments.set(partial, { MCPX_SESSION_ID: "mcpx-sub-test" })

        // Partial session env: its own variable is set, HOME/PATH come from the server env.
        const child = yield* shell.create({
          shell: "/bin/sh",
          command: `printf %s "$HOME|$PATH|$MCPX_SESSION_ID"`,
          timeout: 0,
          metadata: { sessionID: partial },
        })
        expect((yield* shell.result(child)).capture?.output).toBe(`${home}|${pathValue}|mcpx-sub-test`)

        // Basic command availability through the inherited PATH.
        const probe = yield* shell.create({
          shell: "/bin/sh",
          command: `command -v fleetprobe && fleetprobe`,
          timeout: 0,
          metadata: { sessionID: partial },
        })
        expect((yield* shell.result(probe)).capture?.output).toBe(`${path.join(bin, "fleetprobe")}\nprobe-ok`)

        // The broken session empty HOME counts as unset; its explicit PATH is
        // its own override and stays confined to that session.
        const brokenHome = yield* shell.create({
          shell: "/bin/sh",
          command: `printf %s "$HOME"`,
          timeout: 0,
          metadata: { sessionID: broken },
        })
        expect((yield* shell.result(brokenHome)).capture?.output).toBe(home)

        // A fresh shell with no session environment is unaffected by either session.
        const fresh = yield* shell.create({ shell: "/bin/sh", command: `printf %s "$HOME|$PATH"`, timeout: 0 })
        expect((yield* shell.result(fresh)).capture?.output).toBe(`${home}|${pathValue}`)
        expect(process.env.HOME).toBe(home)
        expect(process.env.PATH).toBe(pathValue)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Shell.node, PluginHooks.node, SessionEnvironment.node]), [
            Location.node.replace(tempLocationLayer),
            Global.node.replace(tempGlobalLayer),
            Config.node.replace(Config.testLayer()),
            Environment.node.replace(hostEnvironmentLayer),
          ]),
        ),
      )
    }),
  )
}
