import { describe, expect } from "bun:test";
import { Bus } from "@opencode/core/bus";
import { Config } from "@opencode/core/config";
import { ConfigImagePlugin } from "@opencode/core/config/plugin/image";
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder";
import { Image } from "@opencode/core/image";
import { Plugin } from "@opencode/core/plugin";
import { PluginHost } from "@opencode/core/plugin/host";
import { Document, Event, Info } from "@opencode/schema/config";
import { Effect, Layer, Schema, Stream } from "effect";
import { waitUntil } from "../lib/eventually";
import { testEffect } from "../lib/effect";
import { PluginTestLayer } from "../plugin/fixture";
const it = testEffect(Layer.merge(PluginTestLayer, AppNodeBuilder.build(Image.node)));
const decode = Schema.decodeUnknownSync(Info);
const content = {
    uri: "file:///pixel.png",
    content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    encoding: "base64",
    mime: "image/png",
};
describe("ConfigImagePlugin.Plugin", () => {
    it.live("merges image limits and reloads changed config", () => Effect.gen(function* () {
        const image = yield* Image.Service;
        const bus = yield* Bus.Service;
        const config = yield* Config.Test;
        const plugins = yield* Plugin.Service;
        yield* ConfigImagePlugin.Plugin.effect(yield* PluginHost.make(plugins, "test"));
        expect(yield* limits(image)).toEqual({ maxWidth: 1200, maxHeight: 900, maxBytes: 1 });
        yield* config.setEntries([document({ auto_resize: false, max_width: 700, max_base64_bytes: 1 })]);
        yield* bus.publish(Event.Updated, { sections: ["*"] });
        yield* waitUntil(limits(image).pipe(Effect.map((current) => current.maxWidth === 700 && current.maxHeight === 2000 && current.maxBytes === 1)));
    }).pipe(Effect.provide(Config.testLayer([
        document({ auto_resize: false, max_width: 1200 }),
        document({ max_height: 900, max_base64_bytes: 1 }),
    ]))));
    it.live("refetches config after subscribing to updates", () => Effect.gen(function* () {
        const image = yield* Image.Service;
        const plugins = yield* Plugin.Service;
        let reads = 0;
        const config = Config.Service.of({
            entries: () => Effect.sync(() => [document({ max_width: reads++ === 0 ? 1200 : 700, max_base64_bytes: 1 })]),
            reload: () => Effect.void,
            changes: () => Stream.empty,
        });
        yield* ConfigImagePlugin.Plugin.effect(yield* PluginHost.make(plugins, "test")).pipe(Effect.provideService(Config.Service, config));
        expect(yield* limits(image)).toEqual({ maxWidth: 700, maxHeight: 2000, maxBytes: 1 });
    }));
});
function document(image) {
    return new Document({ type: "document", info: decode({ media: { image } }) });
}
const limits = Effect.fnUntraced(function* (image) {
    const error = yield* image.normalize("pixel.png", content).pipe(Effect.flip, Effect.orDie);
    if (error._tag !== "Image.SizeError")
        return yield* Effect.die(error);
    return { maxWidth: error.maxWidth, maxHeight: error.maxHeight, maxBytes: error.maxBytes };
});
