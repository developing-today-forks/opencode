import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import log from "electron-log/main.js"
import type { BrowserWindow } from "electron"
import { loadWindow } from "./scheme"

const failure = new Error("ERR_FAILED (-2) loading the renderer")

function createWindow(load: (url: string) => Promise<void>) {
  const calls: string[] = []

  // SAFETY: loadWindow touches only loadURL. The fake carries no webContents, so no recovery
  // listener can be wired to it — the same shape as the early window at load time.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see SAFETY above
  const win = {
    loadURL(url: string) {
      calls.push(url)

      return load(url)
    },
  } as unknown as BrowserWindow

  return { win, calls }
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("loadWindow", () => {
  const original = process.env.ELECTRON_RENDERER_URL

  beforeEach(() => {
    delete process.env.ELECTRON_RENDERER_URL
  })

  afterEach(() => {
    if (original === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = original
  })

  test("reports a rejected dev-server load instead of leaking an unhandled rejection", async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173"
    const errors = spyOn(log, "error")
    const unhandled: unknown[] = []

    const onUnhandled = (reason) => {
      unhandled.push(reason)
    }

    process.on("unhandledRejection", onUnhandled)

    try {
      const { win, calls } = createWindow(() => Promise.reject(failure))

      loadWindow(win, "index.html")
      await flush()

      expect(calls).toEqual(["http://localhost:5173/index.html"])
      expect(errors).toHaveBeenCalledTimes(1)
      expect(errors).toHaveBeenCalledWith("renderer load failed", {
        url: "http://localhost:5173/index.html",
        error: failure,
      })
      expect(unhandled).toEqual([])
    } finally {
      errors.mockRestore()
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("reports a rejected packaged-protocol load instead of leaking an unhandled rejection", async () => {
    const errors = spyOn(log, "error")
    const unhandled: unknown[] = []

    const onUnhandled = (reason) => {
      unhandled.push(reason)
    }

    process.on("unhandledRejection", onUnhandled)

    try {
      const { win, calls } = createWindow(() => Promise.reject(failure))

      loadWindow(win, "index.html")
      await flush()

      expect(calls).toEqual(["oc://renderer/index.html"])
      expect(errors).toHaveBeenCalledTimes(1)
      expect(errors).toHaveBeenCalledWith("renderer load failed", {
        url: "oc://renderer/index.html",
        error: failure,
      })
      expect(unhandled).toEqual([])
    } finally {
      errors.mockRestore()
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("handles the early-window load, where no recovery wiring exists yet", async () => {
    // createEarlyWindow calls loadWindow before wireWindowRecovery can be attached; the fake
    // window has nothing wired to it, so the log line is the only record of the failure.
    const errors = spyOn(log, "error")

    try {
      const { win, calls } = createWindow(() => Promise.reject(failure))

      loadWindow(win, "index.html")
      await flush()

      expect(calls).toEqual(["oc://renderer/index.html"])
      expect(errors).toHaveBeenCalledTimes(1)
      expect(errors).toHaveBeenCalledWith("renderer load failed", {
        url: "oc://renderer/index.html",
        error: failure,
      })
    } finally {
      errors.mockRestore()
    }
  })

  test("stays silent when the load succeeds", async () => {
    const errors = spyOn(log, "error")

    try {
      const { win, calls } = createWindow(() => Promise.resolve())

      loadWindow(win, "index.html")
      await flush()

      expect(calls).toEqual(["oc://renderer/index.html"])
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })
})
