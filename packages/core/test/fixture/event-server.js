import { InMemoryTransport } from "@modelcontextprotocol/client";
import { Effect, Queue } from "effect";
/** A raw 2026-07-28 MCP Events producer. Queues let tests wait for the actual JSON-RPC request and cancellation. */
export const eventProducer = Effect.fnUntraced(function* (types) {
    const [client, server] = InMemoryTransport.createLinkedPair();
    const methods = [];
    const state = {
        streams: [],
        cancelled: [],
    };
    const opened = yield* Queue.unbounded();
    const cancelled = yield* Queue.unbounded();
    const reply = (id, result) => server.send({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
    server.onmessage = (message) => {
        if (!("method" in message))
            return;
        methods.push(message.method);
        // Every 2026-07-28 request carries the protocol envelope in `_meta`; the tests check the rest.
        const { _meta: _envelope, ...params } = message.params ?? {};
        if (message.method === "notifications/cancelled") {
            state.cancelled.push(params.requestId);
            Queue.offerUnsafe(cancelled, params.requestId);
        }
        if (!("id" in message))
            return;
        if (message.method === "server/discover")
            void reply(message.id, {
                _meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1.0.0" } },
                supportedVersions: ["2026-07-28"],
                capabilities: { extensions: { "io.modelcontextprotocol/events": {} } },
            });
        if (message.method === "events/list")
            void reply(message.id, { events: types });
        if (message.method === "events/stream") {
            const stream = { id: message.id, params };
            state.streams.push(stream);
            Queue.offerUnsafe(opened, stream);
        }
    };
    yield* Effect.promise(() => server.start());
    return {
        client,
        methods,
        state,
        opened: Queue.take(opened),
        cancelled: Queue.take(cancelled),
        close: (id) => Effect.promise(() => reply(id, {})),
        notify: (type, id, params = {}) => Effect.promise(() => server.send({
            jsonrpc: "2.0",
            method: `notifications/events/${type}`,
            params: {
                ...params,
                _meta: { "io.modelcontextprotocol/subscriptionId": id },
            },
        })),
    };
});
