import { Effect } from "effect";
export function withEnv(variables, effect) {
    return Effect.acquireUseRelease(Effect.sync(() => {
        const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
        Object.entries(variables).forEach(([key, value]) => {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        });
        return previous;
    }), effect, (previous) => Effect.sync(() => {
        Object.entries(previous).forEach(([key, value]) => {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        });
    }));
}
