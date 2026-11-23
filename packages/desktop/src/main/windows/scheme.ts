import electron, { type BrowserWindow } from "electron"
import log from "electron-log/main.js"
import { schemes } from "@opencode/gui-plugins/schemes"

export const rendererProtocol = "oc"

export const rendererHost = "renderer"

export function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = process.env.ELECTRON_RENDERER_URL

  const url = devUrl ? new URL(html, devUrl).toString() : `${rendererProtocol}://${rendererHost}/${html}`

  // The desktop main process has no unhandledRejection handler, so a rejected loadURL promise
  // would terminate it under the runtime default. Handle the rejection here, at the one boundary
  // every window passes through: windows with recovery wired still get their did-fail-load
  // recovery UX, and for the early window — loaded before any recovery wiring exists — this log
  // line is the only record of the failure.
  win.loadURL(url).catch((error) => {
    log.error("renderer load failed", { url, error })
  })
}

export function isRendererUrl(value?: string, html = false) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)

  if (html && !url.pathname.endsWith(".html")) return false

  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
  const devUrl = process.env.ELECTRON_RENDERER_URL

  if (!devUrl || !URL.canParse(devUrl)) return false

  return url.origin === new URL(devUrl).origin
}

// Scheme privileges can only be granted before the app is ready, so the entry module calls this
// before it loads anything else.
export function registerRendererScheme() {
  electron.protocol.registerSchemesAsPrivileged([
    ...schemes,
    {
      scheme: rendererProtocol,
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        // Plugin fonts and fetched assets are cross-origin to the renderer.
        corsEnabled: true,
        stream: true,
        // Let Chromium keep V8 bytecode for the renderer bundle between launches.
        codeCache: true,
      },
    },
  ])
}
