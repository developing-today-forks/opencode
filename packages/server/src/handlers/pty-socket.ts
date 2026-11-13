import { Deferred, Effect, Queue } from "effect"
import { Socket } from "effect/socket"

export type Outbound = string | Uint8Array | Socket.CloseEvent

// Live per-connection output buffering is bounded by retained bytes, not by the writer's pace.
// A PTY producer is synchronous (the onData callback) and cannot be backpressured, so the bound is
// enforced at offer time: once the queued bytes would exceed PTY_OUTBOX_MAX_BYTES the connection is
// overflowed — the offer is dropped, a deterministic close frame (1013, "try again later") is queued
// behind the retained output, and every later offer is dropped. The drain then delivers what was
// retained, writes the close frame, and runPtySocket's ensuring detaches the connection. The PTY
// process and every other subscriber keep their own outbox and are unaffected.
// The bound is 4x the 2 MiB replay retention cap in @opencode/core/pty, so a full replay plus its
// meta frame and a live burst always fit: clients that keep up never see the bound.
export const PTY_OUTBOX_MAX_BYTES = 8 * 1024 * 1024
export const PTY_OUTBOX_OVERFLOW_CLOSE_CODE = 1013
// After an overflow the close frame only detaches the connection if the drain can deliver it. A
// writer stalled past this deadline may never accept it, so runPtySocket also races the overflow
// signal against this deadline and detaches without delivery when it expires. The deadline starts
// at overflow, never before: connections that never overflow are never cut off by it.
export const PTY_OUTBOX_OVERFLOW_DETACH_AFTER_MS = 30_000
export const PTY_OUTBOX_OVERFLOW_REASON = "pty output overflow: client too slow"

const encoder = new TextEncoder()

// Retained size of one outbound frame. Close frames are control, not output, and count as zero.
export const outboundBytes = (chunk: Outbound): number =>
  chunk instanceof Socket.CloseEvent ? 0 : typeof chunk === "string" ? encoder.encode(chunk).length : chunk.byteLength

export interface PtyOutbox {
  // The dequeue side handed to runPtySocket.
  readonly queue: Queue.Dequeue<Outbound>
  // Synchronous offer for producers that cannot suspend (PTY onData callbacks). Returns false once
  // the connection has overflowed (the chunk was dropped); close frames always queue unless the
  // connection already overflowed, in which case the overflow close is already queued.
  readonly offer: (chunk: Outbound) => boolean
  // Called by the drain (runPtySocket's onDequeued) for each frame it takes, releasing its bytes.
  readonly release: (chunk: Outbound) => void
  readonly queuedBytes: () => number
  readonly overflowed: () => boolean
  // Completes the first time the outbox overflows; never completes otherwise.
  readonly whenOverflowed: Effect.Effect<void>
}

export const makePtyOutbox = (maxBytes: number = PTY_OUTBOX_MAX_BYTES) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Outbound>()
    const overflowSignal = yield* Deferred.make<void>()
    let retained = 0
    let overflow = false
    const offer = (chunk: Outbound): boolean => {
      if (overflow) return false
      if (chunk instanceof Socket.CloseEvent) {
        Queue.offerUnsafe(queue, chunk)
        return true
      }
      const bytes = outboundBytes(chunk)
      if (retained + bytes > maxBytes) {
        overflow = true
        Effect.runSync(Deferred.succeed(overflowSignal, undefined))
        Queue.offerUnsafe(queue, new Socket.CloseEvent(PTY_OUTBOX_OVERFLOW_CLOSE_CODE, PTY_OUTBOX_OVERFLOW_REASON))
        return false
      }
      retained += bytes
      Queue.offerUnsafe(queue, chunk)
      return true
    }
    const release = (chunk: Outbound) => {
      retained = Math.max(0, retained - outboundBytes(chunk))
    }
    const outbox: PtyOutbox = {
      queue,
      offer,
      release,
      queuedBytes: () => retained,
      overflowed: () => overflow,
      whenOverflowed: Deferred.await(overflowSignal),
    }
    return outbox
  })

// Outbound frames flow through one queue drained by a single writer so replay, live output, and the close
// frame keep their order. Either side closing ends the connection normally, and every exit detaches.
export function runPtySocket<R>(input: {
  readonly socket: Socket.Socket
  readonly outbox: Queue.Dequeue<Outbound>
  readonly onOpen?: Effect.Effect<void, never, R>
  readonly onMessage: (message: string | Uint8Array) => Effect.Effect<void, never, R>
  readonly detach: () => void
  readonly onDequeued?: (chunk: Outbound) => void
  // Completes when the connection's outbox has overflowed (see makePtyOutbox). Once it completes,
  // the connection is detached within overflowDetachAfterMs even if the drain is still blocked
  // delivering the retained output and the overflow close frame.
  readonly onOverflow?: Effect.Effect<void>
  readonly overflowDetachAfterMs?: number
}) {
  const drain = Effect.gen(function* () {
    const writer = yield* input.socket.writer
    while (true) {
      const item = yield* Queue.take(input.outbox)
      if (input.onDequeued) input.onDequeued(item)
      yield* writer.write(item)
      if (item instanceof Socket.CloseEvent) return
    }
  })
  const read = Effect.gen(function* () {
    const reader = yield* input.socket.reader
    if (input.onOpen) yield* input.onOpen
    while (true) yield* Effect.forEach(yield* reader.pull, input.onMessage, { discard: true })
  })
  const main = Effect.raceFirst(drain, read)
  const bounded = input.onOverflow
    ? Effect.raceFirst(
        main,
        input.onOverflow.pipe(
          Effect.andThen(Effect.sleep(`${input.overflowDetachAfterMs ?? PTY_OUTBOX_OVERFLOW_DETACH_AFTER_MS} millis`)),
        ),
      )
    : main
  return bounded.pipe(
    Effect.ensuring(Effect.sync(input.detach)),
    Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
    Effect.orDie,
  )
}
