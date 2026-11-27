import { Effect } from "effect";
export const makeWebSocketServer = (options = {}) => Effect.acquireRelease(Effect.sync(() => {
    const state = { headers: [], messages: [], opens: 0, closes: 0, pongs: 0 };
    let connection = 0;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request, server) {
            state.headers.push(Object.fromEntries(request.headers.entries()));
            if (request.headers.get("upgrade") !== "websocket" && options.http)
                return options.http(request);
            if ((options.upgrade?.(request) ?? true) && server.upgrade(request, { data: { id: connection++ } }))
                return undefined;
            return new Response("WebSocket upgrade required", {
                status: 426,
                headers: { "x-upgrade-rejected": "true" },
            });
        },
        websocket: {
            open(socket) {
                state.opens++;
                options.open?.(socket);
            },
            message(socket, message) {
                const text = typeof message === "string" ? message : message.toString();
                state.messages.push(text);
                options.message?.(socket, message);
            },
            close() {
                state.closes++;
            },
            pong() {
                state.pongs++;
            },
        },
    });
    return {
        server,
        fixture: {
            url: `${server.url.toString().replace(/^http/, "ws")}responses`,
            state,
        },
    };
}), ({ server }) => Effect.promise(() => server.stop(true))).pipe(Effect.map((item) => item.fixture));
