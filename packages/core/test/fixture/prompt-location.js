import { Bus } from "@opencode/core/bus";
import { Image } from "@opencode/core/image";
import { LocationServiceMap } from "@opencode/core/location-service-map";
import { Plugin } from "@opencode/core/plugin";
import { PluginHooks } from "@opencode/core/plugin/hooks";
import { Skill } from "@opencode/core/skill";
import { makeGlobalNode } from "@opencode/util/effect/app-node";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { Effect, Layer, LayerMap } from "effect";
// Plain-prompt unit fixtures use virtual directories.
export const promptLocationNode = makeGlobalNode({
    service: LocationServiceMap.Service,
    layer: Layer.effect(LocationServiceMap.Service, Effect.gen(function* () {
        const bus = yield* Bus.Service;
        return yield* LayerMap.make((_ref) => LayerNode.compile(LayerNode.group([PluginHooks.node, Image.node, Skill.node, Plugin.node]), {
            replacements: [
                Bus.node.replace(Layer.succeed(Bus.Service, bus)),
                Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
            ],
        }));
    })),
    deps: [Bus.node],
});
