import { describe, expect } from "bun:test";
import path from "path";
import { Effect } from "effect";
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder";
import { Shell } from "@opencode/core/shell";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { FSUtil } from "@opencode/util/fs-util";
import { Global } from "@opencode/util/global";
import { PersistentPty } from "@opencode/core/persistent-pty";
import { disabledPersistentPtyLayer } from "./fixture/persistent-pty";
import { withTempDir } from "./fixture/tmpdir";
import { it } from "./lib/effect";
const withStore = (body) => withTempDir((tmp) => {
    const layer = AppNodeBuilder.build(LayerNode.group([FSUtil.node, Global.node, PersistentPty.node]), [
        Global.node.replace(Global.layerWith({ data: tmp.path })),
        PersistentPty.node.replace(disabledPersistentPtyLayer),
    ]);
    return Effect.gen(function* () {
        const fs = yield* FSUtil.Service;
        return yield* body(fs, tmp.path);
    }).pipe(Effect.provide(layer));
});
describe("Shell cleanup", () => {
    it.live("removes expired output files across projects", () => withStore((fs, root) => Effect.gen(function* () {
        const first = path.join(root, Shell.DIRECTORY, "first");
        const second = path.join(root, Shell.DIRECTORY, "second");
        const old = path.join(first, "sh_0123456789abABCDEFGHIJKLMN.out");
        const recent = path.join(second, "sh_0123456789abNOPQRSTUVWXYZ0.out");
        const unrelated = path.join(first, "notes.out");
        yield* fs.ensureDir(first);
        yield* fs.ensureDir(second);
        yield* fs.writeFileString(old, "old");
        yield* fs.writeFileString(recent, "recent");
        yield* fs.writeFileString(unrelated, "unrelated");
        const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        yield* fs.utimes(old, new Date(), expired);
        yield* fs.utimes(unrelated, new Date(), expired);
        yield* Shell.cleanup();
        expect(yield* fs.exists(old)).toBe(false);
        expect(yield* fs.exists(recent)).toBe(true);
        expect(yield* fs.exists(unrelated)).toBe(true);
    })));
    it.live("keeps a running spawned command's capture past retention until it ends", () => withStore((fs, root) => Effect.gen(function* () {
        const project = path.join(root, Shell.DIRECTORY, "project");
        const live = path.join(project, "sh_0123456789abLIVEWRITER000.out");
        yield* fs.ensureDir(project);
        yield* fs.writeFileString(live, "live");
        const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        yield* fs.utimes(live, new Date(), expired);
        Shell.registerLiveCapture(live);
        yield* Shell.cleanup();
        expect(yield* fs.exists(live)).toBe(true);
        expect(yield* fs.readFileString(live)).toBe("live");
        Shell.unregisterLiveCapture(live);
        yield* Shell.cleanup();
        expect(yield* fs.exists(live)).toBe(false);
    })));
});
