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
import { afterEach, describe, expect, test } from "bun:test";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileLogger } from "@opencode/util/observability/logging";
import { resource } from "@opencode/util/observability/otlp";
const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES;
afterEach(() => {
    if (otelResourceAttributes === undefined)
        delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else
        process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes;
});
describe("resource", () => {
    test("parses and decodes OTEL resource attributes", () => {
        process.env.OTEL_RESOURCE_ATTRIBUTES =
            "service.namespace=anomalyco,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here";
        expect(resource().attributes).toMatchObject({
            "service.namespace": "anomalyco",
            team: "platform,observability",
            label: "hello=world",
            "key/name": "value here",
        });
    });
    test("drops OTEL resource attributes when any entry is invalid", () => {
        process.env.OTEL_RESOURCE_ATTRIBUTES = "service.namespace=anomalyco,broken";
        expect(resource().attributes["service.namespace"]).toBeUndefined();
        expect(resource().attributes["opencode.client"]).toBeDefined();
    });
    test("keeps built-in attributes when env values conflict", () => {
        process.env.OTEL_RESOURCE_ATTRIBUTES =
            "opencode.client=web,service.instance.id=override,service.namespace=anomalyco";
        const app = { client: "cli", version: "1.2.3", channel: "beta" };
        expect(resource(app).attributes).toMatchObject({
            "opencode.client": "cli",
            "service.namespace": "anomalyco",
        });
        expect(resource(app).attributes["service.instance.id"]).not.toBe("override");
        expect(resource(app).attributes["opencode.run"]).toMatch(/^[0-9a-f]{8}$/);
    });
});
test("falls back to local logging when OTLP initialization fails", async () => {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-observability-test-"));
        const _ = __addDisposableResource(env_1, {
            async [Symbol.asyncDispose]() {
                await fs.rm(dir, { recursive: true, force: true });
            },
        }, true);
        const child = Bun.spawn([
            process.execPath,
            "--eval",
            `
        import { Effect } from "effect"
        import { Observability } from "@opencode/util/observability"
        await Effect.void.pipe(Effect.provide(Observability.layer()), Effect.scoped, Effect.runPromise)
      `,
        ], {
            cwd: path.join(import.meta.dir, "../.."),
            env: {
                ...process.env,
                OTEL_EXPORTER_OTLP_ENDPOINT: "://invalid",
                XDG_CACHE_HOME: path.join(dir, "cache"),
                XDG_CONFIG_HOME: path.join(dir, "config"),
                XDG_DATA_HOME: path.join(dir, "data"),
                XDG_STATE_HOME: path.join(dir, "state"),
            },
            stdout: "ignore",
            stderr: "pipe",
        });
        const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
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
test("file logger appends concurrent runs with a run on every line", async () => {
    const env_2 = { stack: [], error: void 0, hasError: false };
    try {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"));
        const _ = __addDisposableResource(env_2, {
            async [Symbol.asyncDispose]() {
                await fs.rm(dir, { recursive: true, force: true });
            },
        }, true);
        const file = path.join(dir, "opencode.log");
        const write = (runID) => Effect.forEach(Array.from({ length: 50 }, (_, index) => index), (index) => Effect.logInfo(`entry-${index}`)).pipe(Effect.provide(Logger.layer([fileLogger(file, runID)]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)), Effect.scoped);
        await Effect.runPromise(Effect.all([write("run-a"), write("run-b")], { concurrency: "unbounded" }));
        const lines = (await Bun.file(file).text()).trim().split("\n");
        expect(lines).toHaveLength(100);
        expect(lines.filter((line) => line.includes("run=run-a"))).toHaveLength(50);
        expect(lines.filter((line) => line.includes("run=run-b"))).toHaveLength(50);
        expect(lines.every((line) => line.startsWith("timestamp=") && line.includes(" level=INFO "))).toBe(true);
        expect(lines.every((line) => !line.includes(" fiber="))).toBe(true);
        expect(lines.every((line) => !line.startsWith("{"))).toBe(true);
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
test("file logger flattens nested objects", async () => {
    const env_3 = { stack: [], error: void 0, hasError: false };
    try {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"));
        const _ = __addDisposableResource(env_3, {
            async [Symbol.asyncDispose]() {
                await fs.rm(dir, { recursive: true, force: true });
            },
        }, true);
        const file = path.join(dir, "opencode.log");
        await Effect.logInfo("request complete", {
            request: { method: "GET", timing: { duration: 42 } },
            tags: ["api", "test"],
        }).pipe(Effect.annotateLogs({ session: { id: "session-1" } }), Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)), Effect.scoped, Effect.runPromise);
        const line = (await Bun.file(file).text()).trim();
        expect(line).toContain('message="request complete"');
        expect(line).toContain("request.method=GET");
        expect(line).toContain("request.timing.duration=42");
        expect(line).toContain('tags="[\\\"api\\\",\\\"test\\\"]"');
        expect(line).toContain("session.id=session-1");
        expect(line).not.toContain("request={");
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
