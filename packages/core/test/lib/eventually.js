import { Effect } from "effect";
// Bounded by elapsed real time rather than attempts, so a busy machine still fits. Sleeps on a real timer, so it
// also works under TestClock.
export const eventually = (effect, predicate) => Effect.gen(function* () {
    const deadline = Date.now() + 10000;
    while (true) {
        const value = yield* effect;
        if (predicate(value))
            return value;
        if (Date.now() > deadline)
            return yield* Effect.fail(new Error("Timed out waiting for value"));
        yield* Effect.promise(() => Bun.sleep(1));
    }
});
export const waitUntil = (condition) => eventually(condition, (ready) => ready).pipe(Effect.asVoid);
