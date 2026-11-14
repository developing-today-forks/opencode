import { describe, expect } from "bun:test"
import { AIError, LLMEvent, ProviderInternalError } from "@opencode/ai"
import { SessionHedge } from "@opencode/core/session/runner/hedge"
import { Effect, Option, Stream } from "effect"
import { it } from "./lib/effect"

const answer = (id: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text: id }),
]
const failure = new AIError({ reason: new ProviderInternalError({ message: "down" }) })

/** A stream that stays silent for `delay` and then emits `events`, or fails. */
const after = (delay: number, events: readonly LLMEvent[], error?: AIError) =>
  Stream.fromEffect(Effect.sleep(delay)).pipe(
    Stream.flatMap(() => (error ? Stream.fail(error) : Stream.fromIterable(events))),
  )

const texts = (stream: Stream.Stream<LLMEvent, AIError>) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((events) => events.flatMap((event) => (event.type === "text-delta" ? [event.text] : []))),
  )

const hedge = (stream: Stream.Stream<LLMEvent, AIError>) => Effect.succeed(Option.some({ value: "hedge", stream }))

describe("SessionHedge.race", () => {
  it.live("keeps the primary when it answers before the hedge delay, and never starts the hedge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let started = false
        const result = yield* SessionHedge.race({
          primary: after(10, answer("primary")),
          afterMs: 200,
          deadlineMs: 2_000,
          start: Effect.sync(() => {
            started = true
            return Option.none()
          }),
        })
        expect(result.winner).toBe("primary")
        expect(result.hedgeStarted).toBe(false)
        expect(started).toBe(false)
        expect(yield* texts(result.stream)).toEqual(["primary"])
      }),
    ),
  )

  it.live("lets the hedge win when the primary stays silent, and replays all of its events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* SessionHedge.race({
          primary: after(5_000, answer("primary")),
          afterMs: 30,
          deadlineMs: 2_000,
          start: hedge(after(20, answer("hedge"))),
        })
        expect(result.winner).toBe("hedge")
        expect(result.value).toBe("hedge")
        expect(result.hedgeStarted).toBe(true)
        expect(yield* texts(result.stream)).toEqual(["hedge"])
      }),
    ),
  )

  it.live("keeps the primary when it answers while the hedge is still silent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* SessionHedge.race({
          primary: after(80, answer("primary")),
          afterMs: 30,
          deadlineMs: 2_000,
          start: hedge(after(5_000, answer("hedge"))),
        })
        expect(result.winner).toBe("primary")
        expect(result.hedgeStarted).toBe(true)
        expect(yield* texts(result.stream)).toEqual(["primary"])
      }),
    ),
  )

  it.live("hands the win to the hedge when the primary fails without answering", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* SessionHedge.race({
          primary: after(60, [], failure),
          afterMs: 30,
          deadlineMs: 2_000,
          start: hedge(after(100, answer("hedge"))),
        })
        expect(result.winner).toBe("hedge")
        expect(yield* texts(result.stream)).toEqual(["hedge"])
      }),
    ),
  )

  it.live("returns the primary's failure when both fail, so normal failover handling applies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* SessionHedge.race({
          primary: after(50, [], failure),
          afterMs: 30,
          deadlineMs: 2_000,
          start: hedge(after(10, [], failure)),
        })
        expect(result.winner).toBe("primary")
        expect(yield* result.stream.pipe(Stream.runCollect, Effect.flip)).toBe(failure)
      }),
    ),
  )

  it.live("fails a leg whose non-output flood overflows the buffer bound instead of buffering without limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const flood = Array.from({ length: 64 }, () => LLMEvent.stepStart({ index: 0 }))
        const result = yield* SessionHedge.race({
          primary: Stream.fromIterable(flood),
          afterMs: 200,
          deadlineMs: 2_000,
          start: hedge(after(20, answer("hedge"))),
          maxBufferedEventsPerLeg: 8,
        })
        expect(result.winner).toBe("primary")
        const error = yield* result.stream.pipe(Stream.runCollect, Effect.flip)
        expect(error.reason).toBeInstanceOf(ProviderInternalError)
        expect(error.reason.message).toContain("buffered more than 8 events")
      }),
    ),
  )

  it.live("hands the win to the hedge when the primary overflows after the hedge started", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const flood = Array.from({ length: 64 }, () => LLMEvent.stepStart({ index: 0 }))
        const result = yield* SessionHedge.race({
          primary: after(50, flood),
          afterMs: 30,
          deadlineMs: 2_000,
          start: hedge(after(20, answer("hedge"))),
          maxBufferedEventsPerLeg: 8,
        })
        expect(result.winner).toBe("hedge")
        expect(yield* texts(result.stream)).toEqual(["hedge"])
      }),
    ),
  )

  it.live("fails the winning leg explicitly when a slow consumer lets it overflow, never truncating silently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const burst = [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "winner" }),
          ...Array.from({ length: 500 }, (_, i) => LLMEvent.textDelta({ id: "winner", text: `t${i}` })),
        ]
        const result = yield* SessionHedge.race({
          primary: Stream.fromIterable(burst),
          afterMs: 200,
          deadlineMs: 2_000,
          start: Effect.succeed(Option.none()),
          maxBufferedEventsPerLeg: 8,
        })
        expect(result.winner).toBe("primary")
        // The consumer arrives late: the producer has long since tripped the bound.
        yield* Effect.sleep(100)
        const error = yield* result.stream.pipe(Stream.runCollect, Effect.flip)
        expect(error.reason).toBeInstanceOf(ProviderInternalError)
        expect(error.reason.message).toContain("buffered more than 8 events")
      }),
    ),
  )

  it.live("replays a long in-bound stream completely and in order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const deltas = Array.from({ length: 200 }, (_, i) => `d${i}`)
        const events = [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "long" }),
          ...deltas.map((text) => LLMEvent.textDelta({ id: "long", text })),
        ]
        const result = yield* SessionHedge.race({
          primary: after(10, events),
          afterMs: 200,
          deadlineMs: 2_000,
          start: Effect.succeed(Option.none()),
        })
        expect(result.winner).toBe("primary")
        expect(yield* texts(result.stream)).toEqual(deltas)
      }),
    ),
  )

  it.live("falls back to the primary at the deadline when nothing answers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* SessionHedge.race({
          primary: Stream.never,
          afterMs: 20,
          deadlineMs: 1_100,
          start: hedge(Stream.never),
        })
        expect(result.winner).toBe("primary")
        expect(result.hedgeStarted).toBe(true)
      }),
    ),
  )
})
