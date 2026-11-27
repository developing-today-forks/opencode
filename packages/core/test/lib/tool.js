import { Agent } from "@opencode/core/agent";
import { CodeModeCatalog } from "@opencode/core/codemode/catalog";
import { Config } from "@opencode/core/config";
import { Image } from "@opencode/core/image";
import { Permission } from "@opencode/core/permission";
import { SessionMessage } from "@opencode/core/session/message";
import { toSessionError } from "@opencode/core/session/to-session-error";
import { Tool } from "@opencode/core/tool";
import { Effect } from "effect";
import { host } from "../plugin/host";
import { imagePassthrough } from "./image";
import { permissionLayer } from "./permission";
export const toolIdentity = {
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_tool_test"),
};
/** Replacements for tests that build `Tool.node` without a Location. */
export const toolNodeReplacements = (permission = permissionLayer()) => [
    Config.node.replace(Config.testLayer()),
    Image.node.replace(imagePassthrough),
    Permission.node.replace(permission),
];
export const toolDefinitions = (registry, permissions) => registry.snapshot(permissions).pipe(Effect.map((toolSet) => toolSet.definitions));
export const codeModeListings = (catalog) => CodeModeCatalog.summarize(catalog, { budget: Infinity }).namespaces.flatMap((namespace) => namespace.entries);
export function waitForTool(registry, name, remaining = 1000) {
    return Effect.gen(function* () {
        if ((yield* toolDefinitions(registry)).some((tool) => tool.name === name))
            return;
        if (remaining === 0) {
            yield* Effect.fail(new Error(`Timed out waiting for tool: ${name}`));
            return;
        }
        yield* Effect.promise(() => Bun.sleep(1));
        yield* waitForTool(registry, name, remaining - 1);
    });
}
/**
 * Registers a core tool plugin's tools against the real registry without booting the
 * full plugin host. Only the tool domain is live; focused tool tests exercise
 * registration, snapshots, and execution through the same path production uses.
 */
export const registerToolPlugin = (plugin, overrides = {}, hook) => Effect.gen(function* () {
    const tools = yield* Tool.Service;
    const context = host({
        ...overrides,
        session: {
            ...overrides.session,
            hook: overrides.session?.hook ?? (() => Effect.succeed({ dispose: Effect.void })),
        },
        tool: {
            transform: tools.transform,
            reload: tools.reload,
            list: tools.list,
            hook: hook ?? (() => Effect.die("registerToolPlugin does not support tool hooks")),
        },
    });
    yield* plugin.effect(context);
});
export const executeTool = (registry, input, options) => registry.snapshot(undefined, options).pipe(Effect.flatMap((tools) => tools.execute(input)), Effect.map((result) => ({ status: "completed", ...result })), Effect.catchTag("Tool.Error", (error) => Effect.succeed({ status: "error", error: toSessionError(error) })));
