import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";
import { Location } from "@opencode/core/location";
import { Project } from "@opencode/core/project";
import { AbsolutePath } from "@opencode/core/schema";
import { SessionAffinity } from "@opencode/core/session/affinity";
import { SessionMessage } from "@opencode/core/session/message";
import { SessionSchema } from "@opencode/core/session/schema";
import { Money } from "@opencode/schema/money";
const info = (id, parentID, fork) => SessionSchema.Info.make({
    id: SessionSchema.ID.make(id),
    parentID: parentID ? SessionSchema.ID.make(parentID) : undefined,
    fork: fork
        ? {
            sessionID: SessionSchema.ID.make(fork),
            boundary: { type: "through", messageID: SessionMessage.ID.make("msg_affinity") },
        }
        : undefined,
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
});
const fixture = (sessions) => {
    const byID = new Map(sessions.map((session) => [session.id, session]));
    const state = { lookups: 0 };
    const lookup = (sessionID) => Effect.sync(() => {
        state.lookups++;
        return byID.get(sessionID);
    });
    return { state, lookup };
};
const resolve = (cache, session, lookup) => Effect.runPromise(SessionAffinity.resolveRoot(cache, session, lookup));
describe("SessionAffinity.resolveRoot", () => {
    test("a top-level session is its own root", async () => {
        const root = info("ses_root");
        const { state, lookup } = fixture([root]);
        expect(await resolve(SessionAffinity.rootCache(), root, lookup)).toBe(root.id);
        expect(state.lookups).toBe(0);
    });
    test("root, child and grandchild resolve to the same root, computed once per session", async () => {
        const root = info("ses_root");
        const child = info("ses_child", "ses_root");
        const grandchild = info("ses_grandchild", "ses_child");
        const { state, lookup } = fixture([root, child, grandchild]);
        const cache = SessionAffinity.rootCache();
        expect(await resolve(cache, grandchild, lookup)).toBe(root.id);
        expect(state.lookups).toBe(2);
        // The walk cached every session it visited, so resolving any of them
        // again reads nothing.
        expect(await resolve(cache, grandchild, lookup)).toBe(root.id);
        expect(await resolve(cache, child, lookup)).toBe(root.id);
        expect(await resolve(cache, root, lookup)).toBe(root.id);
        expect(state.lookups).toBe(2);
    });
    test("fork links continue the walk to the source session's root", async () => {
        const root = info("ses_root");
        const child = info("ses_child", "ses_root");
        const forked = info("ses_forked", undefined, "ses_child");
        const grandchild = info("ses_grandchild", "ses_forked");
        const { lookup } = fixture([root, child, forked, grandchild]);
        expect(await resolve(SessionAffinity.rootCache(), grandchild, lookup)).toBe(root.id);
    });
    test("a parent that cannot be read is itself the root", async () => {
        const child = info("ses_child", "ses_missing");
        const { lookup } = fixture([child]);
        expect(await resolve(SessionAffinity.rootCache(), child, lookup)).toBe(SessionSchema.ID.make("ses_missing"));
    });
    test("a parent cycle terminates at the repeated link", async () => {
        const a = info("ses_a", "ses_b");
        const b = info("ses_b", "ses_a");
        const { lookup } = fixture([a, b]);
        expect(await resolve(SessionAffinity.rootCache(), a, lookup)).toBe(a.id);
    });
});
