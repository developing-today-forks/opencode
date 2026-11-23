import electron, { type BrowserWindow } from "electron"
import { WindowBootstrapChannel } from "../../shared/ipc-transport"
import type { WindowBootstrap } from "../../shared/window-bootstrap"
import { isRendererUrl } from "./scheme"

// Answers the bootstrap for the calling webContents, so a window whose preload started with a
// missing or malformed `--opencode-window=` argument recovers its real window id instead of
// staying in the degraded minimal-bridge mode.
//
// This module stays light on purpose: it is imported by the entry module and registered before
// the first window is created, while the window registry lives in `./index`, which loads with
// the layers after the early window. The registry side therefore hands its lookup over through
// `setWindowBootstrapResolver` when it loads, and the early window — created before that —
// records its own bootstrap through `noteEarlyWindowBootstrap`. Until either happens, the
// handler answers undefined and the renderer keeps the degraded mode.
type Resolver = (win: BrowserWindow) => WindowBootstrap | undefined

let resolver: Resolver = () => undefined

const early = new WeakMap<BrowserWindow, WindowBootstrap>()

export function setWindowBootstrapResolver(next: Resolver) {
  resolver = next
}

export function noteEarlyWindowBootstrap(win: BrowserWindow, bootstrap: WindowBootstrap) {
  early.set(win, bootstrap)
}

/** The bootstrap for a window, or undefined when the window is unknown or already gone. */
export function answerWindowBootstrap(win: BrowserWindow | null | undefined): WindowBootstrap | undefined {
  if (!win || win.isDestroyed()) return undefined

  return early.get(win) ?? resolver(win)
}

export function registerWindowBootstrapHandler() {
  electron.ipcMain.handle(WindowBootstrapChannel, (event): WindowBootstrap | undefined => {
    if (!isRendererUrl(event.senderFrame?.url)) return undefined

    return answerWindowBootstrap(electron.BrowserWindow.fromWebContents(event.sender))
  })
}
