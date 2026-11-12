# TODO

## Event stream: SSE ids and replay on reconnect

### Implemented

- **Wire ids.** Every public event frame carries `id: <instance>:<sequence>` (`packages/server/src/event-feed.ts`,
  `frame` and `idOf`). `instance` is a random UUID created once per `EventFeed`, so once per process.
  `sequence` starts at 1 and rises by one for each public event published. The `evt_…` id inside the JSON
  payload is a different identifier and is not the SSE id.
- **Frames without ids.** `server.connected` and heartbeat comments carry no id, so they never move a cursor.
  Events that are not public (`isOpenCodeEvent` is false) are neither framed nor sequenced.
- **Replay ring.** The feed keeps the last 1,024 encoded frames (`ReplayCapacity`) and at most about 4 MiB
  (`ReplayBytes`, counted in UTF-16 code units). Frames are encoded and retained even with no subscribers, so
  the ring is current when a client returns. A single frame larger than the byte bound empties the ring, so
  no cursor older than it can replay.
- **Resume.** A request with `Last-Event-ID` receives the retained frames after its cursor, then live frames.
  The replay snapshot and the subscriber registration happen in one synchronous step, so no event is
  duplicated or skipped between them. A cursor is honoured only if it names this instance, its sequence is a
  number no greater than the head, and it is not older than the window. The frame just before the oldest
  retained frame still counts, since nothing after it is missing.
- **`server.resync`.** When a cursor cannot be honoured (another instance, malformed, from the future, or
  evicted) the stream sends exactly one `server.resync` frame whose id is the head id, then live frames.
  Clients refetch their state on it, as they do for `server.connected`.
- **Lag.** A live subscriber whose queue fills (4,096 frames) fails with `EventFeed.SubscriberOverflow`. A
  resuming subscriber gets room for its replay on top of that.
- **Encoding failure.** If one public event cannot be encoded, every current subscriber fails and the sequence
  does not advance (unchanged behaviour).

### Client cursor rules

- The cursor advances only when an event is handed to a consumer, never when it is queued. The solid
  connection loop (`packages/client/src/solid/connection.ts`) moves its cursor after publishing; `SharedEvents`
  (`packages/client/src/shared-events.ts`) reports the id when it hands an event to a subscriber; the Promise
  client reports the id just before yielding the event.
- `server.connected` does not move the cursor. `server.resync` does, because its id is the head.
- On reconnect the solid connection loop and the Promise client send the cursor as `Last-Event-ID`. The Effect
  client (`packages/client/src/effect/client.ts`) keeps the cursor on the client and resumes from it on every
  `subscribe()`. It has no reconnect loop of its own, so a consumer that wants to resume calls `subscribe()`
  again.
- The Effect client reads the SSE frames itself. The generated Effect event type has no `id`, so the generated
  stream could not report one.

### Protocol

`event.subscribe` declares the `last-event-id` header, and `server.resync` is a member of `OpenCodeEvent`. The
description in `packages/protocol/src/groups/event.ts` and `packages/protocol/openapi.json` states the cursor rules.
The generated Promise client was regenerated.

### Remaining limits

- **Per process.** The ring belongs to one `EventFeed`. A different server process, a restart, or a workerd
  isolate restart has another instance, so a reconnect there gets `server.resync`. Ids order events only within
  one instance, so do not compare them across processes.
- **Memory.** An idle server keeps up to about 4 MiB of frames.
- **Durable replay is not implemented.** Durable events could also be read from `Bus.log({ aggregateID, after })`
  (`packages/core/src/bus.ts`) once the ring has evicted them. That needs the bus configured with `persist`, which retains durable payloads for log reads. Volatile events such
  as deltas are never persisted, so for them only the ring can replay.
- **Effect reconnect is automatic** for transient failures and unexpected stream ends (bounded backoff, resuming from the last consumed id, #2321); terminal protocol/decode and non-retryable HTTP errors still end the subscription. See the cursor rules above.

### Tests

- `packages/server/test/event-feed.test.ts`: frame ids, ring bounds (frames and bytes), eviction boundaries,
  foreign, malformed, and future cursors, and replay followed by live events.
- `packages/server/test/event-resume.test.ts`: a real server with a real client. Covers replay of exactly the
  missed events, one `server.resync` after a restart, and one `server.resync` at the head id after more than
  `ReplayCapacity` frames, followed by live events.
- `packages/client/test/effect.test.ts`: the cursor is recorded from SSE ids, sent by the next `subscribe()`,
  and not advanced past an event that was never taken.
- `packages/client/test/promise.test.ts`, `shared-events.test.ts`, and `solid-connection.test.ts`: the cursor is
  sent as `Last-Event-ID` on reconnect, and ids are reported when an event is consumed.
