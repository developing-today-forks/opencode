import { test } from "bun:test";
import { Context, Effect, Layer } from "effect";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node";
class A extends Context.Service()("test/LayerNodeA") {
}
class B extends Context.Service()("test/LayerNodeB") {
}
class C extends Context.Service()("test/LayerNodeC") {
}
class LayerError {
    _tag = "LayerError";
}
class OtherError {
    _tag = "OtherError";
}
// Keep intentionally invalid expressions out of runtime execution.
const contracts = (tag, flag) => {
    const tags = LayerNode.tags({ app: [] });
    const make = tags.make("app");
    const aLayer = Layer.succeed(A, A.of({}));
    const bLayer = Layer.effect(B, Effect.as(A, B.of({})));
    const cLayer = Layer.effect(C, Effect.gen(function* () {
        yield* A;
        yield* B;
        return C.of({});
    }));
    const a = make({ service: A, layer: aLayer, deps: [] });
    const b = make({ service: B, layer: bLayer, deps: [a] });
    const c = make({ service: C, layer: cLayer, deps: [a, b] });
    const ab = make({ name: "a-and-b", layer: Layer.mergeAll(aLayer, Layer.succeed(B, {})), deps: [] });
    const failing = make({ service: A, layer: Layer.effect(A, Effect.fail(new LayerError())), deps: [] });
    const dependent = make({ service: B, layer: bLayer, deps: [failing] });
    const inputA = LayerNode.unbound(A, tags.values.app);
    const group = LayerNode.group([a, b]);
    make({ name: "manual-a", layer: aLayer, deps: [] });
    // @ts-expect-error A node must have a service or name
    make({ layer: aLayer, deps: [] });
    // @ts-expect-error Service and name are mutually exclusive
    make({ service: A, name: "a", layer: aLayer, deps: [] });
    // @ts-expect-error An explicit tagged contract requires a corresponding runtime tag
    LayerNode.make({ service: A, layer: aLayer, deps: [] });
    // @ts-expect-error B requires A
    make({ service: B, layer: bLayer, deps: [] });
    // @ts-expect-error C requires A and B
    make({ service: C, layer: cLayer, deps: [a] });
    const erasedLayer = bLayer;
    // @ts-expect-error Erasing a Layer's contract cannot hide its inputs and errors
    make({ service: B, layer: erasedLayer, deps: [] });
    LayerNode.compile(c);
    LayerNode.compile(dependent);
    LayerNode.compile(group);
    LayerNode.compile(LayerNode.group([]));
    // @ts-expect-error An empty graph cannot supply arbitrary services
    LayerNode.compile(LayerNode.group([]));
    LayerNode.compile(inputA, { replacements: [inputA.replace(a)] });
    // @ts-expect-error A is a private dependency, not a root output
    LayerNode.compile(c);
    // @ts-expect-error Dependency failures are not erased
    LayerNode.compile(dependent);
    const replacements = [a.replace(aLayer), a.replace(ab), failing.replace(a)];
    const replacement = a.replace(Layer.mergeAll(aLayer, Layer.succeed(B, {})));
    LayerNode.compile(a, { replacements: [...replacements, replacement] });
    inputA.replace(a);
    a.replace(a);
    // @ts-expect-error Closed layer replacements must provide every source output
    ab.replace(aLayer);
    // @ts-expect-error Node replacements must provide every source output
    ab.replace(a);
    // @ts-expect-error Replacement must provide A
    a.replace(Layer.succeed(B, {}));
    // @ts-expect-error Node replacement must provide A
    a.replace(b);
    // @ts-expect-error Raw layers with inputs are not closed
    a.replace(Layer.effect(A, Effect.as(B, A.of({}))));
    // @ts-expect-error Replacement cannot introduce a new error
    a.replace(Layer.effect(A, Effect.fail(new OtherError())));
    // @ts-expect-error Node replacement cannot introduce a new error
    a.replace(failing);
    // @ts-expect-error Existing errors do not authorize unrelated replacement errors
    failing.replace(Layer.effect(A, Effect.fail(new OtherError())));
    // @ts-expect-error Every alternative of a node replacement must supply A
    a.replace(flag ? a : b);
    // @ts-expect-error Every alternative of a raw-layer replacement must supply A
    a.replace(flag ? aLayer : Layer.succeed(B, {}));
    // @ts-expect-error A valid alternative cannot hide a new error in another alternative
    a.replace(flag ? a : failing);
    a.replace(flag ? a : ab);
    failing.replace(flag ? a : failing);
    // @ts-expect-error Storing replacements must not erase their validation
    const invalidStored = [a.replace(b)];
    // @ts-expect-error Raw tuples cannot be stored as opaque replacements
    const rawStored = [[a, aLayer]];
    // @ts-expect-error Raw tuples cannot be supplied to compile
    LayerNode.compile(a, { replacements: [[a, aLayer]] });
    // @ts-expect-error Replacements are not structurally forgeable
    const forged = { source: a, target: a };
    // @ts-expect-error Groups are not replaceable nodes
    group.replace(a);
    // @ts-expect-error Groups cannot be replacement targets
    a.replace(group);
    // @ts-expect-error Groups cannot be widened to nodes
    const groupNode = group;
    // @ts-expect-error Graphs are opaque
    const forgedGraph = { name: "a" };
    const aContract = a;
    aContract.replace(aLayer);
    // @ts-expect-error A method cannot be rebound to a declaration with a stronger contract
    a.replace.call(ab, aLayer);
    const detached = a.replace;
    // @ts-expect-error Replacement authority requires its checked receiver
    detached(aLayer);
    // @ts-expect-error Output narrowing cannot forget B before replacement
    const narrowedOutput = ab;
    // @ts-expect-error Output widening cannot add B before replacement
    const widenedOutput = a;
    // @ts-expect-error Error widening cannot authorize a new replacement error
    const widenedError = a;
    // @ts-expect-error Error narrowing cannot forget an existing failure
    const narrowedError = failing;
    // @ts-expect-error Tag widening cannot authorize replacement across tags
    const widenedTag = a;
    const unionTag = LayerNode.unbound(A, tag);
    // @ts-expect-error Tag narrowing cannot forget a possible tag
    const narrowedTag = unionTag;
    const outputProjection = group;
    // @ts-expect-error Graph output projection cannot invent a service
    const widenedGraph = a;
    // @ts-expect-error A projected Graph has no replacement authority
    outputProjection.replace(aLayer);
    const choice = flag ? a : b;
    // @ts-expect-error Choosing one dependency does not provide both services
    make({ service: C, layer: cLayer, deps: [choice] });
    // @ts-expect-error A conditional root promises only outputs present in every alternative
    LayerNode.compile(LayerNode.group([choice]));
    const conditional = make({ name: "conditional", layer: flag ? aLayer : Layer.succeed(B, {}), deps: [] });
    LayerNode.compile(conditional);
    // @ts-expect-error A conditional implementation does not acquire both branches
    LayerNode.compile(conditional);
    LayerNode.compile(LayerNode.group([flag ? a : ab]));
    const dynamic = [];
    // @ts-expect-error An unbounded array may contain no roots
    LayerNode.compile(LayerNode.group(dynamic));
    const decorated = b.mapLayer((layer) => layer.pipe(Layer.tap(() => Effect.void)));
    LayerNode.compile(decorated);
    b.replace(decorated);
    // @ts-expect-error A layer mapper cannot be rebound to a weaker declaration
    ab.mapLayer.call(a, (layer) => layer);
    // @ts-expect-error mapLayer cannot add an input requirement
    b.mapLayer((layer) => layer.pipe(Layer.tap(() => C)));
    // @ts-expect-error mapLayer cannot grow the error channel
    b.mapLayer((layer) => layer.pipe(Layer.tap(() => Effect.fail(new OtherError()))));
    // @ts-expect-error mapLayer cannot drop an output
    ab.mapLayer(() => aLayer);
    // @ts-expect-error Unbound declarations have no implementation to map
    inputA.mapLayer((layer) => layer);
    const scopedTags = LayerNode.tags({ request: ["global"], global: [] });
    const request = scopedTags.make("request");
    const global = scopedTags.make("global");
    const globalA = global({ service: A, layer: aLayer, deps: [] });
    const requestA = request({ service: A, layer: aLayer, deps: [] });
    const requestB = request({ service: B, layer: Layer.succeed(B, {}), deps: [] });
    request({ service: B, layer: bLayer, deps: [globalA] });
    request({ service: C, layer: cLayer, deps: [globalA, requestB] });
    request({ service: C, layer: cLayer, deps: [LayerNode.group([globalA, requestB])] });
    LayerNode.compile(LayerNode.group([globalA, requestB]), { shared: scopedTags.values.global });
    // @ts-expect-error Tag configuration can only reference declared tags
    LayerNode.tags({ request: ["missing"], global: [] });
    // @ts-expect-error Shared tags must be branded
    LayerNode.compile(globalA, { shared: "global" });
    // @ts-expect-error Replacement targets must keep the source tag
    globalA.replace(requestA);
    // @ts-expect-error Replacement targets must keep the source tag in either direction
    requestA.replace(globalA);
    // @ts-expect-error Every alternative must keep the source tag
    globalA.replace(flag ? globalA : requestA);
    // @ts-expect-error Providing only A leaves B missing
    request({ service: C, layer: cLayer, deps: [globalA] });
    // @ts-expect-error Providing only B leaves A missing
    request({ service: C, layer: cLayer, deps: [requestB] });
    // @ts-expect-error Duplicate A providers still leave B missing
    request({ service: C, layer: cLayer, deps: [globalA, requestA] });
    // @ts-expect-error A group with only A still leaves B missing
    request({ service: C, layer: cLayer, deps: [LayerNode.group([globalA])] });
    // @ts-expect-error Global cannot depend on request
    global({ service: B, layer: bLayer, deps: [requestA] });
    // @ts-expect-error Groups preserve their child tags
    global({ service: B, layer: bLayer, deps: [LayerNode.group([requestA])] });
    const globalScopedA = makeGlobalNode({ service: A, layer: aLayer, deps: [] });
    const locationScopedA = makeLocationNode({ service: A, layer: aLayer, deps: [] });
    makeGlobalNode({ service: B, layer: bLayer, deps: [globalScopedA] });
    makeLocationNode({ service: B, layer: bLayer, deps: [globalScopedA] });
    makeLocationNode({ service: B, layer: bLayer, deps: [locationScopedA] });
    // @ts-expect-error Global nodes cannot depend on location nodes
    makeGlobalNode({ service: B, layer: bLayer, deps: [locationScopedA] });
    // @ts-expect-error B requires A
    makeLocationNode({ service: B, layer: bLayer, deps: [] });
    void [
        invalidStored,
        rawStored,
        forged,
        groupNode,
        forgedGraph,
        narrowedOutput,
        widenedOutput,
        widenedError,
        narrowedError,
        widenedTag,
        narrowedTag,
        widenedGraph,
    ];
};
test("layer node type contracts compile", () => {
    void contracts;
});
