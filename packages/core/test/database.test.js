var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { describe, expect, test } from "bun:test";
import { chmod, stat, writeFile } from "node:fs/promises";
import path from "path";
import { Effect, Layer } from "effect";
import { Database } from "@opencode/core/database/database";
import { Global } from "@opencode/util/global";
import { tmpdir } from "./fixture/tmpdir";
// Read while the connection is open: SQLite may remove the sidecars on close.
const openModes = (filename) => Effect.runPromise(Effect.gen(function* () {
    yield* Layer.build(Database.layer({ path: filename }));
    return yield* Effect.promise(() => Promise.all(["", "-wal", "-shm"].map(async (suffix) => (await stat(filename + suffix)).mode & 0o777)));
}).pipe(Effect.scoped, Effect.provideService(Global.Service, Global.make({ data: path.dirname(filename) }))));
describe.skipIf(process.platform === "win32")("Database file permissions", () => {
    test("creates the database and sidecars readable only by the owner", async () => {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_1, await tmpdir(), true);
            expect(await openModes(path.join(tmp.path, "opencode.db"))).toEqual([0o600, 0o600, 0o600]);
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            const result_1 = __disposeResources(env_1);
            if (result_1)
                await result_1;
        }
    });
    test("tightens an existing database and sidecars", async () => {
        const env_2 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_2, await tmpdir(), true);
            const filename = path.join(tmp.path, "opencode.db");
            await Promise.all(["", "-wal", "-shm"].map(async (suffix) => {
                await writeFile(filename + suffix, "");
                await chmod(filename + suffix, 0o644);
            }));
            expect(await openModes(filename)).toEqual([0o600, 0o600, 0o600]);
        }
        catch (e_2) {
            env_2.error = e_2;
            env_2.hasError = true;
        }
        finally {
            const result_2 = __disposeResources(env_2);
            if (result_2)
                await result_2;
        }
    });
});
