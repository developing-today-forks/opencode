import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { McpxTool } from "@opencode/core/tool/plugin/mcpx";
// Regression coverage for #14: activating the mcpx plugin used to spawn a
// detached `mcpx daemon` from every process — including tests, whose
// throwaway HOME meant one leaked daemon per test run, invisible to
// `mcpx daemons` once the temp home was deleted. Spawning is now gated
// (test processes and OPENCODE_MCPX_DAEMON=0 never spawn), the binary is
// pinnable via OPENCODE_MCPX_BIN, and spawned daemons carry a bounded idle
// lifetime plus an MCPX_OWNER tag.
const managed = [
    "OPENCODE_MCPX_BIN",
    "OPENCODE_MCPX_DAEMON",
    "OPENCODE_MCPX_DAEMON_IDLE_EXIT",
    "OPENCODE_TEST_HOME",
    "MCPX_DAEMON_ENDPOINT",
    "MCPX_ENDPOINT",
    "MCPX_SOCKET",
    "MCPX_STATE_DIR",
    "FAKE_MCPX_RECORD",
];
let saved = {};
let dir;
let record;
beforeEach(async () => {
    saved = Object.fromEntries(managed.map((name) => [name, process.env[name]]));
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-mcpx-autostart-"));
    record = path.join(dir, "record.txt");
    // No daemon reachable: empty state dir, no endpoint, no socket override.
    process.env.MCPX_STATE_DIR = path.join(dir, "state");
    delete process.env.MCPX_DAEMON_ENDPOINT;
    delete process.env.MCPX_ENDPOINT;
    delete process.env.MCPX_SOCKET;
    McpxTool.resetDaemonEnsured();
});
afterEach(async () => {
    for (const name of managed) {
        if (saved[name] === undefined)
            delete process.env[name];
        else
            process.env[name] = saved[name];
    }
    McpxTool.resetDaemonEnsured();
    await fs.rm(dir, { recursive: true, force: true });
});
const exists = async (file) => {
    try {
        await fs.access(file);
        return true;
    }
    catch {
        return false;
    }
};
const fakeMcpx = async () => {
    const bin = path.join(dir, "mcpx");
    await fs.writeFile(bin, [
        "#!/bin/sh",
        'printf \'args:%s\\n\' "$*" >> "$FAKE_MCPX_RECORD"',
        'printf \'owner:%s\\n\' "$MCPX_OWNER" >> "$FAKE_MCPX_RECORD"',
        "exit 0",
        "",
    ].join("\n"), { mode: 0o755 });
    process.env.OPENCODE_MCPX_BIN = bin;
    process.env.FAKE_MCPX_RECORD = record;
    return bin;
};
// A fake whose `settings get daemon.autostart` fails: it prints the given
// autostart value (when one is passed) and then exits non-zero, like a
// broken or too-old mcpx. Every other invocation is a daemon spawn and is
// recorded the same way as fakeMcpx.
const fakeMcpxWithFailingSettings = async (value) => {
    const bin = path.join(dir, "mcpx");
    await fs.writeFile(bin, [
        "#!/bin/sh",
        'if [ "$1" = "settings" ]; then',
        ...(value === undefined ? [] : [`  printf 'daemon.autostart = %s\\n' "${value}"`]),
        "  exit 3",
        "fi",
        'printf \'args:%s\\n\' "$*" >> "$FAKE_MCPX_RECORD"',
        'printf \'owner:%s\\n\' "$MCPX_OWNER" >> "$FAKE_MCPX_RECORD"',
        "exit 0",
        "",
    ].join("\n"), { mode: 0o755 });
    process.env.OPENCODE_MCPX_BIN = bin;
    process.env.FAKE_MCPX_RECORD = record;
    return bin;
};
// A fake whose `settings get daemon.autostart` never answers: it replaces
// itself with a long sleep, so only the caller's timeout ends the call.
const fakeMcpxWithHangingSettings = async () => {
    const bin = path.join(dir, "mcpx");
    await fs.writeFile(bin, [
        "#!/bin/sh",
        'if [ "$1" = "settings" ]; then',
        "  exec sleep 30",
        "fi",
        'printf \'args:%s\\n\' "$*" >> "$FAKE_MCPX_RECORD"',
        "exit 0",
        "",
    ].join("\n"), { mode: 0o755 });
    process.env.OPENCODE_MCPX_BIN = bin;
    process.env.FAKE_MCPX_RECORD = record;
    return bin;
};
// A fake whose `settings get daemon.autostart` answers like the real CLI
// (first line `daemon.autostart = <value>`); every other invocation is a
// daemon spawn and is recorded the same way as fakeMcpx.
const fakeMcpxWithAutostart = async (value) => {
    const bin = path.join(dir, "mcpx");
    await fs.writeFile(bin, [
        "#!/bin/sh",
        'if [ "$1" = "settings" ]; then',
        `  printf 'daemon.autostart = %s\\n' "${value}"`,
        "  exit 0",
        "fi",
        'printf \'args:%s\\n\' "$*" >> "$FAKE_MCPX_RECORD"',
        'printf \'owner:%s\\n\' "$MCPX_OWNER" >> "$FAKE_MCPX_RECORD"',
        "exit 0",
        "",
    ].join("\n"), { mode: 0o755 });
    process.env.OPENCODE_MCPX_BIN = bin;
    process.env.FAKE_MCPX_RECORD = record;
    return bin;
};
describe("mcpx daemon autostart policy", () => {
    test("binary resolution prefers OPENCODE_MCPX_BIN", () => {
        expect(McpxTool.mcpxBinary({})).toBe("mcpx");
        expect(McpxTool.mcpxBinary({ OPENCODE_MCPX_BIN: "/opt/mcpx/bin/mcpx" })).toBe("/opt/mcpx/bin/mcpx");
    });
    test("autostart is off for tests and explicit opt-outs only", () => {
        expect(McpxTool.daemonAutostartEnabled({})).toBe(true);
        expect(McpxTool.daemonAutostartEnabled({ OPENCODE_TEST_HOME: "/tmp/oc-test" })).toBe(false);
        expect(McpxTool.daemonAutostartEnabled({ OPENCODE_MCPX_DAEMON: "0" })).toBe(false);
        expect(McpxTool.daemonAutostartEnabled({ OPENCODE_MCPX_DAEMON: "false" })).toBe(false);
        expect(McpxTool.daemonAutostartEnabled({ OPENCODE_MCPX_DAEMON: "off" })).toBe(false);
        expect(McpxTool.daemonAutostartEnabled({ OPENCODE_MCPX_DAEMON: "1" })).toBe(true);
    });
    test("spawn args bound the daemon's idle lifetime", () => {
        expect(McpxTool.daemonSpawnArgs({})).toEqual(["daemon", "--daemon-idle-exit", "1h"]);
        expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: "15m" })).toEqual([
            "daemon",
            "--daemon-idle-exit",
            "15m",
        ]);
        expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: "0" })).toEqual(["daemon"]);
        expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: "0s" })).toEqual(["daemon"]);
        expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: "1h30m" })).toEqual([
            "daemon",
            "--daemon-idle-exit",
            "1h30m",
        ]);
        expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: "1.5h" })).toEqual([
            "daemon",
            "--daemon-idle-exit",
            "1.5h",
        ]);
    });
    test("spawn args treat every Go spelling of zero as never idle-exit, without warning", () => {
        const warn = spyOn(console, "warn").mockImplementation(() => { });
        try {
            for (const value of ["-0", "+0", "-0s", "0.0s", "0h0m"]) {
                expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: value })).toEqual(["daemon"]);
            }
            expect(warn).not.toHaveBeenCalled();
        }
        finally {
            warn.mockRestore();
        }
    });
    test("spawn args fall back with a warning for durations Go rejects as int64-nanosecond overflow", () => {
        const warn = spyOn(console, "warn").mockImplementation(() => { });
        try {
            for (const value of ["2562048h", "10000000000h", "-2562048h", "9223372036854775808ns", "-9223372036854775809ns"]) {
                expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: value })).toEqual([
                    "daemon",
                    "--daemon-idle-exit",
                    "1h",
                ]);
            }
            expect(warn).toHaveBeenCalledTimes(5);
        }
        finally {
            warn.mockRestore();
        }
    });
    test("spawn args pass through the exact int64-nanosecond maximum", () => {
        const warn = spyOn(console, "warn").mockImplementation(() => { });
        try {
            for (const value of ["2562047h47m16.854775807s", "9223372036854775807ns", "-9223372036854775808ns"]) {
                expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: value })).toEqual([
                    "daemon",
                    "--daemon-idle-exit",
                    value,
                ]);
            }
            expect(warn).not.toHaveBeenCalled();
        }
        finally {
            warn.mockRestore();
        }
    });
    test("spawn args fall back to the default with a warning for an invalid idle exit", () => {
        const warn = spyOn(console, "warn").mockImplementation(() => { });
        try {
            for (const value of ["banana", "1 hour", "60", "1hr"]) {
                expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: value })).toEqual([
                    "daemon",
                    "--daemon-idle-exit",
                    "1h",
                ]);
            }
            expect(warn).toHaveBeenCalledTimes(4);
            expect(warn.mock.calls[0]?.[0]).toContain("OPENCODE_MCPX_DAEMON_IDLE_EXIT");
            expect(warn.mock.calls[0]?.[0]).toContain("banana");
        }
        finally {
            warn.mockRestore();
        }
    });
    test("spawn args do not warn for a valid idle exit", () => {
        const warn = spyOn(console, "warn").mockImplementation(() => { });
        try {
            McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: "15m" });
            McpxTool.daemonSpawnArgs({});
            expect(warn).not.toHaveBeenCalled();
        }
        finally {
            warn.mockRestore();
        }
    });
    test("ensureDaemon spawns nothing in a test process", async () => {
        await fakeMcpx();
        process.env.OPENCODE_TEST_HOME = dir;
        await McpxTool.ensureDaemon();
        expect(await exists(record)).toBe(false);
    });
    test("ensureDaemon spawns nothing when OPENCODE_MCPX_DAEMON=0", async () => {
        await fakeMcpx();
        delete process.env.OPENCODE_TEST_HOME;
        process.env.OPENCODE_MCPX_DAEMON = "0";
        await McpxTool.ensureDaemon();
        expect(await exists(record)).toBe(false);
    });
    // Windows cannot execute the #!/bin/sh fake (ensureDaemon spawns the pinned
    // binary directly, with no shell), so the record file is never written there
    // and this test fails with ENOENT (#92). The no-spawn policy tests above and
    // the pure spawn-args tests still run on Windows.
    test.skipIf(process.platform === "win32")("ensureDaemon spawns the pinned binary with idle exit and owner tag", async () => {
        await fakeMcpx();
        delete process.env.OPENCODE_TEST_HOME;
        delete process.env.OPENCODE_MCPX_DAEMON;
        await McpxTool.ensureDaemon();
        const text = await fs.readFile(record, "utf-8");
        expect(text).toContain("args:daemon --daemon-idle-exit 1h");
        expect(text).toContain(`owner:opencode:${process.pid}`);
    });
    test("mcpx daemon.autostart setting parses from settings get output", () => {
        expect(McpxTool.parseMcpxDaemonAutostart("daemon.autostart = false\n  from      config\n")).toBe(false);
        expect(McpxTool.parseMcpxDaemonAutostart("daemon.autostart = true\n  from      default\n")).toBe(true);
        expect(McpxTool.parseMcpxDaemonAutostart("")).toBeUndefined();
        expect(McpxTool.parseMcpxDaemonAutostart("no such setting\n")).toBeUndefined();
    });
    // #134: a supervised mcpx daemon (launchd/systemd) is configured with
    // daemon.autostart=false so nothing else starts a second daemon on the
    // same socket. The plugin used to spawn anyway whenever health did not
    // answer — e.g. while the supervised daemon was restarting.
    test.skipIf(process.platform === "win32")("ensureDaemon spawns nothing when mcpx daemon.autostart is false", async () => {
        await fakeMcpxWithAutostart("false");
        delete process.env.OPENCODE_TEST_HOME;
        delete process.env.OPENCODE_MCPX_DAEMON;
        await McpxTool.ensureDaemon();
        expect(await exists(record)).toBe(false);
    });
    test.skipIf(process.platform === "win32")("ensureDaemon still spawns when mcpx daemon.autostart is true", async () => {
        await fakeMcpxWithAutostart("true");
        delete process.env.OPENCODE_TEST_HOME;
        delete process.env.OPENCODE_MCPX_DAEMON;
        await McpxTool.ensureDaemon();
        const text = await fs.readFile(record, "utf-8");
        expect(text).toContain("args:daemon --daemon-idle-exit 1h");
    });
    // #178: the fail-open contract. Only an explicit `false` from a settings
    // call that succeeds may block the spawn; every failure of the call
    // itself (non-zero exit, missing binary, timeout) must keep today's
    // spawn behaviour, because the setting defaults to true. A regression
    // that treats a settings error as `false` would silently disable daemon
    // autostart for every user whose mcpx is old, broken, or slow.
    test.skipIf(process.platform === "win32")("ensureDaemon still spawns when the settings call exits non-zero", async () => {
        await fakeMcpxWithFailingSettings();
        delete process.env.OPENCODE_TEST_HOME;
        delete process.env.OPENCODE_MCPX_DAEMON;
        await McpxTool.ensureDaemon();
        const text = await fs.readFile(record, "utf-8");
        expect(text).toContain("args:daemon --daemon-idle-exit 1h");
    });
    test.skipIf(process.platform === "win32")("mcpxDaemonAutostart is true when the settings call exits non-zero", async () => {
        await fakeMcpxWithFailingSettings();
        expect(await McpxTool.mcpxDaemonAutostart()).toBe(true);
    });
    // The failing call's output must not be parsed either: a settings call
    // that prints `false` and then fails has not answered, so it cannot
    // block the spawn (the exec callback's error branch rejects outright).
    test.skipIf(process.platform === "win32")("mcpxDaemonAutostart is true when a failing settings call prints false", async () => {
        await fakeMcpxWithFailingSettings("false");
        expect(await McpxTool.mcpxDaemonAutostart()).toBe(true);
    });
    test("mcpxDaemonAutostart is true when the mcpx binary is missing", async () => {
        process.env.OPENCODE_MCPX_BIN = path.join(dir, "no-such-mcpx");
        expect(await McpxTool.mcpxDaemonAutostart()).toBe(true);
    });
    // At the ensureDaemon level a missing binary's spawn attempt is not
    // separately observable — the spawn itself fails with an async ENOENT
    // that ensureDaemon swallows by design — so the gating assertion is the
    // mcpxDaemonAutostart test above; this test pins that ensureDaemon
    // walks the spawn path and resolves instead of throwing or hanging.
    test("ensureDaemon resolves when the mcpx binary is missing", async () => {
        process.env.OPENCODE_MCPX_BIN = path.join(dir, "no-such-mcpx");
        delete process.env.OPENCODE_TEST_HOME;
        delete process.env.OPENCODE_MCPX_DAEMON;
        await McpxTool.ensureDaemon();
        expect(await exists(record)).toBe(false);
    });
    // The production timeout is 5s; the call passes 250ms so the timeout
    // branch is exercised without waiting it out. The elapsed bound is
    // timing-sensitive by design: 16x the injected timeout, yet below the
    // 5s default the call would take if the parameter were ignored.
    test.skipIf(process.platform === "win32")("mcpxDaemonAutostart is true when the settings call never answers", async () => {
        await fakeMcpxWithHangingSettings();
        const started = Date.now();
        expect(await McpxTool.mcpxDaemonAutostart(250)).toBe(true);
        expect(Date.now() - started).toBeLessThan(4000);
    });
});
