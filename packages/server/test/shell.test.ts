import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const options = {
  app: { version: "test-version" },
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
} as const

it.live("shell.remove returns 404 ShellNotFoundError for a missing shell command", () =>
  Effect.gen(function* () {
    const config = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-shell-remove-")))
    const handler = yield* ServerFetch.make({ ...options, config: { directory: config.path } })
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/shell/sh_missing", {
          method: "DELETE",
          headers: { "x-opencode-directory": encodeURIComponent(config.path) },
        }),
      ),
    )
    const text = yield* Effect.promise(() => response.text())
    expect(response.status).toBe(404)
    expect(JSON.parse(text)).toEqual({
      _tag: "ShellNotFoundError",
      id: "sh_missing",
      message: "Shell command not found: sh_missing",
    })
  }),
)
