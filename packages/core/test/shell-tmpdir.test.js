import { expect } from "bun:test";
import { Effect } from "effect";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder";
import { Config } from "@opencode/core/config";
import { Environment } from "@opencode/core/environment/index";
import { Location } from "@opencode/core/location";
import { PluginHooks } from "@opencode/core/plugin/hooks";
import { SessionEnvironment } from "@opencode/core/session/environment";
import { SessionSchema } from "@opencode/core/session/schema";
import { Shell } from "@opencode/core/shell";
import { Global } from "@opencode/util/global";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { hostEnvironmentLayer } from "./fixture/environment";
import { tempLocationLayer } from "./fixture/location";
import { it } from "./lib/effect";
// Coverage for #13 item 2: when OPENCODE_TMPDIR configures a durable scratch
// directory, shell children get TMPDIR/TMP/TEMP pointed at the same directory
// Global advertises to the model (global.tmp), whatever their base env says.
// Unset, shells keep inheriting the base env unchanged.
if (process.platform !== "win32") {
    it.live("OPENCODE_TMPDIR points shell temp vars at the advertised tmp directory", () => Effect.gen(function* () {
        const base = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-tmpdir-")));
        const durable = path.join(base, "durable");
        const original = path.join(base, "server");
        const sessionValue = path.join(base, "session");
        yield* Effect.promise(() => Promise.all([durable, original, sessionValue].map((dir) => fs.mkdir(dir))));
        const previousTmpdir = process.env.TMPDIR;
        const previousOverride = process.env.OPENCODE_TMPDIR;
        process.env.TMPDIR = original;
        process.env.OPENCODE_TMPDIR = durable;
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(base, { recursive: true, force: true })).pipe(Effect.andThen(Effect.sync(() => {
            if (previousTmpdir === undefined)
                delete process.env.TMPDIR;
            else
                process.env.TMPDIR = previousTmpdir;
            if (previousOverride === undefined)
                delete process.env.OPENCODE_TMPDIR;
            else
                process.env.OPENCODE_TMPDIR = previousOverride;
        })), Effect.orDie));
        const data = path.join(base, "data");
        const cache = path.join(base, "cache");
        const globalLayer = Global.layerWith({
            data,
            cache,
            config: path.join(base, "config"),
            state: path.join(base, "state"),
            tmp: durable,
            bin: path.join(cache, "bin"),
            log: path.join(data, "log"),
            repos: path.join(data, "repos"),
        });
        yield* Effect.gen(function* () {
            const shell = yield* Shell.Service;
            const environments = yield* SessionEnvironment.Service;
            const print = `printf '%s|%s|%s' "$TMPDIR" "$TMP" "$TEMP"`;
            // Process-env base: all three temp vars agree with the advertised directory.
            const first = yield* shell.create({ shell: "/bin/sh", command: print, timeout: 0 });
            expect((yield* shell.result(first)).capture?.output).toBe(`${durable}|${durable}|${durable}`);
            expect(process.env.TMPDIR).toBe(original);
            // Session-env base: the configured directory wins over the session's own TMPDIR.
            const sessionID = SessionSchema.ID.make("ses_tmpdir_override");
            yield* environments.set(sessionID, { TMPDIR: sessionValue });
            const second = yield* shell.create({ shell: "/bin/sh", command: print, timeout: 0, metadata: { sessionID } });
            expect((yield* shell.result(second)).capture?.output).toBe(`${durable}|${durable}|${durable}`);
            expect(yield* environments.get(sessionID)).toEqual({ TMPDIR: sessionValue });
            // Unset: shells inherit the base env again, exactly as before.
            delete process.env.OPENCODE_TMPDIR;
            const third = yield* shell.create({ shell: "/bin/sh", command: `printf %s "$TMPDIR"`, timeout: 0 });
            expect((yield* shell.result(third)).capture?.output).toBe(original);
        }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([Shell.node, PluginHooks.node, SessionEnvironment.node]), [
            Location.node.replace(tempLocationLayer),
            Global.node.replace(globalLayer),
            Config.node.replace(Config.testLayer()),
            Environment.node.replace(hostEnvironmentLayer),
        ])));
    }));
}
