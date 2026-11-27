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
import path from "path";
import { ShellSelect } from "@opencode/core/shell/select";
import { FSUtil } from "@opencode/util/fs-util";
import { which } from "@opencode/core/util/which";
import fs from "node:fs/promises";
import { appExecutionAlias } from "./fixture/app-execution-alias";
import { tmpdir } from "./fixture/tmpdir";
const alias = appExecutionAlias();
const withShell = async (shell, fn) => {
    const prev = process.env.SHELL;
    if (shell === undefined)
        delete process.env.SHELL;
    else
        process.env.SHELL = shell;
    ShellSelect.resolve.reset();
    try {
        await fn();
    }
    finally {
        if (prev === undefined)
            delete process.env.SHELL;
        else
            process.env.SHELL = prev;
        ShellSelect.resolve.reset();
    }
};
describe("shell", () => {
    test("normalizes shell names", () => {
        expect(ShellSelect.name("/bin/bash")).toBe("bash");
        if (process.platform === "win32") {
            expect(ShellSelect.name("C:/tools/NU.EXE")).toBe("nu");
            expect(ShellSelect.name("C:/tools/PWSH.EXE")).toBe("pwsh");
        }
    });
    test("detects login shells", () => {
        expect(ShellSelect.login("/bin/bash")).toBe(true);
        expect(ShellSelect.login("C:/tools/pwsh.exe")).toBe(false);
    });
    test("falls back when configured shell cannot be resolved", async () => {
        await withShell(undefined, async () => {
            const configured = ShellSelect.resolve({ priority: "config" });
            const compatible = ShellSelect.resolve({ priority: "compat" });
            expect(ShellSelect.resolve({ priority: "config" }, "opencode-missing-shell")).toBe(configured);
            expect(ShellSelect.resolve({ priority: "compat" }, "opencode-missing-shell")).toBe(compatible);
        });
    });
    test("falls back for terminal-only shells when compatibility is required", () => {
        expect(ShellSelect.name(ShellSelect.resolve({ priority: "compat" }, "fish"))).not.toBe("fish");
        expect(ShellSelect.name(ShellSelect.resolve({ priority: "compat" }, "nu"))).not.toBe("nu");
    });
    test("builds command args per shell family", () => {
        expect(ShellSelect.args("/bin/sh", "echo hi")).toEqual(["-c", "echo hi"]);
        expect(ShellSelect.args("/usr/bin/fish", "echo hi")).toEqual(["-c", "echo hi"]);
        expect(ShellSelect.args("/bin/zsh", "echo hi")).toEqual(["+o", "nomatch", "-c", "echo hi"]);
        expect(ShellSelect.args("/bin/bash", "echo hi")).toEqual(["-c", "echo hi"]);
        expect(ShellSelect.args("pwsh", "Write-Output hi")).toEqual([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Write-Output hi",
        ]);
    });
    const zsh = which("zsh");
    test.skipIf(!zsh || process.platform === "win32")("passes an unmatched zsh glob through to the command", () => {
        if (!zsh)
            return;
        const result = Bun.spawnSync([zsh, ...ShellSelect.args(zsh, "echo opencode-missing-*.nope; echo after")]);
        expect(result.stdout.toString()).toBe("opencode-missing-*.nope\nafter\n");
        expect(result.exitCode).toBe(0);
    });
    if (process.platform !== "win32") {
        test("resolves the environment shell without retaining a removed executable", async () => {
            await withShell(undefined, async () => {
                const env_1 = { stack: [], error: void 0, hasError: false };
                try {
                    const directory = __addDisposableResource(env_1, await tmpdir(), true);
                    const fallback = ShellSelect.environment();
                    const shell = path.join(directory.path, "preferred-shell");
                    await fs.symlink("/bin/sh", shell);
                    process.env.SHELL = shell;
                    expect(ShellSelect.environment()).toBe(shell);
                    expect(ShellSelect.resolve({ priority: "config" })).toBe(shell);
                    await fs.unlink(shell);
                    expect(ShellSelect.environment()).toBe(fallback);
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
        });
    }
    if (process.platform === "win32") {
        test("rejects blacklisted shells case-insensitively", async () => {
            await withShell("NU.EXE", async () => {
                expect(ShellSelect.name(ShellSelect.resolve({ priority: "compat" }))).not.toBe("nu");
            });
        });
        test("normalizes Git Bash shell paths from env", async () => {
            const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe";
            await withShell(shell, async () => {
                expect(ShellSelect.resolve({ priority: "config" })).toBe(FSUtil.windowsPath(shell));
            });
        });
        test("resolves /usr/bin/bash from env to Git Bash", async () => {
            const bash = ShellSelect.gitbash();
            if (!bash)
                return;
            await withShell("/usr/bin/bash", async () => {
                expect(ShellSelect.resolve({ priority: "compat" })).toBe(bash);
                expect(ShellSelect.resolve({ priority: "config" })).toBe(bash);
            });
        });
        test("resolves bare bash to Git Bash before PATH", async () => {
            const bash = ShellSelect.gitbash();
            if (!bash)
                return;
            expect(ShellSelect.resolve({ priority: "compat" }, "bash")).toBe(bash);
            expect(ShellSelect.resolve({ priority: "config" }, "bash")).toBe(bash);
            await withShell("bash", async () => {
                expect(ShellSelect.resolve({ priority: "compat" })).toBe(bash);
                expect(ShellSelect.resolve({ priority: "config" })).toBe(bash);
            });
        });
        test("resolves bare PowerShell shells", async () => {
            const shell = which("pwsh") || which("powershell");
            if (!shell)
                return;
            await withShell(path.win32.basename(shell), async () => {
                expect(ShellSelect.resolve({ priority: "config" })).toBe(shell);
            });
        });
        // Store installs of PowerShell 7 are app execution aliases; stat throws EACCES for them. Skipped where no
        // Microsoft Store app is installed for the user; see the fixture.
        test.skipIf(!alias)("resolves a configured app execution alias", () => {
            expect(ShellSelect.resolve({ priority: "config" }, alias.file)).toBe(alias.file);
        });
    }
});
