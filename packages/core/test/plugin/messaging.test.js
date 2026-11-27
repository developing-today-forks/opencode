import { describe, expect } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { define } from "@opencode/plugin/effect/plugin";
import { Plugin } from "@opencode/plugin";
import { PluginHost } from "@opencode/core/plugin/host";
import { PluginPromise } from "@opencode/core/plugin/promise";
import { testEffect } from "../lib/effect";
import { PluginTestLayer } from "./fixture";
const it = testEffect(PluginTestLayer);
const plugins = { list: () => Effect.succeed([]) };
describe("plugin messaging", () => {
    it.live("writes plugin-registered kinds that unregister with the plugin scope", () => Effect.gen(function* () {
        const ctx = yield* PluginHost.make(plugins, "messaging-kinds");
        const scope = yield* Scope.make();
        const plugin = define({
            id: "messaging-kinds",
            effect: (ctx) => ctx.messaging.kinds.register({ name: "vote", description: "A vote" }).pipe(Effect.orDie),
        });
        yield* plugin.effect(ctx).pipe(Scope.provide(scope));
        expect((yield* ctx.messaging.kinds.list()).map((kind) => kind.name)).toContain("vote");
        const sent = yield* ctx.messaging.write({ topic: "ballots", text: "yes", kind: "vote" });
        const votes = yield* ctx.messaging.query({ topics: [sent.topic], kinds: ["vote"] });
        expect(votes.messages.map((message) => [message.kind, message.data])).toEqual([["vote", "yes"]]);
        yield* Scope.close(scope, Exit.void);
        expect((yield* ctx.messaging.kinds.list()).map((kind) => kind.name)).not.toContain("vote");
        expect(yield* ctx.messaging.write({ topic: "ballots", text: "no", kind: "vote" }).pipe(Effect.flip)).toMatchObject({
            _tag: "Messaging.InvalidError",
        });
    }));
    it.live("adapts kinds and writes for Promise plugins", () => Effect.gen(function* () {
        const ctx = yield* PluginHost.make(plugins, "promise-messaging");
        const result = Promise.withResolvers();
        yield* PluginPromise.fromPromise(Plugin.define({
            id: "promise-messaging",
            async setup(ctx) {
                const registration = await ctx.messaging.kinds.register({ name: "poll", description: "A poll" });
                const sent = await ctx.messaging.write({ topic: "polls", text: "lunch?", kind: "poll" });
                const polls = await ctx.messaging.query({ topics: [sent.topic], kinds: ["poll"] });
                await registration.dispose();
                const kinds = await ctx.messaging.kinds.list();
                result.resolve([
                    ...polls.messages.map((message) => message.data),
                    String(kinds.some((kind) => kind.name === "poll")),
                ]);
            },
        })).effect(ctx);
        expect(yield* Effect.promise(() => result.promise)).toEqual(["lunch?", "false"]);
    }));
});
