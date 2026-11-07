import net from "node:net"
import { connectWs } from "./packages/ai/src/quota/cdp.ts"

// TCP server that accepts the connection but never speaks: the WS
// handshake can neither complete nor fail.
const server = net.createServer((socket) => { socket.on("error", () => {}) })
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
const port = (server.address() as net.AddressInfo).port
const url = `ws://127.0.0.1:${port}/devtools/page/page-1`
let settled = ""
const started = Date.now()
const p = connectWs(url, 150).then(() => { settled = "resolved" }, (e) => { settled = "rejected: " + String(e) })
await new Promise((r) => setTimeout(r, 3000))
console.log(`after 3000ms (requestTimeoutMs=150): settled=${settled || "PENDING"}`)
server.close()
process.exit(0)
