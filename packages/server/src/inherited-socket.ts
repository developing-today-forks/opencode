import type { Server as HttpServer } from "node:http"
import { createServer, type ListenOptions } from "node:net"

// Bun 1.4 ignores `listen({ fd })` on node:http and binds a port of its own, but node:net adopts the inherited
// socket. This lets an http server take its listener from a net server that adopted fd: each accepted connection
// is handed to the http server, which parses it as it would for its own listener. The overrides below are the
// methods the effect NodeHttpServer and the drain path call on the server; the rest of the http server is unchanged.
export function adoptInheritedSocket(server: HttpServer, fd: number): HttpServer {
  const listener = createServer((socket) => server.emit("connection", socket))
  listener.on("error", (error) => server.emit("error", error))
  Object.defineProperty(server, "listening", { get: () => listener.listening, configurable: true })
  return Object.assign(server, {
    // The socket is already bound and listening; the address the caller passed is the one the supervisor holds.
    listen: (_options: ListenOptions, callback?: () => void) => {
      listener.listen({ fd } as ListenOptions, callback)
      return server
    },
    address: () => listener.address(),
    // Stop accepting here; the supervisor keeps its descriptor, so connections queue for the successor.
    // Do not close idle connections here: a connection accepted just before the drain may not have sent
    // its request yet, and the drain serves accepted connections for a short linger before closing them.
    close: (callback?: (error?: Error) => void) => {
      listener.close(callback)
      return server
    },
  })
}
