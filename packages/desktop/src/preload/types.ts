import type { StorageSnapshot, WindowSnapshot } from "../shared/ipc-transport"
import type { WindowBootstrap } from "../shared/window-bootstrap"

export type ElectronNative = {
  // Undefined when the window was started without a bootstrap argument; the renderer asks over IPC.
  windowID: string | undefined
  bootstrap: WindowBootstrap | undefined
  storageSnapshot: Promise<StorageSnapshot>
  plugins: Promise<WindowSnapshot["plugins"]>
  getPathForFile(file: File): string
}
