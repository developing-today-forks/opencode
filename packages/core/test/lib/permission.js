import { Permission } from "@opencode/core/permission";
import { Effect, Layer } from "effect";
export const permissionLayer = (overrides = {}) => Layer.mock(Permission.Service, { close: Effect.void, nested: () => Effect.void, ...overrides });
export const permissionService = (overrides = {}) => Effect.runSync(Effect.gen(function* () {
    return yield* Permission.Service;
}).pipe(Effect.provide(permissionLayer(overrides))));
