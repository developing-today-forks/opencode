import { describe, expect } from "bun:test";
import { Config } from "@opencode/core/config";
import { Document, Info } from "@opencode/schema/config";
import { Event } from "@opencode/schema/event";
import { Deferred, Effect, PubSub, Queue, Ref, Stream } from "effect";
import { ConfigEntryObserver } from "../../src/config/plugin/entry-observer";
import { it } from "../lib/effect";
import { host } from "../plugin/host";
describe("ConfigEntryObserver", () => {
    it.effect("closes the startup race and reloads later updates", () => Effect.gen(function* () {
        const current = yield* Ref.make([document("first")]);
        const updates = yield* PubSub.unbounded();
        const reloaded = yield* Deferred.make();
        const config = Config.Service.of({
            entries: () => Ref.get(current),
            reload: () => Effect.void,
            changes: () => Stream.empty,
        });
        const event = host({
            event: {
                subscribe: () => Stream.unwrap(Ref.set(current, [document("raced")]).pipe(Effect.as(Stream.fromPubSub(updates)))),
            },
        }).event;
        const loaded = yield* ConfigEntryObserver.observe(config, event, Deferred.succeed(reloaded, undefined).pipe(Effect.asVoid), ["shell"]);
        expect(Config.latest(loaded.entries, "shell")).toBe("raced");
        expect(yield* Deferred.isDone(reloaded)).toBe(false);
        yield* Ref.set(current, [document("later")]);
        yield* PubSub.publish(updates, updated());
        yield* Deferred.await(reloaded);
        expect(Config.latest(loaded.entries, "shell")).toBe("later");
    }));
    it.effect("refreshes entries on every update but reloads only for watched sections", () => Effect.gen(function* () {
        const current = yield* Ref.make([document("first", "build")]);
        const updates = yield* PubSub.unbounded();
        const reloads = yield* Queue.unbounded();
        const config = Config.Service.of({
            entries: () => Ref.get(current),
            reload: () => Effect.void,
            changes: () => Stream.empty,
        });
        const event = { subscribe: () => Stream.fromPubSub(updates) };
        const loaded = yield* ConfigEntryObserver.observe(config, event, Ref.get(current).pipe(Effect.flatMap((entries) => Queue.offer(reloads, Config.latest(entries, "shell") ?? "")), Effect.asVoid), ["shell"]);
        yield* Ref.set(current, [document("first", "plan")]);
        yield* PubSub.publish(updates, updated(["default_agent"]));
        yield* settle(() => Config.latest(loaded.entries, "default_agent") === "plan");
        yield* Ref.set(current, [document("second", "plan")]);
        yield* PubSub.publish(updates, updated(["shell"]));
        expect(yield* Queue.take(reloads)).toBe("second");
        expect(Config.latest(loaded.entries, "shell")).toBe("second");
        expect(Config.latest(loaded.entries, "default_agent")).toBe("plan");
    }));
    it.effect("reloads for the unattributed section whatever changed", () => Effect.gen(function* () {
        const current = yield* Ref.make([document("first", "build")]);
        const updates = yield* PubSub.unbounded();
        const reloaded = yield* Deferred.make();
        const config = Config.Service.of({
            entries: () => Ref.get(current),
            reload: () => Effect.void,
            changes: () => Stream.empty,
        });
        yield* ConfigEntryObserver.observe(config, { subscribe: () => Stream.fromPubSub(updates) }, Deferred.succeed(reloaded, undefined).pipe(Effect.asVoid), ["shell"]);
        yield* PubSub.publish(updates, updated(["*"]));
        yield* Deferred.await(reloaded);
    }));
});
const settle = (done) => Effect.suspend(() => (done() ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(settle(done)))));
function document(shell, defaultAgent = "build") {
    return new Document({ type: "document", info: new Info({ shell, default_agent: defaultAgent }) });
}
function updated(sections = ["*"]) {
    return {
        id: Event.ID.create(),
        created: Date.now(),
        type: "config.updated",
        data: { sections },
    };
}
