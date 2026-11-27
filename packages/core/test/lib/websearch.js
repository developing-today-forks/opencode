import * as TestWebSearch_1 from "./websearch";
export { TestWebSearch_1 as TestWebSearch };
import { Context, Deferred, Effect, Layer } from "effect";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { Bus } from "@opencode/core/bus";
import { KV } from "@opencode/core/kv";
import { WebSearch } from "@opencode/core/websearch";
export class Service extends Context.Service()("test/WebSearch") {
}
export function httpError(status = 429, retryAfter, url = "https://search.example.com") {
    const request = HttpClientRequest.post(url);
    return new HttpClientError.HttpClientError({
        reason: new HttpClientError.StatusCodeError({
            request,
            response: HttpClientResponse.fromWeb(request, new Response(null, { status, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } })),
        }),
    });
}
// No providers are installed: tests register local executors through transform.
// The normal Bus and KV implementations use the default in-memory database.
export const layer = Layer.effectContext(Effect.gen(function* () {
    const context = yield* Layer.build(AppNodeBuilder.build(LayerNode.group([WebSearch.node, Bus.node, KV.node])));
    const websearch = Context.get(context, WebSearch.Service);
    const queries = [];
    const sessionIDs = [];
    let started = yield* Deferred.make();
    const wait = (count) => Effect.suspend(() => queries.length >= count ? Effect.void : Deferred.await(started).pipe(Effect.andThen(() => wait(count))));
    const test = Service.of({
        ...websearch,
        queries,
        sessionIDs,
        wait,
        query: Effect.fnUntraced(function* (input, options) {
            queries.push({ ...input });
            sessionIDs.push(options?.sessionID);
            const previous = started;
            started = yield* Deferred.make();
            yield* Deferred.succeed(previous, undefined);
            return yield* websearch.query(input, options);
        }),
    });
    return Context.add(context, WebSearch.Service, test).pipe(Context.add(Service, test));
}));
