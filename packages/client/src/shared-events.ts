export * as SharedEvents from "./shared-events.js"

export type SubscribeOptions = {
  readonly signal?: AbortSignal
  /** Reports transport activity on the shared stream, including keepalive frames that carry no event. */
  readonly onActivity?: () => void
  /** Resumes the shared stream after this SSE id when it opens. A subscriber joining an open stream does not change it. */
  readonly lastEventID?: string
  /** Reports the SSE id of each event as this subscriber takes it, so a cursor only advances on consumption. */
  readonly onEventId?: (id: string) => void
}

export type Resume = {
  readonly lastEventID?: string
  readonly onEventId: (id: string) => void
}

/**
 * Opt-in automatic reconnect for a shared stream (issue #2321). When a
 * connection attempt fails with an error `shouldRetry` accepts — or ends
 * unexpectedly with no error — the shared stream reopens after
 * `delay(attempt)` (attempt is 1-based and resets once an event is read),
 * resuming from the last event id the stream read. Subscribers are not
 * completed while a reconnect is pending or in flight; a terminal error
 * completes them exactly as an unretried failure does. When the last
 * subscriber leaves, any pending delay and transport work is cancelled.
 * Callers that pass no policy keep the fail-and-complete behaviour.
 */
export type ReconnectPolicy = {
  readonly shouldRetry: (error: unknown) => boolean
  readonly delay: (attempt: number) => number
}

export function make<A extends { readonly type: string }>(
  connect: (signal: AbortSignal, onActivity: () => void, resume: Resume) => AsyncIterable<A>,
  options?: { readonly reconnect?: ReconnectPolicy },
) {
  type Completion = { readonly error: unknown } | Record<string, never>
  type Delivery = { readonly value: A; readonly id?: string }
  type Subscriber = {
    push: (value: A, id?: string) => void
    finish: (completion: Completion) => void
    activity?: () => void
  }
  type Connection = {
    controller: AbortController
    subscribers: Set<Subscriber>
    connected?: A
    lastEventID?: string
    // Set by the transport just before it yields the event that the loop is about to read.
    eventID?: string
    // Consecutive failed attempts since the last event read; drives the reconnect delay.
    attempt: number
    // Set by stop(): the connection is torn down and must not reconnect or complete anyone again.
    stopped: boolean
    // Wakes a pending reconnect delay early (with `false`) when stop() cancels it.
    retryWake?: () => void
  }

  const reconnect = options?.reconnect
  let current: Connection | undefined
  const capacity = 4_096

  function stop(connection: Connection) {
    connection.stopped = true
    connection.retryWake?.()
    connection.connected = undefined
    connection.controller.abort()
    if (current === connection) current = undefined
  }

  function waitForRetry(connection: Connection, ms: number): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(!connection.stopped)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        connection.retryWake = undefined
        resolve(true)
      }, ms)
      connection.retryWake = () => {
        clearTimeout(timer)
        connection.retryWake = undefined
        resolve(false)
      }
    })
  }

  async function run(connection: Connection) {
    while (!connection.stopped) {
      let iterator: AsyncIterator<A> | undefined
      let completion: Completion = {}
      let failed = false
      try {
        if (connection.controller.signal.aborted) return
        iterator = connect(
          connection.controller.signal,
          () => {
            connection.subscribers.forEach((subscriber) => subscriber.activity?.())
          },
          {
            lastEventID: connection.lastEventID,
            onEventId: (id) => {
              connection.eventID = id
            },
          },
        )[Symbol.asyncIterator]()
        while (!connection.controller.signal.aborted) {
          connection.eventID = undefined
          const item = await iterator.next()
          if (item.done || connection.controller.signal.aborted) break
          if (item.value.type === "server.connected") connection.connected = item.value
          const id = connection.eventID
          if (id !== undefined) connection.lastEventID = id
          connection.attempt = 0
          connection.subscribers.forEach((subscriber) => subscriber.push(item.value, id))
        }
      } catch (error) {
        failed = true
        completion = { error }
      }
      // The attempt is over either way; aborting settles the transport's own cleanup.
      connection.controller.abort()
      try {
        await iterator?.return?.()
      } catch (error) {
        if (!failed) {
          failed = true
          completion = { error }
        }
      }
      if (connection.stopped) return
      // A clean end is an unexpected end for a long-lived subscription: it
      // reconnects under a policy just like a retryable failure. A terminal
      // failure (or no policy) completes every subscriber as before.
      const retryable =
        reconnect !== undefined &&
        connection.subscribers.size > 0 &&
        (!failed || reconnect.shouldRetry((completion as { readonly error: unknown }).error))
      if (!retryable) {
        stop(connection)
        connection.subscribers.forEach((subscriber) => subscriber.finish(completion))
        return
      }
      connection.attempt += 1
      connection.connected = undefined
      if (!(await waitForRetry(connection, reconnect.delay(connection.attempt)))) return
      if (connection.stopped) return
      connection.controller = new AbortController()
    }
  }

  return {
    subscribe(options?: SubscribeOptions): AsyncIterable<A> {
      return {
        [Symbol.asyncIterator]() {
          const pending: ReturnType<typeof Promise.withResolvers<IteratorResult<A>>>[] = []
          const queued: Delivery[] = []
          let started = false
          let completion: Completion | undefined
          let connection: Connection | undefined

          function finish(result: Completion, discard = true) {
            completion = result
            if (discard) queued.length = 0
            options?.signal?.removeEventListener("abort", abort)
            if (connection?.subscribers.delete(subscriber) && !connection.subscribers.size) stop(connection)
            pending.splice(0).forEach((request) => {
              if ("error" in result) request.reject(result.error)
              else request.resolve({ done: true, value: undefined })
            })
          }

          function abort() {
            finish({})
          }

          // The id is reported when the event is handed to the consumer, not when it is queued.
          function take(delivery: Delivery): IteratorResult<A> {
            if (delivery.id !== undefined) options?.onEventId?.(delivery.id)
            return { done: false, value: delivery.value }
          }

          const subscriber: Subscriber = {
            activity: options?.onActivity,
            finish(result) {
              finish(result, false)
            },
            push(value, id) {
              if (completion) return
              const request = pending.shift()
              if (request) {
                request.resolve(take({ value, id }))
                return
              }
              if (queued.length === capacity) {
                finish({ error: new Error(`Event subscriber exceeded its ${capacity}-event capacity`) })
                return
              }
              queued.push({ value, id })
            },
          }

          function start() {
            if (completion) return
            const fresh = !current
            connection = current ?? {
              controller: new AbortController(),
              subscribers: new Set<Subscriber>(),
              lastEventID: options?.lastEventID,
              attempt: 0,
              stopped: false,
            }
            current = connection
            connection.subscribers.add(subscriber)
            if (connection.connected) void subscriber.push(connection.connected)
            if (fresh) void run(connection)
          }

          return {
            next(): Promise<IteratorResult<A>> {
              const delivery = queued.shift()
              if (delivery) return Promise.resolve(take(delivery))
              if (completion) {
                if ("error" in completion) return Promise.reject(completion.error)
                return Promise.resolve({ done: true, value: undefined })
              }
              if (options?.signal?.aborted) {
                abort()
                return Promise.resolve({ done: true, value: undefined })
              }
              const request = Promise.withResolvers<IteratorResult<A>>()
              pending.push(request)
              if (!started) {
                started = true
                options?.signal?.addEventListener("abort", abort, { once: true })
                start()
              }
              return request.promise
            },
            return(): Promise<IteratorResult<A>> {
              finish({})
              return Promise.resolve({ done: true, value: undefined })
            },
          }
        },
      }
    },
  }
}
