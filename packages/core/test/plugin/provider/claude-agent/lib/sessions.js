import * as TestSessions_1 from "./sessions";
export { TestSessions_1 as TestSessions };
import { Effect } from "effect";
import { ClaudeAccounts } from "@opencode/core/plugin/provider/claude-agent/claude/accounts";
import { ClaudeQueryOptions } from "@opencode/core/plugin/provider/claude-agent/claude/query-options";
import { ClaudeSessions } from "@opencode/core/plugin/provider/claude-agent/claude/sessions";
import { ClaudeStatus } from "@opencode/core/plugin/provider/claude-agent/claude/status";
import { ClaudeAgentLanguageModel } from "@opencode/core/plugin/provider/claude-agent/language-model/claude-agent-language-model";
import { RequestKind } from "@opencode/core/plugin/provider/claude-agent/language-model/request-kind";
import { FakeIO } from "./fake-io";
export function storage() {
    const data = new Map();
    return {
        data,
        get: (key) => Effect.sync(() => data.get(key)),
        set: (key, value) => Effect.sync(() => {
            data.set(key, value);
        }),
        remove: (key) => Effect.sync(() => {
            data.delete(key);
        }),
        scan: (options) => Effect.sync(() => ({
            entries: [...data.keys()].filter((key) => key.startsWith(options.prefix)).map((key) => ({ key })),
        })),
    };
}
export function prompt(text) {
    return [
        { role: "system", content: "You are a concise test assistant." },
        { role: "user", content: [{ type: "text", text }] },
    ];
}
export function followup(text = "What was the marker? Reply only with it.") {
    return [
        ...prompt("Remember the marker COPPER-OTTER. Reply only with that marker."),
        { role: "assistant", content: [{ type: "text", text: "COPPER-OTTER" }] },
        { role: "user", content: [{ type: "text", text }] },
    ];
}
export const model = (sessions, settings) => build((request) => sessions.run(request), settings);
export const rotating = (accounts, settings) => {
    const configDirs = ClaudeQueryOptions.configDirs(settings?.configDir);
    return build((request) => accounts.run(request, configDirs), settings);
};
const build = Effect.fn(function* (run, settings) {
    const context = yield* Effect.context();
    return new ClaudeAgentLanguageModel.Model("haiku", { run: (request, signal) => Effect.runPromiseWith(context)(run(request), { signal }) }, ClaudeQueryOptions.connectionEnv({ settings }));
});
export const start = Effect.fn(function* (claude, saved = storage(), settings) {
    const registry = ClaudeSessions.registry();
    yield* Effect.addFinalizer(() => registry.close());
    const io = FakeIO.make({ claude });
    const input = {
        io,
        status: yield* ClaudeStatus.make(io, () => Effect.succeed(ClaudeQueryOptions.connectionEnv({ settings })), () => Effect.succeed(ClaudeQueryOptions.configDirs(settings?.configDir))),
        storage: saved,
        directory: "/tmp/opencode",
    };
    const sessions = yield* registry.attach(input);
    const accounts = ClaudeAccounts.make({ sessions, storage: saved });
    return { registry, input, sessions, accounts, model: yield* rotating(accounts, settings), storage: saved };
});
export function stream(model, prompt, sessionID = "session-a", kind = "primary") {
    return Effect.promise(() => model.doStream({ prompt, headers: { [RequestKind.SESSION_HEADER]: sessionID, [RequestKind.HEADER]: kind } }));
}
export async function collect(stream) {
    const parts = [];
    for await (const part of stream)
        parts.push(part);
    return parts;
}
export function text(parts) {
    return parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("");
}
export const reply = Effect.fn(function* (model, prompt, sessionID = "session-a", kind = "primary") {
    const result = yield* stream(model, prompt, sessionID, kind);
    return yield* Effect.tryPromise(() => collect(result.stream));
});
