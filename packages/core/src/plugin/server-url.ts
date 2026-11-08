export * as PluginServerUrl from "./server-url.js"

let current: string | undefined = undefined

/**
 * URL of the active server listener (for example `http://127.0.0.1:4096`).
 * The server process sets this after binding and clears it on shutdown, the
 * same shape v1 kept as `Server.url`. Plugins read it through
 * `Plugin.Context.serverUrl`; it stays undefined on hosts without a listener,
 * such as embedded SDK hosts.
 */
export function getServerUrl(): string | undefined {
  return current
}

export function setServerUrl(url: string | undefined): void {
  current = url
}
