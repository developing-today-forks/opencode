import { Context, Layer } from "effect"
import { networkInterfaces } from "node:os"
import type { ServerOptions } from "./options"

export class Service extends Context.Service<
  Service,
  {
    readonly urls: () => ReadonlyArray<string>
    readonly app: NonNullable<ServerOptions["app"]>
    readonly paths: { readonly tmp: string }
  }
>()("@opencode/server/ServerInfo") {}

export function layer(urls: () => ReadonlyArray<string>, tmp: string, app: ServerOptions["app"] = {}) {
  return Layer.succeed(Service, Service.of({ urls, app, paths: { tmp } }))
}

export function connectionURLs(
  value: string,
  requestedHostname?: string,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
) {
  const url = new URL(value)
  const hostname = requestedHostname ?? url.hostname
  const family = hostname === "0.0.0.0" ? "IPv4" : hostname === "::" || hostname === "[::]" ? "IPv6" : undefined
  if (family === undefined) return [value]

  const loopback = new URL(value)
  loopback.hostname = family === "IPv6" ? "[::1]" : "127.0.0.1"
  return [
    ...new Set([
      loopback.toString().replace(/\/$/, ""),
      ...Object.values(interfaces)
        .flatMap((entries) => entries ?? [])
        .filter(
          (entry) =>
            !entry.internal &&
            entry.family === family &&
            !(family === "IPv6" && /^fe[89ab][0-9a-f]:/i.test(entry.address)),
        )
        .map((entry) => {
          const result = new URL(value)
          result.hostname = family === "IPv6" ? `[${entry.address}]` : entry.address
          return result.toString().replace(/\/$/, "")
        }),
    ]),
  ]
}

export * as ServerInfo from "./server-info"
