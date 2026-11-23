import { contextBridge, ipcRenderer, webUtils } from "electron"
import {
  DragCancelEvent,
  IpcTransportPort,
  WindowBootstrapChannel,
  WindowSnapshotChannel,
  storageSnapshotNames,
  type WindowSnapshot,
} from "../shared/ipc-transport"
import { windowBootstrapFromArguments, type WindowBootstrap } from "../shared/window-bootstrap"
import { recoverWindowBootstrap } from "./recovery"

ipcRenderer.on(IpcTransportPort, (event) => {
  const port = event.ports[0]

  if (port) window.postMessage(IpcTransportPort, "*", [port])
})

ipcRenderer.on(DragCancelEvent, () => window.dispatchEvent(new Event(DragCancelEvent)))

// Asked before the page runs, so the stores the shell reads are hydrated on the first render. A
// window started without a bootstrap argument has no id to name its snapshot file with, so the
// snapshot stays empty and the renderer asks over IPC instead of the preload throwing here.
function expose(bootstrap: WindowBootstrap | undefined) {
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
}

const bootstrap = windowBootstrapFromArguments(process.argv)

if (bootstrap) {
  expose(bootstrap)
} else {
  // The argv carried no usable bootstrap: ask the main process for the calling window's own
  // bootstrap. A recovered bootstrap is exposed with its snapshot fetched under the recovered
  // id; an error or an unknown-sender refusal exposes the minimal bridge above instead.
  void recoverWindowBootstrap(() => ipcRenderer.invoke(WindowBootstrapChannel)).then(expose)
}
