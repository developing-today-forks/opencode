import { Effect, Option } from "effect";
import { Instructions } from "@opencode/core/instructions/index";
export const state = (values) => ({ values });
const hashes = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Instructions.hash(value)]));
export const readInitial = (instructions) => Effect.gen(function* () {
    const admission = yield* Instructions.read(instructions).pipe(Effect.flatMap(Instructions.diff));
    const current = state(Object.fromEntries(Object.entries(admission.delta).flatMap(([key, hash]) => hash === "removed" ? [] : [[key, admission.blobs[hash]]])));
    return { ...current, text: Instructions.join(Instructions.renderInitial(instructions, current.values)) };
});
export const readUpdate = (instructions, previous) => Effect.gen(function* () {
    const admission = yield* Instructions.read(instructions).pipe(Effect.flatMap((observed) => Instructions.diff(observed, hashes(previous.values))));
    const delta = Object.fromEntries(Object.entries(admission.delta).map(([key, hash]) => [
        key,
        hash === "removed" ? Option.none() : Option.some(admission.blobs[hash]),
    ]));
    const values = { ...previous.values };
    for (const [key, value] of Object.entries(delta)) {
        if (Option.isNone(value))
            delete values[key];
        else
            values[key] = value.value;
    }
    return {
        values,
        text: Instructions.renderUpdate(instructions, previous.values, delta),
        changed: Object.keys(admission.delta).length > 0,
    };
});
