export * as EventFeed from "./event-feed"

import { Bus } from "@opencode/core/bus"
import { Event } from "@opencode/schema/event"
import { isOpenCodeEvent, type OpenCodeEvent } from "@opencode/protocol/groups/event"
import { Cause, Context, Effect, Layer, Queue, Schema, Scope, Stream } from "effect"

export const SubscriberCapacity = 4_096
/** Frames kept for Last-Event-ID replay. Zero keeps none, so every reconnect resyncs. */
export const ReplayCapacity = 1_024
/** Approximate memory bound for retained frames, counted in UTF-16 code units. */
export const ReplayBytes = 4 * 1024 * 1024

export class SubscriberOverflowError extends Schema.TaggedError<SubscriberOverflowError>()(
  "EventFeed.SubscriberOverflow",
  { capacity: Schema.Int },
) {}

export class EncodingError extends Schema.TaggedError<EncodingError>()("EventFeed.EncodingError", {
  eventID: Event.ID,
  eventType: Schema.String,
  cause: Schema.Defect(),
}) {}

export type Error = SubscriberOverflowError | EncodingError

export interface Interface {
  /**
   * Subscribes to live frames. A `lastEventID` from this process's current instance is answered with
   * the frames after it; a foreign or evicted id is answered with one `server.resync` frame. Either
   * way the frames that follow are live, with no gap or duplicate between replay and live.
   */
  readonly subscribe: (lastEventID?: string) => Effect.Effect<Stream.Stream<string, Error>, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/server/EventFeed") {}

/**
 * Wire form of an SSE id is `<instance>:<sequence>`. The instance is random per feed, so a restarted
 * process never matches an old cursor, and the sequence is monotonic within that instance.
 */
export function frame(event: OpenCodeEvent, id?: string) {
  return `${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`
}

type Retained = { readonly seq: number; readonly frame: string }

export const make = Effect.fn("EventFeed.make")(function* (
  observe: (subscriber: Bus.Subscriber) => Effect.Effect<Bus.Unsubscribe>,
  options?: {
    readonly capacity?: number
    readonly encode?: (event: OpenCodeEvent, id: string) => string
    readonly replayFrames?: number
    readonly replayBytes?: number
  },
) {
  const capacity = options?.capacity ?? SubscriberCapacity
  const render = options?.encode ?? frame
  const replayFrames = options?.replayFrames ?? ReplayCapacity
  const replayBytes = options?.replayBytes ?? ReplayBytes
  const instance = crypto.randomUUID()
  const subscribers = new Set<Queue.Queue<string, Error>>()
  // Contiguous by sequence: a cursor can be replayed only if no frame after it has been evicted.
  const retained: Retained[] = []
  let retainedBytes = 0
  let sequence = 0

  const idOf = (seq: number) => `${instance}:${seq}`

  const retain = (entry: Retained) => {
    // A frame too large to keep must drop the whole window; keeping its neighbours would hide the gap.
    if (entry.frame.length > replayBytes) {
      retained.splice(0)
      retainedBytes = 0
      return
    }
    retained.push(entry)
    retainedBytes += entry.frame.length
    while (retained.length > replayFrames || retainedBytes > replayBytes) {
      const evicted = retained.shift()
      if (evicted) retainedBytes -= evicted.frame.length
    }
  }

  const cursorOf = (lastEventID: string) => {
    if (!lastEventID.startsWith(`${instance}:`)) return undefined
    const digits = lastEventID.slice(instance.length + 1)
    if (!/^\d+$/.test(digits)) return undefined
    const cursor = Number(digits)
    return Number.isSafeInteger(cursor) ? cursor : undefined
  }

  // Undefined means the cursor cannot be honoured: foreign instance, malformed, from the future, or
  // evicted. The frame just before the window still counts, because nothing after it is missing.
  const replayAfter = (lastEventID: string) => {
    const cursor = cursorOf(lastEventID)
    const oldest = retained[0]?.seq ?? sequence + 1
    if (cursor === undefined || cursor < oldest - 1 || cursor > sequence) return undefined
    return retained.filter((entry) => entry.seq > cursor).map((entry) => entry.frame)
  }

  const resync = () => frame({ id: Event.ID.create(), type: "server.resync", data: {} } as const, idOf(sequence))

  const fail = (error: Error) =>
    Effect.sync(() => {
      const current = Array.from(subscribers)
      subscribers.clear()
      for (const subscriber of current) Queue.failCauseUnsafe(subscriber, Cause.fail(error))
    })

  // A lost event consumes its sequence and drops the retained window (#2271): a cursor from
  // before the failure can no longer be honoured, so a reconnect from one resyncs instead of
  // replaying across the gap as if nothing was lost. Runs whether or not anyone was subscribed.
  const invalidate = (lost: number) =>
    Effect.sync(() => {
      sequence = lost
      retained.splice(0)
      retainedBytes = 0
    })

  const publish = Effect.fnUntraced(function* (event: Event.Payload) {
    if (!isOpenCodeEvent(event)) return
    // Encoding happens with or without subscribers so the replay window stays current.
    const seq = sequence + 1
    const id = idOf(seq)
    const encoded = yield* Effect.try({
      try: () => render(event, id),
      catch: (cause) => new EncodingError({ eventID: event.id, eventType: event.type, cause }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("Failed to encode public event", {
          eventID: error.eventID,
          eventType: error.eventType,
          cause: error.cause,
        }).pipe(Effect.andThen(fail(error)), Effect.andThen(invalidate(seq)), Effect.as(undefined)),
      ),
    )
    if (encoded === undefined) return
    sequence = seq
    retain({ seq, frame: encoded })
    for (const subscriber of subscribers) {
      if (Queue.offerUnsafe(subscriber, encoded)) continue
      subscribers.delete(subscriber)
      Queue.failCauseUnsafe(subscriber, Cause.fail(new SubscriberOverflowError({ capacity })))
    }
  })

  const unsubscribe = yield* observe(publish)
  yield* Effect.addFinalizer(() => unsubscribe)

  return Service.of({
    subscribe: (lastEventID) =>
      Effect.acquireRelease(
        // Replay is taken and the subscriber registered in one synchronous step, so a publish either lands in
        // the replay or goes live, never both and never neither. A resuming subscriber gets room for a full replay
        // on top of its live lag capacity; a live-only subscriber keeps exactly the live capacity.
        Queue.dropping<string, Error>(lastEventID ? capacity + replayFrames + 1 : capacity).pipe(
          Effect.tap((queue) =>
            Effect.sync(() => {
              const replay = lastEventID ? (replayAfter(lastEventID) ?? [resync()]) : []
              for (const item of replay) Queue.offerUnsafe(queue, item)
              subscribers.add(queue)
            }),
          ),
        ),
        (queue) =>
          Effect.sync(() => subscribers.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid),
      ).pipe(Effect.map(Stream.fromQueue)),
  })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    return yield* make(bus.listen)
  }),
)
