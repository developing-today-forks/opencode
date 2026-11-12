import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Queue } from "effect"
import { Socket } from "effect/socket"
import { it } from "../../core/test/lib/effect"
import { makePtyOutbox, PTY_OUTBOX_OVERFLOW_CLOSE_CODE, type Outbound, runPtySocket } from "../src/handlers/pty-socket"

const connection = Effect.gen(function* () {
  const inbound = yield* Queue.unbounded<string | Uint8Array, Socket.SocketError>()
  const outbox = yield* Queue.unbounded<Outbound>()
  const state = {
    opened: false,
    detached: false,
    received: [] as Array<string | Uint8Array>,
    written: [] as Outbound[],
  }
  const socket = Socket.make({
    reader: Effect.succeed({
      pull: Queue.take(inbound).pipe(Effect.map((message) => [message] as const)),
      upgrade: Socket.SocketUpgradeError.unsupported,
    }),
    writer: Effect.succeed({
      write: (chunk) => Effect.sync(() => void state.written.push(chunk)),
      writeAll: (chunks) => Effect.sync(() => void state.written.push(...chunks)),
    }),
  })
  const run = runPtySocket({
    socket,
    outbox,
    onOpen: Effect.sync(() => {
      state.opened = true
    }),
    onMessage: (message) =>
      Effect.sync(() => {
        expect(state.opened).toBeTrue()
        state.received.push(message)
      }),
    detach: () => {
      state.detached = true
    },
  })
  return { inbound, outbox, state, run }
})

const fail = (reason: Socket.SocketError["reason"]) => new Socket.SocketError({ reason })

it.live("delivers input in order and detaches when the client closes", () =>
  Effect.gen(function* () {
    const pty = yield* connection
    yield* Queue.offerAll(pty.inbound, ["a", "b"])
    yield* Queue.fail(pty.inbound, fail(new Socket.SocketCloseError({ code: 1000 })))

    expect(yield* Effect.exit(pty.run)).toEqual(Exit.void)
    expect(pty.state.received).toEqual(["a", "b"])
    expect(pty.state.detached).toBeTrue()
  }),
)

it.live("writes queued output through the close frame and detaches", () =>
  Effect.gen(function* () {
    const pty = yield* connection
    const close = new Socket.CloseEvent(1000)
    yield* Queue.offerAll(pty.outbox, ["output", close, "after close"])

    expect(yield* Effect.exit(pty.run)).toEqual(Exit.void)
    expect(pty.state.written).toEqual(["output", close])
    expect(pty.state.detached).toBeTrue()
  }),
)

it.live("detaches when the socket fails while the outbox drain is blocked", () =>
  Effect.gen(function* () {
    const pty = yield* connection
    yield* Queue.fail(pty.inbound, fail(new Socket.SocketReadError({ cause: new Error("reset") })))

    expect(Exit.hasDies(yield* Effect.exit(pty.run))).toBeTrue()
    expect(pty.state.detached).toBeTrue()
  }),
)

it.live("detaches when interrupted", () =>
  Effect.gen(function* () {
    const pty = yield* connection
    const fiber = yield* Effect.forkChild(pty.run, { startImmediately: true })
    yield* Fiber.interrupt(fiber)

    expect(pty.state.opened).toBeTrue()
    expect(pty.state.detached).toBeTrue()
  }),
)

it.live("bounded outbox retains at most the byte bound, then queues an overflow close", () =>
  Effect.gen(function* () {
    const outbox = yield* makePtyOutbox(10)
    expect(outbox.offer("12345")).toBeTrue()
    expect(outbox.offer("12345")).toBeTrue()
    expect(outbox.queuedBytes()).toBe(10)
    expect(outbox.offer("x")).toBeFalse()
    expect(outbox.overflowed()).toBeTrue()
    expect(outbox.offer("more")).toBeFalse()
    expect(outbox.queuedBytes()).toBe(10)

    const first = yield* Queue.take(outbox.queue)
    outbox.release(first)
    const second = yield* Queue.take(outbox.queue)
    outbox.release(second)
    expect([first, second]).toEqual(["12345", "12345"])
    const close = yield* Queue.take(outbox.queue)
    expect(close).toBeInstanceOf(Socket.CloseEvent)
    expect((close as Socket.CloseEvent).code).toBe(PTY_OUTBOX_OVERFLOW_CLOSE_CODE)
    expect(outbox.queuedBytes()).toBe(0)
  }),
)

it.live("a single frame larger than the bound overflows immediately without being retained", () =>
  Effect.gen(function* () {
    const outbox = yield* makePtyOutbox(4)
    expect(outbox.offer("12345")).toBeFalse()
    expect(outbox.overflowed()).toBeTrue()
    expect(outbox.queuedBytes()).toBe(0)
    const close = yield* Queue.take(outbox.queue)
    expect(close).toBeInstanceOf(Socket.CloseEvent)
    expect((close as Socket.CloseEvent).code).toBe(PTY_OUTBOX_OVERFLOW_CLOSE_CODE)
  }),
)

it.live("stalled writer: retention stays bounded, overflow closes and detaches, other outboxes unaffected", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const inbound = yield* Queue.unbounded<string | Uint8Array, Socket.SocketError>()
    const outbox = yield* makePtyOutbox(16)
    const state = { detached: false, written: [] as Outbound[] }
    const socket = Socket.make({
      reader: Effect.succeed({
        pull: Queue.take(inbound).pipe(Effect.map((message) => [message] as const)),
        upgrade: Socket.SocketUpgradeError.unsupported,
      }),
      writer: Effect.succeed({
        write: (chunk) =>
          Effect.gen(function* () {
            yield* Deferred.await(gate)
            state.written.push(chunk)
          }),
        writeAll: () => Effect.die(new Error("runPtySocket writes frames one at a time")),
      }),
    })
    const fiber = yield* Effect.forkChild(
      runPtySocket({
        socket,
        outbox: outbox.queue,
        onDequeued: outbox.release,
        onMessage: () => Effect.void,
        detach: () => {
          state.detached = true
        },
      }),
      { startImmediately: true },
    )

    // The drain takes the first frame and blocks in the stalled writer.
    expect(outbox.offer("aaaa")).toBeTrue()
    yield* Effect.sleep("50 millis")
    // Four more frames fill the bound exactly while the writer is stalled.
    for (const chunk of ["bbbb", "cccc", "dddd", "eeee"]) expect(outbox.offer(chunk)).toBeTrue()
    expect(outbox.queuedBytes()).toBe(16)
    // The next frame overflows: dropped, not retained, and a close is queued behind the retained output.
    expect(outbox.offer("ffff")).toBeFalse()
    expect(outbox.offer("gggg")).toBeFalse()
    expect(outbox.queuedBytes()).toBe(16)

    yield* Deferred.succeed(gate, undefined)
    expect(yield* Fiber.await(fiber)).toEqual(Exit.void)
    expect(state.written.slice(0, 5)).toEqual(["aaaa", "bbbb", "cccc", "dddd", "eeee"])
    const close = state.written[5]
    expect(close).toBeInstanceOf(Socket.CloseEvent)
    expect((close as Socket.CloseEvent).code).toBe(PTY_OUTBOX_OVERFLOW_CLOSE_CODE)
    expect(state.detached).toBeTrue()

    // Overflow is per-connection: an independent outbox for another subscriber still delivers.
    const other = yield* makePtyOutbox(16)
    expect(other.offer("ok")).toBeTrue()
    expect(other.overflowed()).toBeFalse()
  }),
)
