import { test } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { FetchHttpClient } from "effect/http";
const body = (value) => Effect.suspend(() => (typeof value === "function" ? value() : value));
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Core is env-free, so nothing tells the default node graph to stay offline;
// a test that boots it would phone home through FetchHttpClient. The default
// client node captures this reference when the test builds its layer, so
// refusing here covers each node that shares the default client, while an
// explicit HttpClient or fetch replacement never reaches it. Callers such as ModelsDev swallow request
// failures, so the harness also records the attempt and fails the test itself.
export const refuseNetwork = (violations) => Object.assign((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (loopback.has(new URL(url).hostname))
        return fetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const message = `test attempted network request: ${method} ${url} — provide an explicit HttpClient or disable the fetch`;
    violations.push(message);
    return Promise.reject(new Error(message));
}, { preconnect: fetch.preconnect });
const run = (value, layer) => Effect.gen(function* () {
    const violations = [];
    const exit = yield* body(value).pipe(Effect.scoped, Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, refuseNetwork(violations)), Effect.exit);
    if (Exit.isFailure(exit)) {
        for (const err of Cause.prettyErrors(exit.cause)) {
            yield* Effect.logError(err);
        }
    }
    if (violations.length > 0)
        return yield* Effect.fail(new Error(violations.join("\n")));
    return yield* exit;
}).pipe(Effect.runPromise);
const make = (testLayer, liveLayer) => {
    const effect = (name, value, opts) => test(name, () => run(value, testLayer), opts);
    effect.only = (name, value, opts) => test.only(name, () => run(value, testLayer), opts);
    effect.skip = (name, value, opts) => test.skip(name, () => run(value, testLayer), opts);
    const live = (name, value, opts) => test(name, () => run(value, liveLayer), opts);
    live.only = (name, value, opts) => test.only(name, () => run(value, liveLayer), opts);
    live.skip = (name, value, opts) => test.skip(name, () => run(value, liveLayer), opts);
    return { effect, live };
};
// Test environment with TestClock and TestConsole
const testEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer());
// Live environment - uses real clock, but keeps TestConsole for output capture
const liveEnv = TestConsole.layer;
export const it = make(testEnv, liveEnv);
export const testEffect = (layer) => make(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv));
