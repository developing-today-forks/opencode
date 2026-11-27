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
import fs from "fs/promises";
import path from "path";
import { Flock } from "@opencode/util/flock";
import { Hash } from "@opencode/util/hash";
import { runLockWorker, spawnLockWorker, stopLockWorker, waitForFile } from "../fixture/lock-worker";
import { tmpdir } from "../fixture/tmpdir";
const worker = path.join(import.meta.dir, "../fixture/flock-worker.ts");
function lock(dir, key) {
    return path.join(dir, Hash.fast(key) + ".lock");
}
async function exists(file) {
    return fs
        .stat(file)
        .then(() => true)
        .catch(() => false);
}
async function readJson(p) {
    return JSON.parse(await fs.readFile(p, "utf8"));
}
describe("util.flock", () => {
    test("enforces mutual exclusion under process contention", async () => {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_1, await tmpdir("flock-test-"), true);
            const dir = path.join(tmp.path, "locks");
            const done = path.join(tmp.path, "done.log");
            const active = path.join(tmp.path, "active");
            const key = "flock:stress";
            const n = 16;
            const out = await Promise.all(Array.from({ length: n }, () => runLockWorker(worker, {
                key,
                dir,
                done,
                active,
                holdMs: 30,
                staleMs: 1000,
                timeoutMs: 15000,
            })));
            expect(out.map((x) => x.code)).toEqual(Array.from({ length: n }, () => 0));
            expect(out.map((x) => x.stderr.toString()).filter(Boolean)).toEqual([]);
            const lines = (await fs.readFile(done, "utf8"))
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean);
            expect(lines.length).toBe(n);
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
    }, 20000);
    test("times out while waiting when lock is still healthy", async () => {
        const env_2 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_2, await tmpdir("flock-test-"), true);
            const dir = path.join(tmp.path, "locks");
            const key = "flock:timeout";
            const ready = path.join(tmp.path, "ready");
            const proc = spawnLockWorker(worker, {
                key,
                dir,
                ready,
                holdMs: 20000,
                staleMs: 10000,
                timeoutMs: 30000,
            });
            try {
                await waitForFile(ready, 5000);
                const seen = [];
                const err = await Flock.withLock(key, async () => { }, {
                    dir,
                    staleMs: 10000,
                    timeoutMs: 1000,
                    onWait: (tick) => {
                        seen.push(tick.key);
                    },
                }).catch((err) => err);
                expect(err).toBeInstanceOf(Error);
                if (!(err instanceof Error))
                    throw err;
                expect(err.message).toContain("Timed out waiting for lock");
                expect(seen.length).toBeGreaterThan(0);
                expect(seen.every((x) => x === key)).toBe(true);
            }
            finally {
                await stopLockWorker(proc).catch(() => undefined);
            }
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
    }, 15000);
    test("recovers after a crashed lock owner", async () => {
        const env_3 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_3, await tmpdir("flock-test-"), true);
            const dir = path.join(tmp.path, "locks");
            const key = "flock:crash";
            const ready = path.join(tmp.path, "ready");
            const proc = spawnLockWorker(worker, {
                key,
                dir,
                ready,
                holdMs: 20000,
                staleMs: 500,
                timeoutMs: 30000,
            });
            try {
                await waitForFile(ready, 5000);
                await stopLockWorker(proc);
                let hit = false;
                await Flock.withLock(key, async () => {
                    hit = true;
                }, {
                    dir,
                    staleMs: 500,
                    timeoutMs: 8000,
                });
                expect(hit).toBe(true);
            }
            finally {
                await stopLockWorker(proc);
            }
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
    }, 20000);
    test("breaks stale lock dirs when heartbeat is missing", async () => {
        const env_4 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_4, await tmpdir("flock-test-"), true);
            const dir = path.join(tmp.path, "locks");
            const key = "flock:missing-heartbeat";
            const lockDir = lock(dir, key);
            await fs.mkdir(lockDir, { recursive: true });
            const old = new Date(Date.now() - 2000);
            await fs.utimes(lockDir, old, old);
            let hit = false;
            await Flock.withLock(key, async () => {
                hit = true;
            }, {
                dir,
                staleMs: 200,
                timeoutMs: 3000,
            });
            expect(hit).toBe(true);
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
    test("recovers when a stale breaker claim was left behind", async () => {
        const env_5 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_5, await tmpdir("flock-test-"), true);
            const dir = path.join(tmp.path, "locks");
            const key = "flock:stale-breaker";
            const lockDir = lock(dir, key);
            const breaker = lockDir + ".breaker";
            await fs.mkdir(lockDir, { recursive: true });
            await fs.mkdir(breaker);
            const old = new Date(Date.now() - 2000);
            await fs.utimes(lockDir, old, old);
            await fs.utimes(breaker, old, old);
            let hit = false;
            await Flock.withLock(key, async () => {
                hit = true;
            }, {
                dir,
                staleMs: 200,
                timeoutMs: 3000,
            });
            expect(hit).toBe(true);
            expect(await exists(breaker)).toBe(false);
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
    test("fails clearly if lock dir is removed while held", async () => {
        const env_6 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_6, await tmpdir("flock-test-"), true);
            const dir = path.join(tmp.path, "locks");
            const key = "flock:compromised";
            const lockDir = lock(dir, key);
            const err = await Flock.withLock(key, async () => {
                await fs.rm(lockDir, {
                    recursive: true,
                    force: true,
                });
            }, {
                dir,
                staleMs: 1000,
                timeoutMs: 3000,
            }).catch((err) => err);
            expect(err).toBeInstanceOf(Error);
            if (!(err instanceof Error))
                throw err;
            expect(err.message).toContain("compromised");
            let hit = false;
            await Flock.withLock(key, async () => {
                hit = true;
            }, {
                dir,
                staleMs: 200,
                timeoutMs: 3000,
            });
            expect(hit).toBe(true);
        }
        catch (e_6) {
            env_6.error = e_6;
            env_6.hasError = true;
        }
        finally {
            const result_6 = __disposeResources(env_6);
            if (result_6)
                await result_6;
        }
    });
    test("writes owner metadata while lock is held", async () => {
        const env_7 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_7, await tmpdir("flock-test-"), true);
            const dir = path.join(tmp.path, "locks");
            const key = "flock:meta";
            const file = path.join(lock(dir, key), "meta.json");
            await Flock.withLock(key, async () => {
                const json = await readJson(file);
                expect(typeof json.token).toBe("string");
                expect(typeof json.pid).toBe("number");
                expect(typeof json.hostname).toBe("string");
                expect(typeof json.createdAt).toBe("string");
            }, {
                dir,
                staleMs: 1000,
                timeoutMs: 3000,
            });
        }
        catch (e_7) {
            env_7.error = e_7;
            env_7.hasError = true;
        }
        finally {
            const result_7 = __disposeResources(env_7);
            if (result_7)
                await result_7;
        }
    });
    test("supports acquire with await using", async () => {
        const env_8 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_8, await tmpdir("flock-test-"), true);
            const dir = path.join(tmp.path, "locks");
            const key = "flock:acquire";
            const lockDir = lock(dir, key);
            {
                const env_9 = { stack: [], error: void 0, hasError: false };
                try {
                    const _ = __addDisposableResource(env_9, await Flock.acquire(key, {
                        dir,
                        staleMs: 1000,
                        timeoutMs: 3000,
                    }), true);
                    expect(await exists(lockDir)).toBe(true);
                }
                catch (e_8) {
                    env_9.error = e_8;
                    env_9.hasError = true;
                }
                finally {
                    const result_8 = __disposeResources(env_9);
                    if (result_8)
                        await result_8;
                }
            }
            expect(await exists(lockDir)).toBe(false);
        }
        catch (e_9) {
            env_8.error = e_9;
            env_8.hasError = true;
        }
        finally {
            const result_9 = __disposeResources(env_8);
            if (result_9)
                await result_9;
        }
    });
    test("refuses token mismatch release and recovers from stale", async () => {
        const env_10 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_10, await tmpdir("flock-test-"), true);
            const dir = path.join(tmp.path, "locks");
            const key = "flock:token";
            const lockDir = lock(dir, key);
            const meta = path.join(lockDir, "meta.json");
            const err = await Flock.withLock(key, async () => {
                const json = await readJson(meta);
                json.token = "tampered";
                await fs.writeFile(meta, JSON.stringify(json, null, 2));
            }, {
                dir,
                staleMs: 500,
                timeoutMs: 3000,
            }).catch((err) => err);
            expect(err).toBeInstanceOf(Error);
            if (!(err instanceof Error))
                throw err;
            expect(err.message).toContain("token mismatch");
            expect(await exists(lockDir)).toBe(true);
            let hit = false;
            await Flock.withLock(key, async () => {
                hit = true;
            }, {
                dir,
                staleMs: 500,
                timeoutMs: 6000,
            });
            expect(hit).toBe(true);
        }
        catch (e_10) {
            env_10.error = e_10;
            env_10.hasError = true;
        }
        finally {
            const result_10 = __disposeResources(env_10);
            if (result_10)
                await result_10;
        }
    });
    test("fails clearly on unwritable lock roots", async () => {
        const env_11 = { stack: [], error: void 0, hasError: false };
        try {
            if (process.platform === "win32")
                return;
            const tmp = __addDisposableResource(env_11, await tmpdir("flock-test-"), true);
            const dir = path.join(tmp.path, "locks");
            const key = "flock:perm";
            await fs.mkdir(dir, { recursive: true });
            await fs.chmod(dir, 0o500);
            try {
                const err = await Flock.withLock(key, async () => { }, {
                    dir,
                    staleMs: 100,
                    timeoutMs: 500,
                }).catch((err) => err);
                expect(err).toBeInstanceOf(Error);
                if (!(err instanceof Error))
                    throw err;
                const text = err.message;
                expect(text.includes("EACCES") || text.includes("EPERM")).toBe(true);
            }
            finally {
                await fs.chmod(dir, 0o700);
            }
        }
        catch (e_11) {
            env_11.error = e_11;
            env_11.hasError = true;
        }
        finally {
            const result_11 = __disposeResources(env_11);
            if (result_11)
                await result_11;
        }
    });
});
