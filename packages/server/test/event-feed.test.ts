import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/schema/credential"
import { Event } from "@opencode/schema/event"
import { IntegrationID } from "@opencode/schema/integration-id"
import type { OpenCodeEvent } from "@opencode/protocol/groups/event"
import { Deferred, Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import { it } from "../../core/test/lib/effect"
import { EventFeed } from "../src/event-feed"

const Internal = Bus.ephemeral({ type: "test.internal", schema: { value: Schema.String } })

const event = (id: string): Event.Payload<typeof Agent.Event.Updated> => ({
  id: Event.ID.make(`evt_${id}`),
  created: Date.now(),
  type: Agent.Event.Updated.type,
  data: {},
})

const internal = (value: string): Event.Payload<typeof Internal> => ({
  id: Event.ID.create(),
  created: Date.now(),
  type: Internal.type,
  data: { value },
})

function makeSource() {
  let subscriber: Bus.Subscriber | undefined
  return {
    observe: (next: Bus.Subscriber) =>
      Effect.sync(() => {
        subscriber = next
        return Effect.sync(() => {
          if (subscriber === next) subscriber = undefined
        })
      }),
    publish: (event: Event.Payload) => Effect.suspend(() => (subscriber ? subscriber(event) : Effect.void)),
  }
}

// Encodes each frame as its wire id and records the ids in publish order, so tests can name events.
function ids() {
  const sent: string[] = []
  return {
    sent,
    encode: (_event: OpenCodeEvent, id: string) => {
      sent.push(id)
      return id
    },
  }
}

function parse(text: string) {
  const lines = text.split("\n")
  const data = lines.find((line) => line.startsWith("data: "))
  if (data === undefined) throw new Error(`no data line in ${JSON.stringify(text)}`)
  const id = lines[0]?.startsWith("id: ") ? lines[0].slice(4) : undefined
  const { type } = JSON.parse(data.slice(6)) as { readonly type: string }
  return { id, type }
}

describe("EventFeed", () => {
  test("preserves the public SSE frame encoding", () => {
    const payload = event("wire")
    expect(EventFeed.frame(payload)).toBe(`data: ${JSON.stringify(payload)}\n\n`)
  })

  test("writes the wire id before the data line", () => {
    const payload = event("wire")
    expect(EventFeed.frame(payload, "instance:3")).toBe(`id: instance:3\ndata: ${JSON.stringify(payload)}\n\n`)
  })

  it.effect("encodes once and delivers the same frame to every subscriber", () =>
    Effect.gen(function* () {
      let encodes = 0
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        encode: (event) => {
          encodes += 1
          return event.type
        },
      })
      const first = yield* feed.subscribe()
      const second = yield* feed.subscribe()
      const left = yield* first.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const right = yield* second.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)

      yield* source.publish(event("example"))

      expect([Array.from(yield* Fiber.join(left)), Array.from(yield* Fiber.join(right))]).toEqual([
        [Agent.Event.Updated.type],
        [Agent.Event.Updated.type],
      ])
      expect(encodes).toBe(1)
    }),
  )

  it.effect("fails only the subscriber that exceeds its lag capacity", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        capacity: 1,
        encode: (event) => event.id,
      })
      const slow = yield* feed.subscribe()
      const fast = yield* feed.subscribe()
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const received = new Array<string>()
      const fastFiber = yield* fast.pipe(
        Stream.take(3),
        Stream.runForEach((frame) =>
          Effect.sync(() => received.push(frame)).pipe(
            Effect.andThen(
              frame === "evt_one"
                ? Deferred.succeed(first, undefined)
                : frame === "evt_two"
                  ? Deferred.succeed(second, undefined)
                  : Effect.void,
            ),
          ),
        ),
        Effect.forkScoped,
      )

      yield* source.publish(event("one"))
      yield* Deferred.await(first)
      yield* source.publish(event("two"))
      yield* Deferred.await(second)
      yield* source.publish(event("three"))

      yield* Fiber.join(fastFiber)

      const result = yield* slow.pipe(Stream.runCollect, Effect.exit)
      expect(received).toEqual(["evt_one", "evt_two", "evt_three"])
      expect(Exit.isFailure(result)).toBeTrue()
      if (Exit.isSuccess(result)) return
      expect(Option.getOrUndefined(Exit.findErrorOption(result))).toBeInstanceOf(EventFeed.SubscriberOverflowError)
    }),
  )

  it.effect("delivers global credential events to public subscribers", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { encode: (event) => event.type })
      const stream = yield* feed.subscribe()
      const received = yield* stream.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)

      yield* source.publish({
        id: Event.ID.create(),
        created: Date.now(),
        type: Credential.Event.Switched.type,
        data: {
          credentialID: Credential.ID.make("cred_test"),
          integrationID: IntegrationID.make("openai"),
        },
      })

      expect(Array.from(yield* Fiber.join(received))).toEqual([Credential.Event.Switched.type])
    }),
  )

  it.effect("filters internal events before they consume subscriber capacity", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, { capacity: 1, encode: (event) => event.type })
      const stream = yield* feed.subscribe()

      yield* source.publish(internal("one"))
      yield* source.publish(internal("two"))
      yield* source.publish(event("public"))

      expect(Array.from(yield* stream.pipe(Stream.take(1), Stream.runCollect))).toEqual([Agent.Event.Updated.type])
    }),
  )


  it.effect("resyncs a reconnect from a pre-failure cursor after an encoding failure with no live subscribers", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const sent: string[] = []
      const feed = yield* EventFeed.make(source.observe, {
        encode: (event, id) => {
          sent.push(id)
          if (event.id === Event.ID.make("evt_bad")) throw new Error("invalid event")
          return EventFeed.frame(event, id)
        },
      })
      // No subscriber is connected at any point in this test: the failure
      // must still invalidate the pre-failure cursor (#2271).
      yield* source.publish(event("one"))
      yield* source.publish(event("bad"))
      yield* source.publish(event("two"))

      const stream = yield* feed.subscribe(sent[0])
      const received = yield* stream.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* source.publish(event("three"))
      const frames = Array.from(yield* Fiber.join(received)).map(parse)

      // The reconnect gets a resync, not the retained frame for "two",
      // and live frames follow it with no gap.
      expect(frames.map((f) => f.type)).toEqual(["server.resync", Agent.Event.Updated.type])
      // The resync cursor is current: replaying after it is contiguous
      // (no second resync) and yields only later frames.
      const resyncID = frames[0].id
      if (resyncID === undefined) throw new Error("resync frame has no id")
      const again = yield* feed.subscribe(resyncID)
      const replayed = yield* again.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* source.publish(event("four"))
      expect(Array.from(yield* Fiber.join(replayed)).map(parse).map((f) => f.type)).toEqual([
        Agent.Event.Updated.type,
      ])
    }),
  )

  it.effect("resyncs a reconnect from a pre-failure cursor after an encoding failure with a live subscriber", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const sent: string[] = []
      const feed = yield* EventFeed.make(source.observe, {
        encode: (event, id) => {
          sent.push(id)
          if (event.id === Event.ID.make("evt_bad")) throw new Error("invalid event")
          return EventFeed.frame(event, id)
        },
      })
      const current = yield* feed.subscribe()
      const failed = yield* current.pipe(Stream.runCollect, Effect.exit, Effect.forkScoped)
      yield* source.publish(event("one"))
      yield* source.publish(event("bad"))
      const exit = yield* Fiber.join(failed)
      expect(Exit.isFailure(exit)).toBeTrue()

      yield* source.publish(event("two"))
      const stream = yield* feed.subscribe(sent[0])
      const first = Array.from(yield* stream.pipe(Stream.take(1), Stream.runCollect))
      expect(first.map(parse).map((f) => f.type)).toEqual(["server.resync"])
    }),
  )

  it.effect("disconnects current subscribers after an encoding failure and continues for later subscribers", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(source.observe, {
        encode: (event) => {
          if (event.id === Event.ID.make("evt_bad")) throw new Error("invalid event")
          return event.id
        },
      })
      const current = yield* feed.subscribe()
      const failed = yield* current.pipe(Stream.runCollect, Effect.exit, Effect.forkScoped)

      yield* source.publish(event("bad"))
      const exit = yield* Fiber.join(failed)

      const next = yield* feed.subscribe()
      const received = yield* next.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* source.publish(event("good"))

      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isSuccess(exit)) return
      expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBeInstanceOf(EventFeed.EncodingError)
      expect(Array.from(yield* Fiber.join(received))).toEqual(["evt_good"])
    }),
  )

  it.effect("replays the frames after a buffered id, then goes live", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const { sent, encode } = ids()
      const feed = yield* EventFeed.make(source.observe, { encode })
      // Published with no subscriber connected: the ring must still hold them.
      yield* source.publish(event("one"))
      yield* source.publish(event("two"))
      yield* source.publish(event("three"))

      const stream = yield* feed.subscribe(sent[0])
      yield* source.publish(event("four"))

      expect(Array.from(yield* stream.pipe(Stream.take(3), Stream.runCollect))).toEqual([sent[1], sent[2], sent[3]])
    }),
  )

  it.effect("answers the newest id with live events only", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const { sent, encode } = ids()
      const feed = yield* EventFeed.make(source.observe, { encode })
      yield* source.publish(event("one"))

      const stream = yield* feed.subscribe(sent[0])
      yield* source.publish(event("two"))

      expect(Array.from(yield* stream.pipe(Stream.take(1), Stream.runCollect))).toEqual([sent[1]])
    }),
  )

  it.effect("keeps the frame just before the window replayable, since nothing after it is missing", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const { sent, encode } = ids()
      const feed = yield* EventFeed.make(source.observe, { encode, replayFrames: 2 })
      for (const name of ["one", "two", "three", "four"]) yield* source.publish(event(name))

      // The window is [three, four]; `two` is just before it.
      const stream = yield* feed.subscribe(sent[1])
      expect(Array.from(yield* stream.pipe(Stream.take(2), Stream.runCollect))).toEqual([sent[2], sent[3]])
    }),
  )

  it.effect("sends one resync frame with the head id when the cursor has aged out, then goes live", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const { sent, encode } = ids()
      const feed = yield* EventFeed.make(source.observe, { encode, replayFrames: 2 })
      for (const name of ["one", "two", "three", "four"]) yield* source.publish(event(name))

      const stream = yield* feed.subscribe(sent[0])
      yield* source.publish(event("five"))
      const [resync, live] = Array.from(yield* stream.pipe(Stream.take(2), Stream.runCollect))

      expect(parse(resync!)).toEqual({ id: sent[3], type: "server.resync" })
      expect(live).toBe(sent[4])
    }),
  )

  it.effect("resyncs on a malformed or future id, even from this process", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const { sent, encode } = ids()
      const feed = yield* EventFeed.make(source.observe, { encode })
      yield* source.publish(event("one"))
      const future = sent[0]!.replace(/:\d+$/, ":999")

      for (const cursor of ["not-a-cursor", future, `${sent[0]}x`]) {
        const stream = yield* feed.subscribe(cursor)
        expect(parse(Array.from(yield* stream.pipe(Stream.take(1), Stream.runCollect))[0]!).type).toBe("server.resync")
      }
    }),
  )

  it.effect("resyncs a cursor from a previous process instance", () =>
    Effect.gen(function* () {
      const before = makeSource()
      const previous = ids()
      yield* EventFeed.make(before.observe, { encode: previous.encode })
      yield* before.publish(event("one"))

      // A restart builds a new feed; its instance id differs, so the old cursor is foreign.
      const restarted = makeSource()
      const current = ids()
      const feed = yield* EventFeed.make(restarted.observe, { encode: current.encode })
      const stream = yield* feed.subscribe(previous.sent[0])
      const [resync] = Array.from(yield* stream.pipe(Stream.take(1), Stream.runCollect))

      const parsed = parse(resync!)
      expect(parsed.type).toBe("server.resync")
      // The new instance has produced nothing, so its head is sequence zero.
      expect(parsed.id?.endsWith(":0")).toBeTrue()
      expect(parsed.id?.split(":")[0]).not.toBe(previous.sent[0]?.split(":")[0])
    }),
  )

  it.effect("keeps no frames when the ring is zero, so only the head cursor is accepted", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const { sent, encode } = ids()
      const feed = yield* EventFeed.make(source.observe, { encode, replayFrames: 0 })
      yield* source.publish(event("one"))
      yield* source.publish(event("two"))

      const head = yield* feed.subscribe(sent[1])
      yield* source.publish(event("three"))
      expect(Array.from(yield* head.pipe(Stream.take(1), Stream.runCollect))).toEqual([sent[2]])

      const behind = yield* feed.subscribe(sent[0])
      expect(parse(Array.from(yield* behind.pipe(Stream.take(1), Stream.runCollect))[0]!).type).toBe("server.resync")
    }),
  )

  it.effect("drops the whole window when one frame exceeds the byte bound", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const { sent, encode } = ids()
      const big = Event.ID.make("evt_big")
      const feed = yield* EventFeed.make(source.observe, {
        replayBytes: 50,
        encode: (event, id) => (event.id === big ? `${encode(event, id)}${"x".repeat(60)}` : encode(event, id)),
      })
      yield* source.publish(event("one"))
      yield* source.publish(event("big"))
      yield* source.publish(event("three"))

      // Replaying from `one` would skip `big`, so the window must not offer it.
      const behind = yield* feed.subscribe(sent[0])
      expect(parse(Array.from(yield* behind.pipe(Stream.take(1), Stream.runCollect))[0]!).type).toBe("server.resync")

      // The frame before `three` is the oversized one, which is just outside the window, so it still replays.
      const after = yield* feed.subscribe(sent[1])
      expect(Array.from(yield* after.pipe(Stream.take(1), Stream.runCollect))).toEqual([sent[2]])
    }),
  )
})
