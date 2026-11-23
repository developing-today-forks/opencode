import { describe, expect, test } from "bun:test"
import type { BrowserWindow } from "electron"
import type { WindowBootstrap } from "../../shared/window-bootstrap"
import { answerWindowBootstrap, noteEarlyWindowBootstrap, setWindowBootstrapResolver } from "./bootstrap-channel"

// SAFETY: answerWindowBootstrap touches only isDestroyed() on the window; the fakes provide
// exactly that surface.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see SAFETY above
const fakeWindow = (destroyed = false) => ({ isDestroyed: () => destroyed }) as unknown as BrowserWindow

const bootstrap: WindowBootstrap = { id: "win-1", firstLaunchPending: false, packaged: true }

describe("window bootstrap channel", () => {
  test("answers the registered window's bootstrap (recovery happy path)", () => {
    const win = fakeWindow()
    setWindowBootstrapResolver((candidate) => (candidate === win ? bootstrap : undefined))

    expect(answerWindowBootstrap(win)).toEqual(bootstrap)
  })

  test("refuses an unknown sender: unregistered windows answer undefined", () => {
    setWindowBootstrapResolver(() => undefined)

    expect(answerWindowBootstrap(fakeWindow())).toBeUndefined()
  })

  test("refuses a destroyed window even when it was registered", () => {
    setWindowBootstrapResolver(() => bootstrap)

    expect(answerWindowBootstrap(fakeWindow(true))).toBeUndefined()
    expect(answerWindowBootstrap(null)).toBeUndefined()
    expect(answerWindowBootstrap(undefined)).toBeUndefined()
  })

  test("answers the early window from its noted bootstrap before the registry loads", () => {
    const win = fakeWindow()
    setWindowBootstrapResolver(() => undefined)
    noteEarlyWindowBootstrap(win, bootstrap)

    expect(answerWindowBootstrap(win)).toEqual(bootstrap)
    // The note is per-window: another window still falls through to the resolver.
    expect(answerWindowBootstrap(fakeWindow())).toBeUndefined()
  })
})
