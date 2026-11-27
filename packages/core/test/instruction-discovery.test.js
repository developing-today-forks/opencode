import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Layer, PlatformError, PubSub, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import fs from "fs/promises";
import path from "path";
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder";
import { Bus } from "@opencode/core/bus";
import { Config } from "@opencode/core/config";
import { ConfigInstructionPlugin } from "@opencode/core/config/plugin/instruction";
import { Watcher } from "@opencode/core/filesystem/watcher";
import { InstructionDiscovery } from "@opencode/core/instruction-discovery";
import { Location } from "@opencode/core/location";
import { AbsolutePath } from "@opencode/core/schema";
import { Document, Info } from "@opencode/schema/config";
import { Event } from "@opencode/schema/event";
import { FSUtil } from "@opencode/util/fs-util";
import { Global } from "@opencode/util/global";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { tempGlobalLayer } from "./fixture/global";
import { location } from "./fixture/location";
import { tmpdir, tmpdirScoped } from "./fixture/tmpdir";
import { readInitial, readUpdate, state } from "./lib/instructions";
import { testEffect } from "./lib/effect";
import { host } from "./plugin/host";
const it = testEffect(Layer.empty);
const instructionLayer = (input) => {
    const watcher = Watcher.testLayer;
    const config = Config.testLayer(input.instructions ? [configured(input.instructions)] : []);
    return Layer.mergeAll(AppNodeBuilder.build(LayerNode.group([
        InstructionDiscovery.node,
        Bus.node,
        Config.node,
        FSUtil.node,
        Global.node,
        Location.node,
        Watcher.node,
    ]), [
        Config.node.replace(config),
        InstructionDiscovery.node.replace(InstructionDiscovery.configured({
            project: input.project,
            claude: input.claude,
        })),
        Global.node.replace(input.config || input.home
            ? Global.layerWith({
                ...(input.config ? { config: input.config } : {}),
                ...(input.home ? { home: input.home } : {}),
            })
            : tempGlobalLayer),
        Location.node.replace(input.locationServiceLayer),
        Watcher.node.replace(watcher),
        ...(input.filesystemLayer ? [FSUtil.node.replace(input.filesystemLayer)] : []),
    ]), watcher, config, Layer.succeed(HttpClient.HttpClient, input.http ?? respond(() => new Response(null, { status: 404 }))));
};
const start = Effect.fnUntraced(function* (ctx = host()) {
    yield* ConfigInstructionPlugin.Plugin.effect(ctx);
    return yield* InstructionDiscovery.Service;
});
const configured = (instructions) => new Document({ type: "document", info: new Info({ instructions }) });
const readFailure = (tag, code, file) => PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method: "readFile",
    pathOrDescriptor: file,
    cause: Object.assign(new Error(code), { code }),
});
const configUpdated = () => ({ id: Event.ID.create(), created: Date.now(), type: "config.updated", data: { sections: ["*"] } });
const respond = (handler) => HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request.url))));
const file = (path, content) => new InstructionDiscovery.File({ path, content });
function emitAndWait(update) {
    return Effect.gen(function* () {
        const watcher = yield* Watcher.Test;
        yield* triggerAndWait(watcher.emit(update));
    });
}
function triggerAndWait(trigger) {
    return Effect.gen(function* () {
        const bus = yield* Bus.Service;
        const updated = yield* Deferred.make();
        const fiber = yield* bus.subscribe(InstructionDiscovery.Event.Updated).pipe(Stream.runForEach(() => Deferred.succeed(updated, undefined).pipe(Effect.asVoid)), Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* trigger;
        yield* Deferred.await(updated).pipe(Effect.timeout("2 seconds"));
        yield* Fiber.interrupt(fiber);
    });
}
describe("InstructionDiscovery", () => {
    it.effect("stores ordered values with last-write-wins precedence", () => Effect.gen(function* () {
        const discovery = yield* InstructionDiscovery.Service;
        yield* discovery.transform((editor) => {
            editor.add(file("/repo/AGENTS.md", "first"));
            editor.add(file("/repo/packages/AGENTS.md", "package"));
            editor.add(file("/repo/AGENTS.md", "last"));
            editor.update("/repo/packages/AGENTS.md", (current) => {
                current.content = "updated";
                current.path = AbsolutePath.make("/ignored");
            });
            editor.remove("/missing");
        });
        expect(yield* discovery.list()).toEqual([
            file("/repo/AGENTS.md", "last"),
            file("/repo/packages/AGENTS.md", "updated"),
        ]);
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([InstructionDiscovery.node, Bus.node])))));
    it.effect("preserves admitted values while the source is unavailable", () => Effect.gen(function* () {
        const discovery = yield* InstructionDiscovery.Service;
        yield* discovery.transform((editor) => editor.unavailable());
        expect((yield* readUpdate(yield* discovery.load(), state({ "core/instructions": [{ path: "/repo/AGENTS.md", content: "old" }] }))).changed).toBe(false);
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([InstructionDiscovery.node, Bus.node])))));
    it.effect("renders granular instruction updates", () => Effect.gen(function* () {
        const discovery = yield* InstructionDiscovery.Service;
        yield* discovery.transform((editor) => {
            editor.add(file("/global/AGENTS.md", "global"));
            editor.add(file("/repo/AGENTS.md", ["old", ...Array.from({ length: 20 }, (_, index) => `keep ${index}`)].join("\n")));
        });
        const initial = yield* readInitial(yield* discovery.load());
        yield* discovery.transform((editor) => {
            editor.update("/repo/AGENTS.md", (current) => {
                current.content = ["new", ...Array.from({ length: 20 }, (_, index) => `keep ${index}`)].join("\n");
            });
        });
        const modified = (yield* readUpdate(yield* discovery.load(), initial)).text;
        expect(modified).toContain("The instructions from /repo/AGENTS.md changed. Here's the diff:");
        expect(modified).toContain("-old\n+new");
        expect(modified).not.toContain("global");
        const rewritten = state({
            "core/instructions": [{ path: "/repo/AGENTS.md", content: "old one\nold two\nold three\nold four" }],
        });
        yield* discovery.transform((editor) => {
            editor.remove("/global/AGENTS.md");
            editor.update("/repo/AGENTS.md", (current) => {
                current.content = "new";
            });
        });
        expect((yield* readUpdate(yield* discovery.load(), rewritten)).text).toBe("The instructions changed:\nInstructions from: /repo/AGENTS.md\nnew");
        yield* discovery.transform((editor) => {
            editor.add(file("/repo/packages/AGENTS.md", "package"));
        });
        const structural = (yield* readUpdate(yield* discovery.load(), initial)).text;
        expect(structural).toContain("The instructions from /global/AGENTS.md no longer apply.");
        expect(structural).toContain("New instructions apply from:\nInstructions from: /repo/packages/AGENTS.md\npackage");
        expect(structural).not.toContain("Instructions from: /global/AGENTS.md\nglobal");
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([InstructionDiscovery.node, Bus.node])))));
});
describe("ConfigInstructionPlugin.Plugin", () => {
    it.live("loads global and upward project files and rescans them on change", () => tmpdirScoped().pipe(Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global");
        const home = path.join(tmp.path, "home");
        const shared = path.join(home, "code");
        const project = path.join(shared, "repo");
        const directory = path.join(project, "packages", "core");
        const outside = path.join(tmp.path, "AGENTS.md");
        const globalFile = path.join(global, "AGENTS.md");
        const sharedFile = path.join(shared, "AGENTS.md");
        const projectFile = path.join(project, "AGENTS.md");
        const packageFile = path.join(directory, "AGENTS.md");
        return Effect.gen(function* () {
            yield* Effect.promise(async () => {
                await fs.mkdir(global, { recursive: true });
                await fs.mkdir(directory, { recursive: true });
                await fs.writeFile(outside, "outside");
                await fs.writeFile(globalFile, "global");
                await fs.writeFile(sharedFile, "shared");
                await fs.writeFile(projectFile, "project");
                await fs.writeFile(packageFile, "package");
            });
            const discovery = yield* start();
            const watcher = yield* Watcher.Test;
            expect(yield* watcher.subscriptions()).toEqual([
                { path: globalFile, type: "file" },
                { path: path.join(home, ".claude", "CLAUDE.md"), type: "file" },
                { path: packageFile, type: "file" },
                { path: path.join(directory, "CLAUDE.md"), type: "file" },
                { path: path.join(project, "packages", "AGENTS.md"), type: "file" },
                { path: path.join(project, "packages", "CLAUDE.md"), type: "file" },
                { path: projectFile, type: "file" },
                { path: path.join(project, "CLAUDE.md"), type: "file" },
                { path: sharedFile, type: "file" },
                { path: path.join(shared, "CLAUDE.md"), type: "file" },
                { path: path.join(home, "AGENTS.md"), type: "file" },
                { path: path.join(home, "CLAUDE.md"), type: "file" },
            ]);
            expect(yield* watcher.subscriptions()).not.toContainEqual({
                path: path.join(tmp.path, "AGENTS.md"),
                type: "file",
            });
            const initialized = yield* readInitial(yield* discovery.load());
            expect(initialized.text).toBe([
                `Instructions from: ${globalFile}\nglobal`,
                `Instructions from: ${packageFile}\npackage`,
                `Instructions from: ${projectFile}\nproject`,
                `Instructions from: ${sharedFile}\nshared`,
            ].join("\n\n"));
            expect(initialized.text).not.toContain("outside");
            yield* Effect.promise(() => fs.writeFile(packageFile, "changed"));
            yield* emitAndWait({ type: "update", path: packageFile });
            const changed = (yield* readUpdate(yield* discovery.load(), initialized)).text;
            expect(changed).toContain(`The instructions changed:\nInstructions from: ${packageFile}\nchanged`);
            expect(changed).not.toContain(`Instructions from: ${globalFile}\nglobal`);
            yield* Effect.promise(() => fs.rm(packageFile));
            yield* emitAndWait({ type: "delete", path: packageFile });
            const removed = (yield* readUpdate(yield* discovery.load(), initialized)).text;
            expect(removed).toContain(`The instructions from ${packageFile} no longer apply.`);
            expect(removed).not.toContain(`Instructions from: ${globalFile}\nglobal`);
            yield* Effect.promise(() => fs.rm(globalFile));
            yield* emitAndWait({ type: "delete", path: globalFile });
            yield* Effect.promise(() => fs.rm(projectFile));
            yield* emitAndWait({ type: "delete", path: projectFile });
            yield* Effect.promise(() => fs.rm(sharedFile));
            yield* emitAndWait({ type: "delete", path: sharedFile });
            expect((yield* readUpdate(yield* discovery.load(), initialized)).text).toBe("Previously loaded instructions no longer apply.");
        }).pipe(Effect.provide(instructionLayer({
            config: global,
            home,
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(project) }))),
        })));
    })));
    it.live("loads configured files, globs, home paths, and URLs alongside AGENTS.md", () => tmpdirScoped().pipe(Effect.flatMap((tmp) => {
        const project = path.join(tmp.path, "repo");
        const directory = path.join(project, "packages", "core");
        const agents = path.join(project, "AGENTS.md");
        const first = path.join(project, "rules", "a.md");
        const second = path.join(project, "rules", "b.md");
        const absolute = path.join(tmp.path, "absolute.md");
        const homeFile = path.join(tmp.path, "home.md");
        const noteTop = path.join(tmp.path, "notes", "guide.md");
        const noteNested = path.join(tmp.path, "notes", "projects", "memory.md");
        const remote = "https://example.test/instructions.md";
        const requests = [];
        return Effect.gen(function* () {
            yield* Effect.promise(async () => {
                await fs.mkdir(path.dirname(first), { recursive: true });
                await fs.mkdir(directory, { recursive: true });
                await fs.mkdir(path.dirname(noteNested), { recursive: true });
                await Promise.all([
                    fs.writeFile(agents, "agents"),
                    fs.writeFile(first, "first"),
                    fs.writeFile(second, "second"),
                    fs.writeFile(absolute, "absolute"),
                    fs.writeFile(homeFile, "home"),
                    fs.writeFile(noteTop, "note top"),
                    fs.writeFile(noteNested, "note nested"),
                ]);
            });
            const discovery = yield* start();
            const initialized = yield* readInitial(yield* discovery.load());
            // The unreachable URL and missing file are skipped without making AGENTS.md unavailable.
            expect(initialized.text).toBe([
                `Instructions from: ${agents}\nagents`,
                `Instructions from: ${first}\nfirst`,
                `Instructions from: ${second}\nsecond`,
                `Instructions from: ${absolute}\nabsolute`,
                `Instructions from: ${homeFile}\nhome`,
                `Instructions from: ${noteTop}\nnote top`,
                `Instructions from: ${noteNested}\nnote nested`,
                `Instructions from: ${remote}\nremote`,
            ].join("\n\n"));
            yield* Effect.promise(() => fs.writeFile(first, "changed"));
            yield* emitAndWait({ type: "update", path: first });
            expect((yield* readUpdate(yield* discovery.load(), initialized)).text).toBe(`The instructions changed:\nInstructions from: ${first}\nchanged`);
            // File rescans reuse fetched URLs instead of requesting them again.
            expect(requests).toHaveLength(2);
        }).pipe(Effect.provide(instructionLayer({
            config: path.join(tmp.path, "global"),
            home: tmp.path,
            instructions: [
                "rules/*.md",
                absolute,
                "~/home.md",
                "~/notes/**/*.md",
                remote,
                "missing.md",
                "https://example.test/missing.md",
            ],
            http: respond((url) => {
                requests.push(url);
                return url === remote ? new Response("remote") : new Response(null, { status: 404 });
            }),
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(project) }))),
        })));
    })));
    it.live("reloads configured sources on config updates and keeps the last fetched URL", () => tmpdirScoped().pipe(Effect.flatMap((tmp) => {
        const first = path.join(tmp.path, "first.md");
        const second = path.join(tmp.path, "second.md");
        const remote = "https://example.test/instructions.md";
        const responses = [new Response("remote"), new Response(null, { status: 500 })];
        return Effect.gen(function* () {
            yield* Effect.promise(async () => {
                await fs.writeFile(first, "first");
                await fs.writeFile(second, "second");
            });
            const events = yield* PubSub.unbounded();
            const config = yield* Config.Test;
            const discovery = yield* start(host({ event: { subscribe: () => Stream.fromPubSub(events) } }));
            const initialized = yield* readInitial(yield* discovery.load());
            expect(initialized.text).toBe([`Instructions from: ${first}\nfirst`, `Instructions from: ${remote}\nremote`].join("\n\n"));
            yield* config.setEntries([configured([second, remote])]);
            yield* triggerAndWait(PubSub.publish(events, configUpdated()).pipe(Effect.asVoid));
            expect((yield* readInitial(yield* discovery.load())).text).toBe([`Instructions from: ${second}\nsecond`, `Instructions from: ${remote}\nremote`].join("\n\n"));
        }).pipe(Effect.provide(instructionLayer({
            config: path.join(tmp.path, "global"),
            instructions: [first, remote],
            http: respond(() => responses.shift() ?? new Response(null, { status: 500 })),
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        })));
    })));
    it.live("skips remote instruction bodies over the size cap", () => Effect.acquireRelease(Effect.promise(() => tmpdir()), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(Effect.flatMap((tmp) => {
        const local = path.join(tmp.path, "local.md");
        const small = "https://example.test/small.md";
        const declared = "https://example.test/declared.md";
        const streamed = "https://example.test/streamed.md";
        const over = "x".repeat(ConfigInstructionPlugin.maxRemoteInstructionBytes + 1);
        return Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(local, "local"));
            const discovery = yield* start();
            const initialized = yield* readInitial(yield* discovery.load());
            // Both over-cap remotes are skipped; the local file and small remote load intact.
            expect(initialized.text).toBe([`Instructions from: ${local}\nlocal`, `Instructions from: ${small}\nsmall`].join("\n\n"));
        }).pipe(Effect.provide(instructionLayer({
            config: path.join(tmp.path, "global"),
            instructions: [local, small, declared, streamed],
            http: respond((url) => {
                if (url === small)
                    return new Response("small");
                if (url === declared)
                    return new Response(over, { headers: { "content-length": String(over.length) } });
                const chunk = new TextEncoder().encode("x".repeat(8192));
                let pulled = 0;
                return new Response(new ReadableStream({
                    pull(controller) {
                        pulled += 1;
                        if (pulled <= 40)
                            controller.enqueue(chunk);
                        else
                            controller.close();
                    },
                }), { headers: { "content-type": "text/plain" } });
            }),
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        })));
    })));
    it.live("follows same-origin and public cross-origin redirects for remote instructions", () => Effect.acquireRelease(Effect.promise(() => tmpdir()), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(Effect.flatMap((tmp) => {
        const sameOriginStart = "https://example.test/start.md";
        const sameOriginFinal = "https://example.test/final.md";
        const crossOriginStart = "https://a.example.test/start.md";
        const crossOriginFinal = "https://b.example.test/final.md";
        const requests = [];
        return Effect.gen(function* () {
            const discovery = yield* start();
            const initialized = yield* readInitial(yield* discovery.load());
            expect(initialized.text).toBe([
                `Instructions from: ${sameOriginStart}\nsame-origin`,
                `Instructions from: ${crossOriginStart}\ncross-origin`,
            ].join("\n\n"));
            expect([...requests].sort()).toEqual([sameOriginStart, sameOriginFinal, crossOriginStart, crossOriginFinal].sort());
        }).pipe(Effect.provide(instructionLayer({
            config: path.join(tmp.path, "global"),
            instructions: [sameOriginStart, crossOriginStart],
            http: respond((url) => {
                requests.push(url);
                if (url === sameOriginStart)
                    return new Response(null, { status: 302, headers: { location: "/final.md" } });
                if (url === sameOriginFinal)
                    return new Response("same-origin");
                if (url === crossOriginStart)
                    return new Response(null, { status: 302, headers: { location: crossOriginFinal } });
                if (url === crossOriginFinal)
                    return new Response("cross-origin");
                return new Response(null, { status: 404 });
            }),
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        })));
    })));
    it.live("does not follow a redirect from a public instruction URL to a local destination", () => Effect.acquireRelease(Effect.promise(() => tmpdir()), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(Effect.flatMap((tmp) => {
        const local = path.join(tmp.path, "local.md");
        const startUrl = "https://example.test/start.md";
        const secret = "http://127.0.0.1:65535/secret.md";
        const requests = [];
        return Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(local, "local"));
            const discovery = yield* start();
            const initialized = yield* readInitial(yield* discovery.load());
            // The local/private destination is never requested and its body is
            // not loaded as instructions; the local file still loads.
            expect(initialized.text).toBe(`Instructions from: ${local}\nlocal`);
            expect(requests).toEqual([startUrl]);
        }).pipe(Effect.provide(instructionLayer({
            config: path.join(tmp.path, "global"),
            instructions: [local, startUrl],
            http: respond((url) => {
                requests.push(url);
                if (url === startUrl)
                    return new Response(null, { status: 302, headers: { location: secret } });
                if (url === secret)
                    return new Response("secret");
                return new Response(null, { status: 404 });
            }),
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        })));
    })));
    it.live("fails closed on malformed and unsupported redirect locations", () => Effect.acquireRelease(Effect.promise(() => tmpdir()), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(Effect.flatMap((tmp) => {
        const local = path.join(tmp.path, "local.md");
        const malformed = "https://example.test/malformed.md";
        const scheme = "https://example.test/scheme.md";
        const requests = [];
        return Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(local, "local"));
            const discovery = yield* start();
            const initialized = yield* readInitial(yield* discovery.load());
            expect(initialized.text).toBe(`Instructions from: ${local}\nlocal`);
            expect([...requests].sort()).toEqual([malformed, scheme].sort());
        }).pipe(Effect.provide(instructionLayer({
            config: path.join(tmp.path, "global"),
            instructions: [local, malformed, scheme],
            http: respond((url) => {
                requests.push(url);
                if (url === malformed)
                    return new Response(null, { status: 302, headers: { location: "http://[::1" } });
                if (url === scheme)
                    return new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } });
                return new Response(null, { status: 404 });
            }),
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        })));
    })));
    it.live("bounds remote instruction redirect loops", () => Effect.acquireRelease(Effect.promise(() => tmpdir()), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(Effect.flatMap((tmp) => {
        const local = path.join(tmp.path, "local.md");
        const a = "https://example.test/a.md";
        const b = "https://example.test/b.md";
        const requests = [];
        return Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(local, "local"));
            const discovery = yield* start();
            const initialized = yield* readInitial(yield* discovery.load());
            expect(initialized.text).toBe(`Instructions from: ${local}\nlocal`);
            // Initial request plus exactly the bounded number of followed hops.
            expect(requests).toEqual([a, b, a, b, a, b].slice(0, 1 + ConfigInstructionPlugin.maxRemoteInstructionRedirects));
        }).pipe(Effect.provide(instructionLayer({
            config: path.join(tmp.path, "global"),
            instructions: [local, a],
            http: respond((url) => {
                requests.push(url);
                if (url === a)
                    return new Response(null, { status: 302, headers: { location: b } });
                if (url === b)
                    return new Response(null, { status: 302, headers: { location: a } });
                return new Response(null, { status: 404 });
            }),
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        })));
    })));
    it.live("follows redirects for a deliberately configured local instruction source", () => Effect.acquireRelease(Effect.promise(() => tmpdir()), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(Effect.flatMap((tmp) => {
        const startLocal = "http://127.0.0.1:4011/start.md";
        const finalLocal = "http://127.0.0.1:4022/final.md";
        const requests = [];
        return Effect.gen(function* () {
            const discovery = yield* start();
            const initialized = yield* readInitial(yield* discovery.load());
            // The configured URL is an explicit user choice: a local source
            // redirecting within the local network stays usable (the policy
            // on resolveInstructionRedirect).
            expect(initialized.text).toBe(`Instructions from: ${startLocal}\nlocal-remote`);
            expect(requests).toEqual([startLocal, finalLocal]);
        }).pipe(Effect.provide(instructionLayer({
            config: path.join(tmp.path, "global"),
            instructions: [startLocal],
            http: respond((url) => {
                requests.push(url);
                if (url === startLocal)
                    return new Response(null, { status: 302, headers: { location: finalLocal } });
                if (url === finalLocal)
                    return new Response("local-remote");
                return new Response(null, { status: 404 });
            }),
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        })));
    })));
    test("resolveInstructionRedirect applies the documented trust policy", () => {
        const resolve = ConfigInstructionPlugin.resolveInstructionRedirect;
        // Allowed: same-origin relative, public cross-origin, public IP literal.
        expect(resolve("https://example.test/a.md", "/b.md")).toBe("https://example.test/b.md");
        expect(resolve("https://a.example.test/a.md", "https://b.example.test/b.md")).toBe("https://b.example.test/b.md");
        expect(resolve("https://example.test/a.md", "https://1.1.1.1/b.md")).toBe("https://1.1.1.1/b.md");
        // Allowed: http sources keep redirecting to http, and may upgrade to https.
        expect(resolve("http://example.test/a.md", "http://example.test/b.md")).toBe("http://example.test/b.md");
        expect(resolve("http://example.test/a.md", "https://example.test/b.md")).toBe("https://example.test/b.md");
        expect(resolve("http://a.example.test/a.md", "http://b.example.test/b.md")).toBe("http://b.example.test/b.md");
        // Blocked: an https source downgrading to http, same-host or cross-host.
        expect(() => resolve("https://example.test/a.md", "http://example.test/b.md")).toThrow("https to http");
        expect(() => resolve("https://a.example.test/a.md", "http://b.example.test/b.md")).toThrow("https to http");
        expect(() => resolve("https://example.test/a.md", "http://1.1.1.1/b.md")).toThrow("https to http");
        // Allowed: a deliberately configured local source may redirect within the local network.
        expect(resolve("http://127.0.0.1:4011/a.md", "http://127.0.0.1:4022/b.md")).toBe("http://127.0.0.1:4022/b.md");
        expect(resolve("http://localhost:4011/a.md", "/b.md")).toBe("http://localhost:4011/b.md");
        // Blocked: a public origin redirecting into the local network, in every local/private shape.
        for (const location of [
            "http://127.0.0.1:9999/secret.md",
            "http://localhost:9999/secret.md",
            "http://10.0.0.5/secret.md",
            "http://172.16.0.5/secret.md",
            "http://192.168.1.5/secret.md",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/secret.md",
            "http://[fe80::1]/secret.md",
            "http://[fd00::1]/secret.md",
            "http://[::ffff:127.0.0.1]/secret.md",
            "http://[64:ff9b::7f00:1]/secret.md",
            "http://[::7f00:1]/secret.md",
            "http://[::127.0.0.1]/secret.md",
            "http://[::a00:5]/secret.md",
            "http://0.0.0.0/secret.md",
        ])
            expect(() => resolve("https://example.test/a.md", location)).toThrow("local or private");
        // Fail closed: malformed location, unsupported scheme.
        expect(() => resolve("https://example.test/a.md", "http://[::1")).toThrow("invalid");
        expect(() => resolve("https://example.test/a.md", "file:///etc/passwd")).toThrow("unsupported protocol");
    });
    test("isLocalOrPrivateHost classifies IP literals and the localhost family", () => {
        const local = ConfigInstructionPlugin.isLocalOrPrivateHost;
        for (const host of [
            "localhost",
            "foo.localhost",
            "127.0.0.1",
            "10.1.2.3",
            "172.31.255.255",
            "192.168.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "0.0.0.0",
            "[::1]",
            "[fe80::1]",
            "[fd00::1]",
            // Embedded IPv4: mapped, NAT64 and IPv4-compatible forms of private addresses.
            "[::ffff:127.0.0.1]",
            "[::ffff:a00:1]",
            "[64:ff9b::7f00:1]",
            "[64:ff9b::10.0.0.1]",
            "[::7f00:1]",
            "[::127.0.0.1]",
            "[::a9fe:a9fe]",
            "[::192.168.0.1]",
        ])
            expect(local(host)).toBe(true);
        for (const host of [
            "example.com",
            "example.test",
            "1.1.1.1",
            "172.32.0.1",
            "100.128.0.1",
            "[2606:4700:4700::1111]",
            // Embedded IPv4: mapped, NAT64 and IPv4-compatible forms of a public address stay public.
            "[::ffff:1.1.1.1]",
            "[64:ff9b::101:101]",
            "[::101:101]",
            "[::8.8.8.8]",
        ])
            expect(local(host)).toBe(false);
    });
    it.live("falls back to CLAUDE.md where no AGENTS.md exists", () => tmpdirScoped().pipe(Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global");
        const home = path.join(tmp.path, "home");
        const project = path.join(home, "repo");
        const directory = path.join(project, "packages", "core");
        const claudeGlobal = path.join(home, ".claude", "CLAUDE.md");
        const projectAgents = path.join(project, "AGENTS.md");
        const packageClaude = path.join(directory, "CLAUDE.md");
        const load = (claude) => Effect.gen(function* () {
            const discovery = yield* start();
            return (yield* readInitial(yield* discovery.load())).text;
        }).pipe(Effect.provide(layer(claude)), Effect.scoped);
        const layer = (claude) => instructionLayer({
            config: global,
            home,
            claude,
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(project) }))),
        });
        return Effect.gen(function* () {
            yield* Effect.promise(async () => {
                await fs.mkdir(path.dirname(claudeGlobal), { recursive: true });
                await fs.mkdir(directory, { recursive: true });
                await fs.writeFile(claudeGlobal, "claude global");
                await fs.writeFile(projectAgents, "project agents");
                await fs.writeFile(path.join(project, "CLAUDE.md"), "project claude");
                await fs.writeFile(packageClaude, "package claude");
            });
            expect(yield* load()).toBe([
                `Instructions from: ${claudeGlobal}\nclaude global`,
                `Instructions from: ${packageClaude}\npackage claude`,
                `Instructions from: ${projectAgents}\nproject agents`,
            ].join("\n\n"));
            yield* Effect.promise(async () => {
                await fs.mkdir(global, { recursive: true });
                await fs.writeFile(path.join(global, "AGENTS.md"), "global agents");
            });
            const preferred = yield* load();
            expect(preferred).toContain(`Instructions from: ${path.join(global, "AGENTS.md")}\nglobal agents`);
            expect(preferred).not.toContain("claude global");
            const disabled = yield* load(false);
            expect(disabled).not.toContain("CLAUDE.md");
            expect(disabled).toContain(`Instructions from: ${projectAgents}\nproject agents`);
        });
    })));
    it.live("keeps an empty AGENTS.md as available context", () => tmpdirScoped().pipe(Effect.flatMap((tmp) => Effect.gen(function* () {
        const file = path.join(tmp.path, "AGENTS.md");
        yield* Effect.promise(() => fs.writeFile(file, ""));
        const discovery = yield* start();
        expect((yield* readInitial(yield* discovery.load())).text).toBe(`Instructions from: ${file}\n`);
    }).pipe(Effect.provide(instructionLayer({
        config: path.join(tmp.path, "global"),
        locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
    }))))));
    it.live("discovers a newly created instruction file above the project root", () => tmpdirScoped().pipe(Effect.flatMap((tmp) => {
        const home = path.join(tmp.path, "home");
        const shared = path.join(home, "code");
        const project = path.join(shared, "repo");
        const intermediate = path.join(shared, "AGENTS.md");
        const directory = path.join(project, "core");
        const projectFile = path.join(project, "AGENTS.md");
        return Effect.gen(function* () {
            yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }));
            yield* Effect.promise(() => fs.writeFile(projectFile, "project"));
            const discovery = yield* start();
            expect((yield* readInitial(yield* discovery.load())).text).toBe(`Instructions from: ${projectFile}\nproject`);
            yield* Effect.promise(() => fs.writeFile(intermediate, "intermediate"));
            yield* emitAndWait({ type: "create", path: intermediate });
            expect((yield* readInitial(yield* discovery.load())).text).toBe([`Instructions from: ${projectFile}\nproject`, `Instructions from: ${intermediate}\nintermediate`].join("\n\n"));
        }).pipe(Effect.provide(instructionLayer({
            config: path.join(tmp.path, "global"),
            home,
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(project) }))),
        })));
    })));
    it.live("stops instruction candidates at the project root outside home", () => tmpdirScoped().pipe(Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global");
        const home = path.join(tmp.path, "home");
        const project = path.join(tmp.path, "scratch", "repo");
        const directory = path.join(project, "packages", "core");
        return Effect.gen(function* () {
            yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }));
            yield* start();
            const watcher = yield* Watcher.Test;
            expect(yield* watcher.subscriptions()).toEqual([
                { path: path.join(global, "AGENTS.md"), type: "file" },
                { path: path.join(home, ".claude", "CLAUDE.md"), type: "file" },
                { path: path.join(directory, "AGENTS.md"), type: "file" },
                { path: path.join(directory, "CLAUDE.md"), type: "file" },
                { path: path.join(project, "packages", "AGENTS.md"), type: "file" },
                { path: path.join(project, "packages", "CLAUDE.md"), type: "file" },
                { path: path.join(project, "AGENTS.md"), type: "file" },
                { path: path.join(project, "CLAUDE.md"), type: "file" },
            ]);
        }).pipe(Effect.provide(instructionLayer({
            config: global,
            home,
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(project) }))),
        })));
    })));
    (process.platform === "win32" ? it.live : it.live.skip)("stops at the project root when the location drive letter differs in case", () => tmpdirScoped().pipe(Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global");
        const home = path.join(tmp.path, "home");
        const project = path.join(tmp.path, "repo");
        const directory = project[0].toLowerCase() + project.slice(1);
        return Effect.gen(function* () {
            yield* Effect.promise(() => fs.mkdir(project, { recursive: true }));
            yield* Effect.promise(() => fs.writeFile(path.join(project, "AGENTS.md"), "project"));
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "AGENTS.md"), "outside"));
            const discovery = yield* start();
            const watcher = yield* Watcher.Test;
            expect(yield* watcher.subscriptions()).toEqual([
                { path: path.join(global, "AGENTS.md"), type: "file" },
                { path: path.join(home, ".claude", "CLAUDE.md"), type: "file" },
                { path: path.join(directory, "AGENTS.md"), type: "file" },
                { path: path.join(directory, "CLAUDE.md"), type: "file" },
            ]);
            expect((yield* readInitial(yield* discovery.load())).text).toBe(`Instructions from: ${path.join(directory, "AGENTS.md")}\nproject`);
        }).pipe(Effect.provide(instructionLayer({
            config: global,
            home,
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(project) }))),
        })));
    })));
    it.effect("isolates source failure without failing activation", () => {
        const failingFS = Layer.effect(FSUtil.Service, FSUtil.Service.pipe(Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.fail(new FSUtil.FileSystemError({ method: "up" })) })))).pipe(Layer.provide(LayerNode.compile(FSUtil.node)));
        return Effect.gen(function* () {
            const discovery = yield* start();
            expect((yield* readUpdate(yield* discovery.load(), state({ "core/instructions": [{ path: "/repo/AGENTS.md", content: "old" }] }))).changed).toBe(false);
        }).pipe(Effect.provide(instructionLayer({
            filesystemLayer: failingFS,
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/repo") }))),
        })));
    });
    it.effect("marks a discovered file that disappears before read as unavailable", () => {
        const discovered = AbsolutePath.make("/repo/AGENTS.md");
        const racingFS = Layer.effect(FSUtil.Service, FSUtil.Service.pipe(Effect.map((fs) => FSUtil.Service.of({
            ...fs,
            up: () => Effect.succeed([discovered]),
            readFileString: (file) => Effect.fail(readFailure("NotFound", "ENOENT", file)),
        })))).pipe(Layer.provide(LayerNode.compile(FSUtil.node)));
        return Effect.gen(function* () {
            const discovery = yield* start();
            expect((yield* readUpdate(yield* discovery.load(), state({ "core/instructions": [{ path: discovered, content: "old" }] }))).changed).toBe(false);
        }).pipe(Effect.provide(instructionLayer({
            filesystemLayer: racingFS,
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/repo") }))),
        })));
    });
    it.effect("skips discovered files a sandbox denies and keeps the rest available", () => {
        const denied = path.resolve("/repo/AGENTS.md");
        const readable = path.resolve("/repo/packages/AGENTS.md");
        const sandboxedFS = Layer.effect(FSUtil.Service, FSUtil.Service.pipe(Effect.map((fs) => FSUtil.Service.of({
            ...fs,
            up: () => Effect.succeed([readable, denied]),
            readFileString: (file) => file === denied ? Effect.fail(readFailure("Unknown", "EPERM", file)) : Effect.succeed("package"),
        })))).pipe(Layer.provide(LayerNode.compile(FSUtil.node)));
        return Effect.gen(function* () {
            const discovery = yield* start();
            expect((yield* readInitial(yield* discovery.load())).text).toBe(`Instructions from: ${readable}\npackage`);
        }).pipe(Effect.provide(instructionLayer({
            filesystemLayer: sandboxedFS,
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/repo/packages") }))),
        })));
    });
    it.effect("canonicalizes boundaries and honors project opt-out", () => Effect.gen(function* () {
        const observed = { values: [] };
        const observingFS = Layer.effect(FSUtil.Service, FSUtil.Service.pipe(Effect.map((fs) => FSUtil.Service.of({
            ...fs,
            up: (options) => Effect.sync(() => (observed.values.push(options), [])),
        })))).pipe(Layer.provide(LayerNode.compile(FSUtil.node)));
        yield* start().pipe(Effect.provide(instructionLayer({
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/repo/") }, { projectDirectory: AbsolutePath.make("/repo") }))),
        })));
        yield* start().pipe(Effect.provide(instructionLayer({
            filesystemLayer: observingFS,
            project: false,
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/repo") }))),
        })));
        yield* start().pipe(Effect.provide(instructionLayer({
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/outside") }, { projectDirectory: AbsolutePath.make("/repo") }))),
        })));
        const repo = path.resolve("/repo");
        expect(observed.values).toEqual([{ targets: ["AGENTS.md", "CLAUDE.md"], start: repo, stop: repo, type: "file" }]);
    }));
});
