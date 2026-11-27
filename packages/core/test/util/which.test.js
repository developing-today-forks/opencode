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
import { which } from "@opencode/core/util/which";
import { appExecutionAlias } from "../fixture/app-execution-alias";
import { tmpdir } from "../fixture/tmpdir";
const alias = appExecutionAlias();
async function cmd(dir, name, exec = true) {
    const ext = process.platform === "win32" ? ".cmd" : "";
    const file = path.join(dir, name + ext);
    const body = process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n";
    await fs.writeFile(file, body);
    if (process.platform !== "win32") {
        await fs.chmod(file, exec ? 0o755 : 0o644);
    }
    return file;
}
function env(PATH) {
    return {
        PATH,
        PATHEXT: process.env["PATHEXT"],
    };
}
function envPath(Path) {
    return {
        Path,
        PathExt: process.env["PathExt"] ?? process.env["PATHEXT"],
    };
}
function same(a, b) {
    if (process.platform === "win32") {
        expect(a?.toLowerCase()).toBe(b.toLowerCase());
        return;
    }
    expect(a).toBe(b);
}
describe("util.which", () => {
    test("returns null when command is missing", () => {
        expect(which("opencode-missing-command-for-test")).toBeNull();
    });
    test("finds a command from PATH override", async () => {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_1, await tmpdir(), true);
            const bin = path.join(tmp.path, "bin");
            await fs.mkdir(bin);
            const file = await cmd(bin, "tool");
            same(which("tool", env(bin)), file);
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
    test("uses first PATH match", async () => {
        const env_2 = { stack: [], error: void 0, hasError: false };
        try {
            const tmp = __addDisposableResource(env_2, await tmpdir(), true);
            const a = path.join(tmp.path, "a");
            const b = path.join(tmp.path, "b");
            await fs.mkdir(a);
            await fs.mkdir(b);
            const first = await cmd(a, "dupe");
            await cmd(b, "dupe");
            same(which("dupe", env([a, b].join(path.delimiter))), first);
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
    test("returns null for non-executable file on unix", async () => {
        const env_3 = { stack: [], error: void 0, hasError: false };
        try {
            if (process.platform === "win32")
                return;
            const tmp = __addDisposableResource(env_3, await tmpdir(), true);
            const bin = path.join(tmp.path, "bin");
            await fs.mkdir(bin);
            await cmd(bin, "noexec", false);
            expect(which("noexec", env(bin))).toBeNull();
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
    test("uses PATHEXT on windows", async () => {
        const env_4 = { stack: [], error: void 0, hasError: false };
        try {
            if (process.platform !== "win32")
                return;
            const tmp = __addDisposableResource(env_4, await tmpdir(), true);
            const bin = path.join(tmp.path, "bin");
            await fs.mkdir(bin);
            const file = path.join(bin, "pathext.CMD");
            await fs.writeFile(file, "@echo off\r\n");
            expect(which("pathext", { PATH: bin, PATHEXT: ".CMD" })).toBe(file);
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
    // Skipped where no Microsoft Store app is installed for the user; see the fixture.
    test.skipIf(!alias)("finds a Microsoft Store app execution alias on windows", () => {
        same(which(path.parse(alias.name).name, env(alias.dir)), alias.file);
    });
    test("uses Windows Path casing fallback", async () => {
        const env_5 = { stack: [], error: void 0, hasError: false };
        try {
            if (process.platform !== "win32")
                return;
            const tmp = __addDisposableResource(env_5, await tmpdir(), true);
            const bin = path.join(tmp.path, "bin");
            await fs.mkdir(bin);
            const file = await cmd(bin, "mixed");
            same(which("mixed", envPath(bin)), file);
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
