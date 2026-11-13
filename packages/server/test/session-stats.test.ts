import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const make = () =>
  ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
  })

const stats = (handler: (request: Request) => Promise<Response>, query: string) =>
  Effect.promise(() => handler(new Request(`http://opencode.local/api/experimental/session/stats?${query}`)))

it.live("reports a reversed stats range as reversed (#1000)", () =>
  Effect.gen(function* () {
    const handler = yield* make()
    const response = yield* stats(handler, "from=2000&to=1000")
    expect(response.status).toBe(400)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      _tag: "InvalidRequestError",
      message: "Stats range must end after it starts",
    })
  }).pipe(Effect.scoped),
)

it.live("reports an over-wide stats range as too wide, naming the maximum span (#1000)", () =>
  Effect.gen(function* () {
    const handler = yield* make()
    // 1970-01-01 to 2100-01-01 is far past the service span cap (3720 days).
    const response = yield* stats(handler, "from=0&to=4102444800000")
    expect(response.status).toBe(400)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      _tag: "InvalidRequestError",
      message: "Stats range is too wide: the maximum span is 3720 days",
    })
  }).pipe(Effect.scoped),
)
