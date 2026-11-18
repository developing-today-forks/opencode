import { serveWorker, Transfer, type Method } from "./worker-rpc"

// The worker end of `worker-rpc.test.ts`, run in a Bun worker.

/** The methods the test calls, each recording that it ran. */
export type FixtureMethods = {
  readonly echo: Method<string, string>
  /** Runs until the test releases it, so the calls it queues wait behind it. */
  readonly sleep: Method<undefined, undefined>
  /** Holds the worker for `input` milliseconds without yielding, so a cancel can only arrive after the reply left. */
  readonly spin: Method<number, ArrayBuffer>
  /** Runs until its caller aborts it. */
  readonly hold: Method<undefined, undefined>
  /** Runs until its caller aborts it, then finishes with a bitmap that no one takes. */
  readonly paint: Method<undefined, ImageBitmap>
  readonly log: Method<
    undefined,
    { readonly ran: readonly string[]; readonly aborted: readonly string[]; readonly closed: number }
  >
}

type Log = { ran: string[]; aborted: string[]; closed: number }

const log: Log = { ran: [], aborted: [], closed: 0 }

// Bun's workers have no ImageBitmap. This stand-in counts the bitmaps the server closes; it cannot be posted.
class StandInBitmap {
  close() {
    log.closed += 1
  }
}

Object.assign(globalThis, { ImageBitmap: StandInBitmap })

// The worker answers one call at a time, so `log` cannot be read while a call runs. The handlers that a test waits on
// announce their start instead.
const started = (method: string) => self.postMessage({ started: method })

// The test releases a held `sleep` with a message on the same port as its calls, so the release arrives after them.
// This listener is registered before serveWorker's and stops the message there: serveWorker would read it as a request.
const released = new Promise<void>((resolve) =>
  self.addEventListener("message", (event) => {
    if (!("release" in event.data)) return

    event.stopImmediatePropagation()
    resolve()
  }),
)

// Tells the test a handler is running, so it aborts a running call rather than one the worker has not loaded yet. The
// client ignores this message: it carries no call id.
const started = (method: string) => self.postMessage({ started: method })

serveWorker<FixtureMethods>({
  echo: (input) => {
    log.ran.push(`echo:${input}`)

    return input
  },
  sleep: async () => {
    log.ran.push("sleep")
    started("sleep")

    await released

    return undefined
  },
  spin: (input) => {
    log.ran.push("spin")
    started("spin")

    const until = performance.now() + input

    while (performance.now() < until) {
      // Busy: no message reaches the worker meanwhile.
    }

    const buffer = new ArrayBuffer(8)

    return new Transfer(buffer, [buffer])
  },
  hold: (_, signal) => {
    log.ran.push("hold")
    started("hold")

    const done = new Promise<undefined>((resolve) =>
      signal.addEventListener("abort", () => {
        log.aborted.push("hold")
        resolve(undefined)
      }),
    )

    started("hold")

    return done
  },
  paint: async (_, signal) => {
    log.ran.push("paint")
    started("paint")
<<<<<<< HEAD:packages/gui-extensions/src/microsoft-office/worker-rpc.fixture.ts

    await new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined)))
=======
    await sleep(input)
>>>>>>> upstream-anomalyco/dev:packages/gui-plugins/src/microsoft-office/worker-rpc.fixture.ts

    const bitmap = new ImageBitmap()

    return new Transfer(bitmap, [bitmap])
  },
  log: () => log,
})
