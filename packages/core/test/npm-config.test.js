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
import path from "path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { NpmConfig } from "@opencode/util/npm-config";
import { tmpdir } from "./fixture/tmpdir";
describe("NpmConfig.load", () => {
    test("reads registry from project .npmrc", async () => {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_1, await tmpdir(), true);
            await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test/\n");
            const config = await Effect.runPromise(NpmConfig.load(tmp.path));
            expect(config.registry).toBe("https://registry.example.test/");
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
    test("reads scoped registries from project .npmrc", async () => {
        const env_2 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_2, await tmpdir(), true);
            await Bun.write(path.join(tmp.path, ".npmrc"), "@acme:registry=https://npm.acme.test/\n");
            const config = await Effect.runPromise(NpmConfig.load(tmp.path));
            expect(config["@acme:registry"]).toBe("https://npm.acme.test/");
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
    test("flattens boolean and list options", async () => {
        const env_3 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_3, await tmpdir(), true);
            await Bun.write(path.join(tmp.path, ".npmrc"), "ignore-scripts=true\nomit[]=dev\nomit[]=optional\n");
            const config = await Effect.runPromise(NpmConfig.load(tmp.path));
            expect(config.ignoreScripts).toBe(true);
            expect(config.omit).toEqual(["dev", "optional"]);
        }
        catch (e_3) {
            env_3.error = e_3;
            env_3.hasError = true;
        }
        finally {
            const result_3 = __disposeResources(env_3);
            if (result_3)
                await result_3;
        }
    });
});
describe("NpmConfig.registry", () => {
    test("normalizes configured registry without trailing slash", async () => {
        const env_4 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_4, await tmpdir(), true);
            await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test/\n");
            await expect(Effect.runPromise(NpmConfig.registry(tmp.path))).resolves.toBe("https://registry.example.test");
        }
        catch (e_4) {
            env_4.error = e_4;
            env_4.hasError = true;
        }
        finally {
            const result_4 = __disposeResources(env_4);
            if (result_4)
                await result_4;
        }
    });
    test("leaves configured registry without trailing slash unchanged", async () => {
        const env_5 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_5, await tmpdir(), true);
            await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test\n");
            await expect(Effect.runPromise(NpmConfig.registry(tmp.path))).resolves.toBe("https://registry.example.test");
        }
        catch (e_5) {
            env_5.error = e_5;
            env_5.hasError = true;
        }
        finally {
            const result_5 = __disposeResources(env_5);
            if (result_5)
                await result_5;
        }
    });
});
