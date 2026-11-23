import { contextBridge, ipcRenderer, webUtils } from "electron"
import {
  DragCancelEvent,
  IpcTransportPort,
  WindowSnapshotChannel,
  storageSnapshotNames,
  type WindowSnapshot,
} from "../shared/ipc-transport"
import { windowBootstrapFromArguments } from "../shared/window-bootstrap"

ipcRenderer.on(IpcTransportPort, (event) => {
  const port = event.ports[0]

  if (port) window.postMessage(IpcTransportPort, "*", [port])
})

ipcRenderer.on(DragCancelEvent, () => window.dispatchEvent(new Event(DragCancelEvent)))

const bootstrap = windowBootstrapFromArguments(process.argv)

// Asked before the page runs, so the stores the shell reads are hydrated on the first render. A
// window started without a bootstrap argument has no id to name its snapshot file with, so the
// snapshot stays empty and the renderer asks over IPC instead of the preload throwing here.
const snapshot: Promise<WindowSnapshot> = bootstrap
  ? ipcRenderer.invoke(WindowSnapshotChannel, storageSnapshotNames(bootstrap.id)).catch(() => ({ storage: {} }))
  : Promise.resolve({ storage: {} })

contextBridge.exposeInMainWorld("electron", {
  windowID: bootstrap?.id,
  bootstrap,
  storageSnapshot: snapshot.then((snapshot) => snapshot.storage),
  plugins: snapshot.then((snapshot) => snapshot.plugins),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
})
