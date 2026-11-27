import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { FileMutation } from "../src/file-mutation";
import { Failed, makeFiles, makeLocalDriver, MAX_WHOLE_FILE_BYTES } from "../src/environment/index";
import { tmpdir } from "./fixture/tmpdir";
import { it } from "./lib/effect";
const withLocalFiles = (run) => Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const tmp = yield* Effect.promise(() => tmpdir("opencode-local-read-limit-"));
    return yield* run(makeFiles(makeLocalDriver(spawner)), tmp.path).pipe(Effect.ensuring(Effect.promise(() => tmp[Symbol.asyncDispose]())));
}).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)));
/** A sparse file of the given size, with an optional marker written at an offset. */
const sparse = (target, size, marker) => Effect.promise(async () => {
    const handle = await fs.open(target, "w");
    try {
        await handle.truncate(size);
        if (marker)
            await handle.write(marker.text, marker.offset, "utf8");
    }
    finally {
        await handle.close();
    }
});
describe("local driver whole-file read limit", () => {
    it.effect("fails a whole-file read above the bound with Environment.Failed", () => withLocalFiles((files, root) => Effect.gen(function* () {
        const target = path.join(root, "huge.bin");
        yield* sparse(target, MAX_WHOLE_FILE_BYTES + 1);
        // The success value is mapped to a sentinel so a regression failure never
        // asks the reporter to format a 64 MiB result object.
        const error = yield* files.read(target).pipe(Effect.as("read-succeeded"), Effect.flip);
        expect(error).toBeInstanceOf(Failed);
        expect(error.path).toBe(target);
        expect(String(error.cause)).toContain("whole-file read limit");
    })));
    it.effect("reads a file at exactly the bound", () => withLocalFiles((files, root) => Effect.gen(function* () {
        const target = path.join(root, "edge.bin");
        yield* sparse(target, MAX_WHOLE_FILE_BYTES, { offset: 0, text: "edge" });
        const result = yield* files.read(target);
        expect(result.bytes.byteLength).toBe(MAX_WHOLE_FILE_BYTES);
        expect(new TextDecoder().decode(result.bytes.subarray(0, 4))).toBe("edge");
    })));
    it.effect("reads a range from a file above the bound", () => withLocalFiles((files, root) => Effect.gen(function* () {
        const target = path.join(root, "huge.bin");
        yield* sparse(target, MAX_WHOLE_FILE_BYTES + 4096, { offset: 128, text: "ranged" });
        const result = yield* files.read(target, { offset: 128, length: 6 });
        expect(new TextDecoder().decode(result.bytes)).toBe("ranged");
    })));
    it.effect("surfaces the bound to FileMutation.readText as a typed failure, not a defect", () => withLocalFiles((files, root) => Effect.gen(function* () {
        const target = path.join(root, "huge.txt");
        yield* sparse(target, MAX_WHOLE_FILE_BYTES + 1);
        const error = yield* FileMutation.readText(files, target).pipe(Effect.as("read-succeeded"), Effect.flip);
        expect(error).toBeInstanceOf(Failed);
    })));
});
