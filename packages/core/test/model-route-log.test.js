import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Effect, Exit, Queue } from "effect";
import { TestConsole } from "effect/testing";
import { Database } from "@opencode/core/database/database";
import { ModelRoute } from "@opencode/core/model-route";
import { Permission } from "@opencode/core/permission";
import { ModelRouteLog } from "@opencode/core/model-route-log";
import { ModelRouteReview } from "@opencode/core/model-route-review";
import { ModelUsage } from "@opencode/core/model-usage";
import { AIError, AuthenticationError, QuotaExceededError, RateLimitError } from "@opencode/ai/effect";
import { RouteStatsTool } from "@opencode/core/tool/plugin/route-stats";
import { RouteUsageTool } from "@opencode/core/tool/plugin/route-usage";
import { RouteAttemptTable, RouteDecisionTable, RouteHealthTable } from "@opencode/core/model-route-log/sql";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { testEffect } from "./lib/effect";
import { withTempDir } from "./fixture/tmpdir";
const it = testEffect(LayerNode.compile(LayerNode.group([ModelRouteLog.node, Database.node])));
const attempt = (overrides) => ({
    time_started: 1000,
    time_ended: 2000,
    route_id: "luna",
    provider_id: "openai",
    model_id: "gpt-6-luna",
    outcome: "success",
    output_started: true,
    ...overrides,
});
describe("ModelRouteLog writer backlog (#2335)", () => {
    const decision = (time) => ({
        kind: "decision",
        row: {
            time,
            route_id: "luna",
            selection: "weighted",
            candidates: ["openai/gpt-6-luna"],
            chosen: "openai/gpt-6-luna",
            reason: "drawn",
        },
    });
    test("bounds pending events while the writer is stalled, drops newest, then drains in order", async () => {
        const backlog = await Effect.runPromise(ModelRouteLog.makeWriterBacklog(4));
        // Writer gated: nobody takes from the queue while 6 events are offered.
        const offered = [1, 2, 3, 4, 5, 6].map((time) => backlog.offer(decision(time)));
        expect(offered).toEqual([true, true, true, true, false, false]);
        expect(backlog.dropped()).toBe(2);
        expect(await Effect.runPromise(Queue.size(backlog.queue))).toBe(4);
        // Gate opens: the events that fit drain in FIFO order; the dropped newest never appear.
        const times = [];
        for (let i = 0; i < 4; i++) {
            const event = await Effect.runPromise(Queue.take(backlog.queue));
            times.push(event.kind === "decision" ? event.row.time : -1);
        }
        expect(times).toEqual([1, 2, 3, 4]);
        expect(await Effect.runPromise(Queue.size(backlog.queue))).toBe(0);
        // And the backlog accepts again after draining.
        expect(backlog.offer(decision(7))).toBe(true);
        expect(backlog.dropped()).toBe(2);
    });
    test("default backlog capacity is the documented bound", async () => {
        const backlog = await Effect.runPromise(ModelRouteLog.makeWriterBacklog());
        for (let time = 0; time < ModelRouteLog.maxPendingEvents; time++)
            backlog.offer(decision(time));
        expect(await Effect.runPromise(Queue.size(backlog.queue))).toBe(ModelRouteLog.maxPendingEvents);
        expect(backlog.offer(decision(ModelRouteLog.maxPendingEvents))).toBe(false);
        expect(backlog.dropped()).toBe(1);
    });
});
describe("ModelRouteLog", () => {
    it.live("persists decisions, attempts and health transitions asynchronously", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRouteLog.record({
            kind: "decision",
            row: {
                time: 1,
                route_id: "luna",
                selection: "weighted",
                candidates: ["openai/gpt-6-luna", "azure/gpt-6-luna"],
                chosen: "openai/gpt-6-luna",
                reason: "drawn",
            },
        });
        ModelRouteLog.record({ kind: "attempt", row: attempt({ first_token_ms: 100, response_ms: 900 }) });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                outcome: "failure",
                output_started: false,
                ...ModelRouteLog.failureFields({
                    _tag: "QuotaExceeded",
                    message: "You exceeded your current quota",
                    http: {
                        status: 429,
                        headers: {
                            "x-ratelimit-remaining-tokens": "0",
                            "retry-after": "60",
                            "set-cookie": "must-not-be-persisted",
                        },
                    },
                }),
            }),
        });
        ModelRouteLog.record({
            kind: "health",
            row: { time: 3, provider_id: "openai", model_id: "gpt-6-luna", kind: "cooldown-start", reason: "failure" },
        });
        yield* Effect.sleep("100 millis");
        expect(yield* db.select().from(RouteDecisionTable).all()).toHaveLength(1);
        expect(yield* db.select().from(RouteHealthTable).all()).toHaveLength(1);
        const attempts = yield* db.select().from(RouteAttemptTable).all();
        expect(attempts).toHaveLength(2);
        expect(attempts.find((row) => row.outcome === "failure")).toMatchObject({
            error_tag: "QuotaExceeded",
            error_status: 429,
            error_message: "You exceeded your current quota",
            quota: { headers: { "x-ratelimit-remaining-tokens": "0", "retry-after": "60" } },
        });
        const stats = yield* ModelRouteLog.targetStats(db, 0, "luna");
        expect(stats).toHaveLength(1);
        expect(stats[0]).toMatchObject({ attempts: 2, failures: 1, avgFirstTokenMs: 100 });
        expect(yield* ModelRouteLog.recentFailures(db, 0)).toHaveLength(1);
    }));
    it.live("counts content-policy rejections separately from failures", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRouteLog.record({ kind: "attempt", row: attempt({}) });
        for (let i = 0; i < 3; i++)
            ModelRouteLog.record({
                kind: "attempt",
                row: attempt({
                    outcome: "failure",
                    output_started: false,
                    ...ModelRouteLog.failureFields({ _tag: "ContentPolicy", message: "blocked by policy" }),
                }),
            });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                outcome: "failure",
                output_started: false,
                ...ModelRouteLog.failureFields({ _tag: "QuotaExceeded", message: "You exceeded your current quota" }),
            }),
        });
        yield* Effect.sleep("100 millis");
        const stats = yield* ModelRouteLog.targetStats(db, 0, "luna");
        expect(stats).toHaveLength(1);
        expect(stats[0]).toMatchObject({ attempts: 5, failures: 1, policyRejections: 3 });
        const hourly = yield* ModelRouteLog.hourlyStats(db, 0);
        expect(hourly).toHaveLength(1);
        expect(hourly[0]).toMatchObject({ attempts: 5, failures: 1, policyRejections: 3 });
        // The per-tag breakdown still sees the policy class by its own tag.
        const breakdown = yield* ModelRouteLog.errorBreakdown(db, 0);
        expect(breakdown.find((row) => row.tag === "ContentPolicy")?.count).toBe(3);
    }));
});
describe("per-pool history", () => {
    it.live("reads a pool's attempts and selections back for the review", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRouteLog.record({
            kind: "decision",
            row: {
                time: 1000,
                session_id: "ses_pool",
                route_id: "pool-cheap",
                selection: "weighted",
                candidates: ["openai/gpt-6-luna", "azure/gpt-6-luna"],
                chosen: "openai/gpt-6-luna",
                reason: "drawn",
                detail: {
                    weights: { "openai/gpt-6-luna": 3, "azure/gpt-6-luna": 1 },
                    excluded: [{ candidate: "azure/gpt-6-luna", reason: "cooldown-until:9000" }],
                },
            },
        });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({ route_id: "pool-cheap", session_id: "ses_pool", first_token_ms: 300, tokens_input: 4000 }),
        });
        ModelRouteLog.record({ kind: "attempt", row: attempt({ route_id: "pool-other", session_id: "ses_other" }) });
        yield* Effect.sleep("100 millis");
        const attempts = yield* ModelRouteLog.attemptRows(db, 0, "pool-cheap");
        expect(attempts).toEqual([
            expect.objectContaining({
                routeID: "pool-cheap",
                providerID: "openai",
                modelID: "gpt-6-luna",
                sessionID: "ses_pool",
                firstTokenMs: 300,
                tokensInput: 4000,
            }),
        ]);
        const decisions = yield* ModelRouteLog.decisionRows(db, 0, "pool-cheap");
        expect(decisions).toEqual([
            expect.objectContaining({
                routeID: "pool-cheap",
                selection: "weighted",
                candidates: ["openai/gpt-6-luna", "azure/gpt-6-luna"],
                chosen: "openai/gpt-6-luna",
                reason: "drawn",
            }),
        ]);
        const [summary] = ModelRouteReview.summarize({ attempts, decisions, configured: new Map() });
        const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]));
        expect(members["openai/gpt-6-luna"]).toMatchObject({
            attempts: 1,
            draws: 1,
            drawsWon: 1,
            takeRate: 1,
            firstTokenMs: 300,
        });
        expect(members["azure/gpt-6-luna"]).toMatchObject({ attempts: 0, excluded: { cooldown: 1 } });
    }));
});
describe("usage history", () => {
    it.live("keeps cost with each attempt and rolls usage up by session, target, day and offer", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRouteLog.record({
            kind: "decision",
            row: {
                time: 1000,
                session_id: "ses_usage",
                route_id: "usage-pool",
                selection: "weighted",
                candidates: ["openai/gpt-6-luna", "azure/gpt-6-luna"],
                chosen: "openai/gpt-6-luna",
                reason: "drawn",
                detail: { weights: { "openai/gpt-6-luna": 3, "azure/gpt-6-luna": 1 } },
            },
        });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                route_id: "usage-pool",
                session_id: "ses_usage",
                time_started: 1000,
                time_ended: 2000,
                tokens_input: 1000,
                tokens_output: 200,
                tokens_cache_read: 400,
                cost_usd: 0.25,
                cache_savings_usd: 0.05,
            }),
        });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                route_id: "usage-pool",
                session_id: "ses_usage",
                time_started: 3000,
                time_ended: 4000,
                outcome: "failure",
                output_started: false,
                error_tag: "QuotaExceeded",
                tokens_input: 500,
                cost_usd: 0.1,
            }),
        });
        yield* Effect.sleep("100 millis");
        const session = (yield* ModelRouteLog.sessionUsage(db, 0, 50)).find((row) => row.sessionID === "ses_usage");
        expect(session).toMatchObject({ requests: 2, failures: 1, input: 1500, output: 200 });
        expect(session?.costUsd).toBeCloseTo(0.35);
        // Savings aggregate only over attempts recorded with pricing; the second attempt has none.
        expect(session?.cacheRead).toBe(400);
        expect(session?.cacheSavedUsd).toBeCloseTo(0.05);
        const sessionTargets = yield* ModelRouteLog.sessionTargetUsage(db, 0, ["ses_usage"]);
        expect(sessionTargets).toEqual([
            expect.objectContaining({ routeID: "usage-pool", providerID: "openai", modelID: "gpt-6-luna", requests: 2 }),
        ]);
        // Bounded by `since`: only the attempt at 3_000 counts, so the per-target rows sum to the
        // since-filtered session totals instead of mixing in the older attempt at 1_000.
        const bounded = yield* ModelRouteLog.sessionTargetUsage(db, 3000, ["ses_usage"]);
        expect(bounded).toEqual([
            expect.objectContaining({
                routeID: "usage-pool",
                providerID: "openai",
                modelID: "gpt-6-luna",
                requests: 1,
                input: 500,
            }),
        ]);
        expect(yield* ModelRouteLog.sessionTargetUsage(db, 4000, ["ses_usage"])).toEqual([]);
        const target = (yield* ModelRouteLog.targetUsage(db, 0)).find((row) => row.providerID === "openai" && row.modelID === "gpt-6-luna" && row.sessions === 1);
        expect(target).toMatchObject({ requests: 2, failures: 1 });
        const days = yield* ModelRouteLog.dailyUsage(db, 0);
        expect(days.some((row) => row.day === "1970-01-01" && row.providerID === "openai")).toBe(true);
        const offers = (yield* ModelRouteLog.offerUsage(db, 0, "usage-pool"));
        expect(offers.find((row) => row.target === "openai/gpt-6-luna")).toMatchObject({ offered: 1, chosen: 1 });
        expect(offers.find((row) => row.target === "azure/gpt-6-luna")).toMatchObject({ offered: 1, chosen: 0 });
    }));
});
describe("authoritative usage (#7)", () => {
    it.live("sums only successful attempts, with cache savings and tokens by kind", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        const seed = (overrides) => ModelRouteLog.record({
            kind: "attempt",
            row: attempt({ route_id: "auth-pool", session_id: "ses_auth", ...overrides }),
        });
        seed({
            time_started: 1000,
            time_ended: 2000,
            tokens_input: 1000,
            tokens_output: 200,
            tokens_reasoning: 10,
            tokens_cache_read: 400,
            tokens_cache_write: 5,
            cost_usd: 0.25,
            cache_savings_usd: 0.05,
        });
        seed({
            time_started: 3000,
            time_ended: 4000,
            tokens_input: 500,
            tokens_output: 100,
            tokens_cache_read: 100,
            cost_usd: 0.1,
            cache_savings_usd: 0.01,
        });
        // Priced but never completed: every non-success outcome is excluded, even
        // though each row carries a stored cost_usd.
        for (const [index, outcome] of ["failure", "timeout", "hedged-out"].entries())
            seed({
                time_started: 5000 + index * 2000,
                time_ended: 6000 + index * 2000,
                outcome,
                output_started: false,
                tokens_input: 9999,
                cost_usd: 0.5,
                cache_savings_usd: 0.5,
            });
        yield* Effect.sleep("100 millis");
        const [row] = yield* ModelRouteLog.authoritativeSessionUsage(db, ["ses_auth"]);
        expect(row).toMatchObject({
            requests: 2,
            input: 1500,
            output: 300,
            reasoning: 10,
            cacheRead: 500,
            cacheWrite: 5,
        });
        expect(row?.costUsd).toBeCloseTo(0.35);
        expect(row?.cacheSavedUsd).toBeCloseTo(0.06);
        // The all-outcomes rollup counts the failed attempts' stored cost too; the
        // authoritative total deliberately diverges from it (and from the
        // projector's Session.Info.cost, which also folds in title/compaction
        // usage that has no route_attempt row at all).
        const all = (yield* ModelRouteLog.sessionUsage(db, 0, 50)).find((entry) => entry.sessionID === "ses_auth");
        expect(all?.requests).toBe(5);
        expect(all?.costUsd).toBeCloseTo(1.85);
        expect(row?.costUsd).not.toBeCloseTo(all?.costUsd ?? 0);
        // A session with no successful attempt has no authoritative row.
        expect(yield* ModelRouteLog.authoritativeSessionUsage(db, ["ses_missing"])).toEqual([]);
    }));
});
describe("continuation attempts", () => {
    it.live("links each chunk of a continued response to the attempt that started it", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                session_id: "ses_continued",
                assistant_message_id: "msg_root",
                time_started: 1000,
                time_ended: 2000,
                tokens_input: 1000,
                tokens_output: 100,
                cost_usd: 0.1,
            }),
        });
        ModelRouteLog.record({
            kind: "attempt",
            continuationOfMessageID: "msg_root",
            row: attempt({
                session_id: "ses_continued",
                assistant_message_id: "msg_chunk_1",
                continuation_index: 1,
                time_started: 3000,
                time_ended: 4000,
                tokens_input: 1100,
                tokens_output: 80,
                cost_usd: 0.08,
            }),
        });
        // A continuation that fails keeps its own outcome and reason, and still belongs to the turn.
        ModelRouteLog.record({
            kind: "attempt",
            continuationOfMessageID: "msg_root",
            row: attempt({
                session_id: "ses_continued",
                assistant_message_id: "msg_chunk_2",
                continuation_index: 2,
                outcome: "failure",
                output_started: false,
                time_started: 5000,
                time_ended: 6000,
                tokens_input: 1200,
                cost_usd: 0.02,
                ...ModelRouteLog.failureFields({ _tag: "QuotaExceeded", message: "You exceeded your current quota" }),
            }),
        });
        yield* Effect.sleep("100 millis");
        const rows = yield* db.select().from(RouteAttemptTable).orderBy(RouteAttemptTable.id).all();
        const root = rows.find((row) => row.assistant_message_id === "msg_root");
        expect(root).toMatchObject({ continuation_of: null, continuation_index: 0 });
        expect(rows.find((row) => row.assistant_message_id === "msg_chunk_1")).toMatchObject({
            continuation_of: root?.id,
            continuation_index: 1,
            cost_usd: 0.08,
        });
        expect(rows.find((row) => row.assistant_message_id === "msg_chunk_2")).toMatchObject({
            continuation_of: root?.id,
            continuation_index: 2,
            outcome: "failure",
            error_tag: "QuotaExceeded",
        });
        // The per-session totals already count every chunk; the turn view gives the same usage as one response.
        const session = (yield* ModelRouteLog.sessionUsage(db, 0, 50)).find((row) => row.sessionID === "ses_continued");
        expect(session).toMatchObject({ requests: 3, failures: 1, input: 3300, output: 180 });
        const [turn] = ModelUsage.turns(yield* ModelRouteLog.turnAttempts(db, 0, "ses_continued"));
        expect(turn).toMatchObject({
            rootID: root?.id,
            chunks: 3,
            requests: 3,
            failures: 1,
            input: 3300,
            output: 180,
            first: 1000,
            last: 6000,
            durationMs: 5000,
        });
        expect(turn?.costUsd).toBeCloseTo(0.2);
    }));
    it.live("links to the attempt that answered when the first chunk was retried", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                session_id: "ses_retried",
                assistant_message_id: "msg_retried",
                outcome: "failure",
                output_started: false,
                time_started: 1000,
                time_ended: 2000,
            }),
        });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                session_id: "ses_retried",
                assistant_message_id: "msg_retried",
                time_started: 2100,
                time_ended: 3000,
                tokens_input: 500,
                tokens_output: 40,
                cost_usd: 0.05,
            }),
        });
        ModelRouteLog.record({
            kind: "attempt",
            continuationOfMessageID: "msg_retried",
            row: attempt({
                session_id: "ses_retried",
                assistant_message_id: "msg_retried_chunk",
                continuation_index: 1,
                time_started: 4000,
                time_ended: 5000,
                tokens_input: 600,
                tokens_output: 30,
                cost_usd: 0.03,
            }),
        });
        yield* Effect.sleep("100 millis");
        const rows = yield* db.select().from(RouteAttemptTable).orderBy(RouteAttemptTable.id).all();
        const answered = rows.find((row) => row.time_started === 2100);
        const chunk = rows.find((row) => row.assistant_message_id === "msg_retried_chunk");
        expect(chunk?.continuation_of).toBe(answered?.id);
        expect(chunk?.continuation_of).not.toBe(rows.find((row) => row.time_started === 1000)?.id);
        // The retry that produced no response still belongs to the turn it was part of.
        const turns = ModelUsage.turns(yield* ModelRouteLog.turnAttempts(db, 0, "ses_retried"));
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({ rootID: answered?.id, chunks: 2, requests: 3, failures: 1 });
    }));
    it.live("route_usage lists a continued response as one turn", () => withTempDir((tmp) => Effect.gen(function* () {
        const now = Date.now();
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                session_id: "ses_turn_report",
                assistant_message_id: "msg_report_root",
                time_started: now - 3000,
                time_ended: now - 2000,
                tokens_input: 100,
                tokens_output: 40,
                cost_usd: 0.04,
            }),
        });
        ModelRouteLog.record({
            kind: "attempt",
            continuationOfMessageID: "msg_report_root",
            row: attempt({
                session_id: "ses_turn_report",
                assistant_message_id: "msg_report_chunk",
                continuation_index: 1,
                time_started: now - 1000,
                time_ended: now,
                tokens_input: 200,
                tokens_output: 20,
                cost_usd: 0.02,
            }),
        });
        yield* Effect.sleep("100 millis");
        const report = yield* RouteUsageTool.collect({ hours: 1, session: "ses_turn_report" }, undefined, {
            dataDir: tmp.path,
            now: () => now,
        });
        expect(report.turns).toHaveLength(1);
        expect(report.turns[0]).toMatchObject({ chunks: 2, requests: 2, input: 300, output: 60, durationMs: 3000 });
        expect(report.sessions[0]).toMatchObject({ requests: 2, input: 300, output: 60 });
        // A provider filter narrows the turn list like it narrows the target and day reports.
        const filtered = yield* RouteUsageTool.collect({ hours: 1, provider: "azure" }, undefined, {
            dataDir: tmp.path,
            now: () => now,
        });
        expect(filtered.turns).toEqual([]);
    })));
});
describe("route note restore", () => {
    it.live("restores active adjustments, drops expired and removed ones", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        const now = Date.now();
        const add = (id, until, time) => ModelRouteLog.record({
            kind: "note",
            row: {
                time,
                text: id,
                expires: until,
                interpreted: { op: "add", adjustment: { id, match: id, action: "skip", until } },
            },
        });
        add("keep", now + 60000, now - 3);
        add("expired", now - 1, now - 2);
        add("removed", now + 60000, now - 1);
        ModelRouteLog.record({
            kind: "note",
            row: { time: now, text: "remove", interpreted: { op: "remove", id: "removed" } },
        });
        yield* Effect.sleep("100 millis");
        ModelRoute.setAdjustments([]);
        yield* ModelRouteLog.restoreNotes(db);
        expect(ModelRoute.activeAdjustments().map((item) => item.id)).toEqual(["keep"]);
    }));
});
describe("route usage restore", () => {
    it.live("rebuilds the last day of usage from stored attempts", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                provider_id: "restored",
                model_id: "m",
                time_started: now - 2000,
                time_ended: now - 1000,
                tokens_input: 10,
                tokens_output: 5,
                tokens_reasoning: 5,
            }),
        });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                provider_id: "restored",
                model_id: "m",
                time_started: now - 3 * 86400000,
                time_ended: now - 3 * 86400000 + 1000,
                tokens_input: 999,
            }),
        });
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreUsageFrom(db);
        expect(ModelRoute.usageOf(ModelRoute.ref({ providerID: "restored", model: "m" })).day).toEqual({
            requests: 1,
            tokens: 20,
        });
    }));
});
describe("route stats tool", () => {
    it.live("reports per-target stats and exact errors, and suggests from them", () => Effect.gen(function* () {
        ModelRoute.resetHealth();
        const now = Date.now();
        for (let index = 0; index < 6; index++)
            ModelRouteLog.record({
                kind: "attempt",
                row: attempt({
                    provider_id: "flaky",
                    model_id: "m",
                    time_started: now - 1000 - index,
                    time_ended: now - index,
                    outcome: index < 4 ? "failure" : "success",
                    output_started: index >= 4,
                    ...(index < 4
                        ? ModelRouteLog.failureFields({
                            _tag: "ProviderInternal",
                            message: `upstream said no ${index}`,
                            http: { status: 503, headers: {} },
                        })
                        : {}),
                }),
            });
        yield* Effect.sleep("100 millis");
        const report = yield* RouteStatsTool.collect({ hours: 1 });
        const flaky = report.targets.find((row) => row.providerID === "flaky");
        expect(flaky).toMatchObject({ attempts: 6, failures: 4 });
        expect(report.errors.find((error) => error.providerID === "flaky")).toMatchObject({
            tag: "ProviderInternal",
            status: 503,
            count: 4,
        });
        expect(report.errors.find((error) => error.providerID === "flaky")?.lastMessage).toStartWith("upstream said no");
        expect(report.suggestions.map((item) => item.match)).toContain("flaky/m");
    }));
});
describe("route stats tool permission", () => {
    it.live("applying suggestions needs approval; reading does not", () => Effect.gen(function* () {
        ModelRoute.resetHealth();
        const now = Date.now();
        for (let index = 0; index < 6; index++)
            ModelRouteLog.record({
                kind: "attempt",
                row: attempt({
                    provider_id: "denied",
                    model_id: "m",
                    time_started: now - 1000 - index,
                    time_ended: now - index,
                    outcome: "failure",
                    output_started: false,
                }),
            });
        yield* Effect.sleep("100 millis");
        const asked = [];
        const register = (allow) => {
            let tool;
            RouteStatsTool.add({ add: (added) => (tool = added) }, {
                assert: (input) => Effect.sync(() => asked.push(input)).pipe(Effect.andThen(allow
                    ? Effect.void
                    : Effect.fail(new Permission.BlockedError({ rules: [], permission: "route_stats", resources: [] })))),
            });
            return (input) => tool.execute(input, { sessionID: "ses_x", agent: "build", messageID: "m", id: "c" });
        };
        const read = yield* register(false)({ hours: 1 }).pipe(Effect.exit);
        expect(Exit.isSuccess(read)).toBe(true);
        expect(asked).toHaveLength(0);
        expect(ModelRoute.activeAdjustments()).toEqual([]);
        const refused = yield* register(false)({ hours: 1, apply: true }).pipe(Effect.exit);
        expect(Exit.isFailure(refused)).toBe(true);
        expect(asked).toHaveLength(1);
        expect(ModelRoute.activeAdjustments()).toEqual([]);
        const approved = yield* register(true)({ hours: 1, apply: true }).pipe(Effect.exit);
        expect(Exit.isSuccess(approved)).toBe(true);
        expect(ModelRoute.activeAdjustments().map((item) => item.id)).toContain("auto:denied/m");
    }));
});
describe("ModelRouteLog.failureFields", () => {
    test("keeps quota headers, not arbitrary response headers or bodies", () => {
        const fields = ModelRouteLog.failureFields({
            _tag: "RateLimit",
            message: "rate limited",
            code: "429",
            body: "may echo request content",
            http: {
                status: 429,
                headers: {
                    "x-ratelimit-limit-requests": "100",
                    "x-ratelimit-remaining-requests": "0",
                    "retry-after-ms": "5000",
                    "set-cookie": "private",
                    authorization: "secret",
                },
            },
        });
        expect(fields).toMatchObject({
            error_tag: "RateLimit",
            error_code: "429",
            error_status: 429,
            error_message: "rate limited",
            quota: {
                headers: {
                    "x-ratelimit-limit-requests": "100",
                    "x-ratelimit-remaining-requests": "0",
                    "retry-after-ms": "5000",
                },
            },
        });
        // The body is opt-in, since it can echo the request.
        expect(fields.error_body).toBeUndefined();
        expect(JSON.stringify(fields)).not.toContain("private");
        expect(JSON.stringify(fields)).not.toContain("secret");
        expect(JSON.stringify(fields)).not.toContain("may echo");
        const captured = ModelRouteLog.failureFields({
            _tag: "RateLimit",
            message: "rate limited",
            body: "may echo request content",
        }, { captureBody: true });
        expect(captured.error_body).toBe("may echo request content");
    });
});
describe("error bodies", () => {
    const reason = {
        _tag: "RateLimit",
        message: "rate limited",
        body: `{"detail":"retry later","api_key":"sk-live-abcdefgh1234","pad":"${"x".repeat(3000)}"}`,
    };
    test("a body is kept, redacted and capped only while captureErrorBodies is on", () => {
        ModelRouteLog.onCaptureErrorBodies(() => false);
        expect(ModelRouteLog.failureFields(reason).error_body).toBeUndefined();
        ModelRouteLog.onCaptureErrorBodies(() => true);
        const kept = ModelRouteLog.failureFields(reason).error_body;
        ModelRouteLog.onCaptureErrorBodies(() => false);
        expect(kept?.startsWith('{"detail":"retry later","api_key":"[REDACTED]"')).toBe(true);
        expect(kept).not.toContain("sk-live");
        expect(kept).toHaveLength(2000);
    });
    test("a request can keep its body without the setting", () => {
        expect(ModelRouteLog.failureFields(reason, { captureBody: true }).error_body).toHaveLength(2000);
    });
    test("common credential formats are redacted from a captured body", () => {
        const secrets = [
            "ghp_" + "A".repeat(36),
            "gho_" + "A".repeat(36),
            "github_pat_" + "B".repeat(30),
            "AKIA" + "C".repeat(16),
            "ASIA" + "D".repeat(16),
            "xoxb-" + "1".repeat(12) + "-abcdefghij",
            "xoxp-" + "2".repeat(12) + "-abcdefghij",
            "AIza" + "E".repeat(35),
            "eyJ" + "F".repeat(10) + "." + "G".repeat(10) + "." + "H".repeat(10),
            "dXNlcjpwYXNz",
            "urlsecretpass",
        ];
        const body = [
            "retry later ordinary text 12345 https://example.com/docs",
            ...secrets.slice(0, 8),
            `token ${secrets[8]}`,
            `Basic ${secrets[9]}`,
            `https://user:${secrets[10]}@example.com/path`,
        ].join(" ");
        const kept = ModelRouteLog.failureFields({ _tag: "RateLimit", message: "rate limited", body }, { captureBody: true }).error_body;
        for (const secret of secrets)
            expect(kept).not.toContain(secret);
        expect(kept).toContain("retry later ordinary text 12345 https://example.com/docs");
        expect(kept).toContain("Basic [REDACTED]");
        expect(kept).toContain("https://user:[REDACTED]@example.com/path");
    });
});
describe("usage restore", () => {
    it.live("restores no usage for a request that never went out", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                provider_id: "restore-unsent",
                model_id: "m",
                outcome: "resolution-failure",
                time_started: now,
                time_ended: now,
            }),
        });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                provider_id: "restore-sent",
                model_id: "m",
                outcome: "success",
                tokens_input: 5,
                tokens_output: 2,
                time_started: now,
                time_ended: now,
            }),
        });
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreUsageFrom(db);
        expect(ModelRoute.usageOf(ModelRoute.ref({ providerID: "restore-unsent", model: "m" })).day).toEqual({
            requests: 0,
            tokens: 0,
        });
        expect(ModelRoute.usageOf(ModelRoute.ref({ providerID: "restore-sent", model: "m" })).day).toEqual({
            requests: 1,
            tokens: 7,
        });
    }));
});
describe("cooldown restore", () => {
    it.live("rebuilds cooldowns that are still running, and only those", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        const health = (model_id, kind, time, until) => ModelRouteLog.record({
            kind: "health",
            // One provider per target: two cooling models of a provider would demote the provider itself.
            row: { time, provider_id: `restart-${model_id}`, model_id: "m", kind, until },
        });
        health("running", "cooldown-start", now - 5000, now + 60000);
        health("elapsed", "cooldown-start", now - 120000, now - 60000);
        health("recovered", "cooldown-start", now - 10000, now + 60000);
        health("recovered", "cooldown-end", now - 5000);
        health("extended", "cooldown-start", now - 20000, now + 10000);
        health("extended", "cooldown-start", now - 5000, now + 90000);
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db);
        const cooling = (name) => ModelRoute.coolingDown(ModelRoute.ref({ providerID: `restart-${name}`, model: "m" }));
        expect(cooling("running")).toBe(true);
        expect(cooling("elapsed")).toBe(false);
        expect(cooling("recovered")).toBe(false);
        expect(cooling("extended")).toBe(true);
        expect(ModelRoute.cooldownUntil(ModelRoute.ref({ providerID: "restart-extended", model: "m" }))).toBe(now + 90000);
    }));
});
describe("quota cooldown restore re-judged against current quota (#1976)", () => {
    const reading = (providerID, models, now) => ({
        providerID,
        measuredAt: now,
        windows: [],
        models: Object.fromEntries(Object.entries(models).map(([modelID, window]) => [
            modelID,
            [{ name: "window", usedPercent: window.percent, resetAt: window.resetAt, measuredAt: now }],
        ])),
    });
    const bench = (provider_id, model_id, reason, until, now) => ModelRouteLog.record({
        kind: "health",
        row: { time: now - 5000, provider_id, model_id, kind: "cooldown-start", reason, until },
    });
    it.live("a family-A wall does not re-bench sibling family B on the same credential", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        bench("restore-family", "fam-a", "quota credential:cred-shared", now + 3600000, now);
        bench("restore-family", "fam-b", "quota credential:cred-shared", now + 3600000, now);
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db, [
            reading("restore-family", {
                "fam-a": { percent: 100, resetAt: now + 1800000 },
                "fam-b": { percent: 40, resetAt: null },
            }, now),
        ]);
        const famA = ModelRoute.ref({ providerID: "restore-family", model: "fam-a" });
        const famB = ModelRoute.ref({ providerID: "restore-family", model: "fam-b" });
        // Family A is still full: its bench stands, bounded by the measured reset.
        expect(ModelRoute.credentialCooldownUntil(famA, "cred-shared", now)).toBe(now + 1800000);
        // Family B has headroom on its own leg: its persisted bench is discarded, and
        // family A's full window never held it.
        expect(ModelRoute.credentialCoolingDown(famB, "cred-shared", now)).toBe(false);
        expect(ModelRoute.coolingDown(famB, now)).toBe(false);
    }));
    it.live("a fresh headroom reading releases a restored quota bench", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        bench("restore-headroom", "m", "quota", now + 60000, now);
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db, [
            reading("restore-headroom", { m: { percent: 10, resetAt: null } }, now),
        ]);
        const target = ModelRoute.ref({ providerID: "restore-headroom", model: "m" });
        expect(ModelRoute.coolingDown(target, now)).toBe(false);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(0);
    }));
    it.live("a still-full matching window remains benched, bounded by its measured reset", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        bench("restore-full", "m", "quota", now + 60000, now);
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db, [
            reading("restore-full", { m: { percent: 100, resetAt: now + 30000 } }, now),
        ]);
        const target = ModelRoute.ref({ providerID: "restore-full", model: "m" });
        expect(ModelRoute.coolingDown(target, now)).toBe(true);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 30000);
    }));
    it.live("a non-quota transport bench restores unchanged despite a headroom reading", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        bench("restore-transport", "m", "failure", now + 60000, now);
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db, [
            reading("restore-transport", { m: { percent: 10, resetAt: null } }, now),
        ]);
        const target = ModelRoute.ref({ providerID: "restore-transport", model: "m" });
        expect(ModelRoute.coolingDown(target, now)).toBe(true);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 60000);
    }));
    it.live("no reading for the leg keeps the persisted quota bench", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        bench("restore-noreading", "m", "quota", now + 60000, now);
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db, [
            reading("someone-else", { m: { percent: 10, resetAt: null } }, now),
        ]);
        const target = ModelRoute.ref({ providerID: "restore-noreading", model: "m" });
        expect(ModelRoute.coolingDown(target, now)).toBe(true);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 60000);
    }));
    it.live("a prototype-named model id is no reading, never a crash (#2392)", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        bench("restore-proto", "__proto__", "quota", now + 60000, now);
        yield* Effect.sleep("100 millis");
        // Oracle (#865 guard): the reading's models record is a plain
        // object, so a bare models["__proto__"] read resolves to
        // Object.prototype — a non-iterable the candidate-window spread
        // throws on. The own-value lookup treats the leg as unmeasured
        // instead: the bench restores exactly as persisted.
        yield* ModelRouteLog.restoreCooldownsFrom(db, [reading("restore-proto", {}, now)]);
        const target = ModelRoute.ref({ providerID: "restore-proto", model: "__proto__" });
        expect(ModelRoute.coolingDown(target, now)).toBe(true);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(now + 60000);
    }));
});
describe("credential cooldown restore (#870)", () => {
    it.live("rebuilds a credential-scoped cooldown onto that credential only", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        ModelRouteLog.record({
            kind: "health",
            row: {
                time: now - 5000,
                provider_id: "restart-cred",
                model_id: "m",
                kind: "cooldown-start",
                reason: "quota credential:cred-a",
                until: now + 60000,
            },
        });
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db);
        const target = ModelRoute.ref({ providerID: "restart-cred", model: "m" });
        // Only the benched credential is excluded after the restart; the healthy alternate
        // credential behind the same target stays routable, and the target itself is not benched.
        expect(ModelRoute.credentialCooldownUntil(target, "cred-a")).toBe(now + 60000);
        expect(ModelRoute.credentialCoolingDown(target, "cred-a")).toBe(true);
        expect(ModelRoute.credentialCoolingDown(target, "cred-b")).toBe(false);
        expect(ModelRoute.coolingDown(target)).toBe(false);
        expect(ModelRoute.cooldownUntil(target)).toBe(0);
    }));
    it.live("rebuilds a credential-scoped rate-limit window onto that credential only", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        ModelRouteLog.record({
            kind: "health",
            row: {
                time: now - 5000,
                provider_id: "limit-cred",
                model_id: "m",
                kind: "rate-limit-window",
                reason: "provider-reported credential:cred-a",
                until: now + 120000,
            },
        });
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db);
        const target = ModelRoute.ref({ providerID: "limit-cred", model: "m" });
        expect(ModelRoute.limitedUntil(target, now, "cred-a")).toBe(now + 120000);
        expect(ModelRoute.limitedUntil(target, now, "cred-b")).toBe(0);
        expect(ModelRoute.limitedUntil(target, now)).toBe(0);
    }));
});
describe("credential column restore (#1055)", () => {
    it.live("restores from the credential_id column when the reason names no credential", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        ModelRouteLog.record({
            kind: "health",
            row: {
                time: now - 5000,
                provider_id: "restart-col",
                model_id: "m",
                kind: "cooldown-start",
                reason: "quota",
                until: now + 60000,
                credential_id: "cred-a",
            },
        });
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db);
        const target = ModelRoute.ref({ providerID: "restart-col", model: "m" });
        expect(ModelRoute.credentialCooldownUntil(target, "cred-a")).toBe(now + 60000);
        expect(ModelRoute.credentialCoolingDown(target, "cred-a")).toBe(true);
        expect(ModelRoute.credentialCoolingDown(target, "cred-b")).toBe(false);
        expect(ModelRoute.coolingDown(target)).toBe(false);
    }));
    it.live("restores a column-only rate-limit window onto that credential only", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        ModelRouteLog.record({
            kind: "health",
            row: {
                time: now - 5000,
                provider_id: "limit-col",
                model_id: "m",
                kind: "rate-limit-window",
                reason: "provider-reported",
                until: now + 120000,
                credential_id: "cred-a",
            },
        });
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db);
        const target = ModelRoute.ref({ providerID: "limit-col", model: "m" });
        expect(ModelRoute.limitedUntil(target, now, "cred-a")).toBe(now + 120000);
        expect(ModelRoute.limitedUntil(target, now, "cred-b")).toBe(0);
        expect(ModelRoute.limitedUntil(target, now)).toBe(0);
    }));
    it.live("prefers the credential_id column over a stale credential in the reason", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        ModelRouteLog.record({
            kind: "health",
            row: {
                time: now - 5000,
                provider_id: "restart-prefer",
                model_id: "m",
                kind: "cooldown-start",
                reason: "quota credential:cred-b",
                until: now + 60000,
                credential_id: "cred-a",
            },
        });
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db);
        const target = ModelRoute.ref({ providerID: "restart-prefer", model: "m" });
        expect(ModelRoute.credentialCooldownUntil(target, "cred-a")).toBe(now + 60000);
        expect(ModelRoute.credentialCoolingDown(target, "cred-b")).toBe(false);
        expect(ModelRoute.coolingDown(target)).toBe(false);
    }));
    it.live("a provider-scoped reason never restores onto a credential", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        ModelRouteLog.record({
            kind: "health",
            row: {
                time: now - 5000,
                provider_id: "restart-prov",
                model_id: "m",
                kind: "cooldown-start",
                reason: "provider:restart-prov quota-known-full",
                until: now + 60000,
            },
        });
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db);
        const target = ModelRoute.ref({ providerID: "restart-prov", model: "m" });
        // The hold belongs to the target: no credential inherits it.
        expect(ModelRoute.coolingDown(target)).toBe(true);
        expect(ModelRoute.credentialCoolingDown(target, "restart-prov")).toBe(false);
        expect(ModelRoute.credentialCoolingDown(target, "cred-a")).toBe(false);
    }));
});
describe("credential attempt snapshot restore (#1116)", () => {
    it.live("restores each credential's attempt snapshot onto its own window, never target-wide", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        const snap = (remaining) => ({
            limit: { tokens: "1000" },
            remaining: { tokens: remaining },
            reset: { tokens: "3600" },
        });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                provider_id: "snapshots",
                model_id: "m",
                credential_id: "cred-a",
                time_started: now - 5000,
                time_ended: now - 4000,
                quota: snap("11"),
            }),
        });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                provider_id: "snapshots",
                model_id: "m",
                credential_id: "cred-b",
                time_started: now - 5000,
                time_ended: now - 3000,
                quota: snap("22"),
            }),
        });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                provider_id: "snapshots",
                model_id: "m",
                time_started: now - 5000,
                time_ended: now - 2000,
                quota: snap("33"),
            }),
        });
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db);
        const target = ModelRoute.ref({ providerID: "snapshots", model: "m" });
        expect(ModelRoute.rateLimitOf(target, "cred-a")?.remaining).toEqual({ tokens: "11" });
        expect(ModelRoute.rateLimitOf(target, "cred-b")?.remaining).toEqual({ tokens: "22" });
        // The credential-less snapshot keeps the pre-column target-wide behavior.
        expect(ModelRoute.rateLimitOf(target)?.remaining).toEqual({ tokens: "33" });
    }));
});
describe("quota cooldown reset restore (#1123)", () => {
    it.live("caps a previously persisted long quota bench at its matching exhausted window reset", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        const resetAt = now - 1000 + 5 * 3600000;
        ModelRouteLog.record({
            kind: "health",
            row: {
                time: now - 1000,
                provider_id: "restore-quota",
                model_id: "m",
                kind: "cooldown-start",
                reason: "quota credential:cred-a",
                until: now + 86400000,
                credential_id: "cred-a",
            },
        });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                provider_id: "restore-quota",
                model_id: "m",
                credential_id: "cred-a",
                time_started: now - 2000,
                time_ended: now - 1000,
                outcome: "failure",
                quota: {
                    limit: { requests: "100" },
                    remaining: { requests: "0" },
                    reset: { requests: "18000" },
                },
            }),
        });
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db);
        const target = ModelRoute.ref({ providerID: "restore-quota", model: "m" });
        expect(ModelRoute.credentialCooldownUntil(target, "cred-a", now)).toBe(resetAt);
        expect(ModelRoute.credentialCooldownUntil(target, "cred-b", now)).toBe(0);
        expect(ModelRoute.cooldownUntil(target, now)).toBe(0);
    }));
});
describe("rate-limit hold release restore (#870)", () => {
    it.live("a cleared hold stays cleared after a restart", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        const target = ModelRoute.ref({ providerID: "limit-released", model: "m" });
        const spent = { at: now, remaining: { requests: "0" }, reset: { requests: "45s" } };
        ModelRoute.observeRateLimit(target, spent, now, "cred-a");
        expect(ModelRoute.limitedUntil(target, now, "cred-a")).toBe(now + 45000);
        // The serving credential then succeeds without limit headers: the hold is released,
        // and the release is persisted so replay does not resurrect the original window row.
        ModelRoute.clearRateLimit(target, "cred-a");
        expect(ModelRoute.limitedUntil(target, now, "cred-a")).toBe(0);
        yield* Effect.sleep("100 millis");
        ModelRoute.resetHealth();
        yield* ModelRouteLog.restoreCooldownsFrom(db);
        expect(ModelRoute.limitedUntil(target, Date.now(), "cred-a")).toBe(0);
        expect(ModelRoute.limitedUntilAny(target, Date.now())).toBe(0);
    }));
});
describe("rate-limit window restore", () => {
    it.live("holds targets back again after a restart while the provider's window is still open", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        const window = (name, time, until) => ModelRouteLog.record({
            kind: "health",
            row: { time, provider_id: `limit-${name}`, model_id: "m", kind: "rate-limit-window", until },
        });
        window("open", now - 5000, now + 120000);
        window("over", now - 200000, now - 100000);
        window("renewed", now - 50000, now + 10000);
        window("renewed", now - 5000, now + 300000);
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db);
        const until = (name) => ModelRoute.limitedUntil(ModelRoute.ref({ providerID: `limit-${name}`, model: "m" }));
        expect(until("open")).toBe(now + 120000);
        expect(until("over")).toBe(0);
        expect(until("renewed")).toBe(now + 300000);
        // A window is the provider's forecast, not a failure: nothing is cooling.
        expect(ModelRoute.coolingDown(ModelRoute.ref({ providerID: "limit-open", model: "m" }))).toBe(false);
    }));
    it.live("records a spent window as a health event the first time it is seen", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const target = ModelRoute.ref({ providerID: "limit-logged", model: "m" });
        const now = Date.now();
        const spent = { at: now, remaining: { requests: "0" }, reset: { requests: "45s" } };
        ModelRoute.observeRateLimit(target, spent, now);
        ModelRoute.observeRateLimit(target, spent, now + 1000);
        yield* Effect.sleep("100 millis");
        const rows = (yield* db.select().from(RouteHealthTable).all()).filter((row) => row.provider_id === "limit-logged");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: "rate-limit-window", reason: "provider-reported", until: now + 45000 });
    }));
});
describe("cold-target rate-limit restore", () => {
    it.live("brings back the provider's last word, not just the hold", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        // A successful attempt whose response advertised a nearly-spent window.
        ModelRouteLog.record({
            kind: "attempt",
            row: {
                time_started: now - 60000,
                time_ended: now - 59000,
                route_id: "r",
                provider_id: "cold",
                model_id: "m",
                outcome: "success",
                output_started: true,
                quota: {
                    at: now - 60000,
                    limit: { requests: "60" },
                    remaining: { requests: "2" },
                    reset: { requests: "10m" },
                },
            },
        });
        yield* Effect.sleep("100 millis");
        yield* ModelRouteLog.restoreCooldownsFrom(db);
        const target = ModelRoute.ref({ providerID: "cold", model: "m" });
        // The snapshot itself is back, so route_stats can show it before first use.
        expect(ModelRoute.rateLimitOf(target)?.remaining).toEqual({ requests: "2" });
    }));
});
describe("ModelRouteLog.observer", () => {
    it.live("records every call's attempt, so background generation is not invisible", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        const now = Date.now();
        const observe = ModelRouteLog.observer({
            routeID: "titles",
            providerID: "openai",
            modelID: "small",
            sessionID: "ses_title",
            startedAt: now,
        });
        observe.done("success", {
            outputStarted: true,
            firstOutputAt: now + 12,
            tokens: { input: 30, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        });
        yield* Effect.sleep("100 millis");
        const rows = yield* db.select().from(RouteAttemptTable).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            route_id: "titles",
            provider_id: "openai",
            model_id: "small",
            outcome: "success",
            output_started: true,
            tokens_input: 30,
            tokens_estimated: false,
        });
    }));
    it.live("records a failed call with the exact error, and bodies when asked", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        const failure = new AIError({
            reason: new QuotaExceededError({ message: "out of quota", body: '{"detail":"try again later"}' }),
        });
        ModelRouteLog.observer({
            routeID: "gen",
            providerID: "openai",
            modelID: "m",
            startedAt: Date.now(),
            captureBody: true,
        }).done("failure", { failure, outputStarted: false });
        yield* Effect.sleep("100 millis");
        const rows = yield* db.select().from(RouteAttemptTable).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            outcome: "failure",
            error_tag: "QuotaExceeded",
            error_message: "out of quota",
            error_body: '{"detail":"try again later"}',
        });
    }));
    it.live("stores the canonical retryable verdict for observer failures", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        const attemptFor = (routeID, failure) => ModelRouteLog.observer({ routeID, providerID: "openai", modelID: "m", startedAt: Date.now() }).done("failure", {
            failure,
            outputStarted: false,
        });
        attemptFor("auth", new AIError({ reason: new AuthenticationError({ message: "bad key" }) }));
        attemptFor("quota", new AIError({ reason: new QuotaExceededError({ message: "out of quota" }) }));
        attemptFor("rate", new AIError({ reason: new RateLimitError({ message: "slow down" }) }));
        attemptFor("plain", new Error("boom"));
        yield* Effect.sleep("100 millis");
        const rows = yield* db.select().from(RouteAttemptTable).all();
        expect(rows.map((row) => [row.route_id, row.retryable]).toSorted()).toEqual([
            ["auth", false],
            ["plain", false],
            ["quota", false],
            ["rate", true],
        ]);
    }));
    it.live("marks both legs of a hedged attempt", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        const request = { routeID: "r", providerID: "openai", modelID: "m", startedAt: Date.now(), hedged: true };
        ModelRouteLog.observer(request).done("success", { outputStarted: true, firstOutputAt: Date.now() });
        ModelRouteLog.observer(request).done("hedged-out", { outputStarted: false });
        yield* Effect.sleep("100 millis");
        const rows = yield* db.select().from(RouteAttemptTable).all();
        expect(rows.map((row) => [row.outcome, row.hedged]).toSorted()).toEqual([
            ["hedged-out", true],
            ["success", true],
        ]);
    }));
});
describe("per-credential usage (#1106)", () => {
    it.live("targetUsage splits by serving credential; unattributed usage feeds no credential", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        const now = Date.now();
        const serve = (credentialID, input) => ModelRouteLog.observer({
            routeID: "quota-pool",
            providerID: "multi",
            modelID: "m",
            sessionID: `ses_${credentialID ?? "none"}`,
            startedAt: now,
            credentialID,
        }).done("success", {
            outputStarted: true,
            tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        });
        serve("cred-a", 900);
        serve("cred-b", 100);
        serve(undefined, 500);
        // One session served by two credentials of the same target (credential fallback).
        ModelRouteLog.observer({
            routeID: "quota-pool",
            providerID: "multi",
            modelID: "m",
            sessionID: "ses_cred-a",
            startedAt: now,
            credentialID: "cred-b",
        }).done("success", {
            outputStarted: true,
            tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        });
        yield* Effect.sleep("100 millis");
        const rows = yield* db.select().from(RouteAttemptTable).all();
        expect(rows.map((row) => row.credential_id).toSorted()).toEqual(["cred-a", "cred-b", "cred-b", null]);
        const usage = yield* ModelRouteLog.targetUsage(db, 0);
        // The quota gate's per-credential sum: each credential sees only its own usage, and the
        // unattributed (env-served) row contributes to neither credential's totals.
        const forCredential = (credentialID) => ModelUsage.sum(usage.filter((row) => row.providerID === "multi" && row.credentialID === credentialID));
        expect(forCredential("cred-a").input).toBe(900);
        expect(forCredential("cred-b").input).toBe(150);
        expect(usage.find((row) => row.providerID === "multi" && row.credentialID === null)?.input).toBe(500);
        // The provider scope still sums every row, as it did before the credential dimension.
        expect(ModelUsage.sum(usage.filter((row) => row.providerID === "multi")).input).toBe(1550);
        // Distinct sessions per target stays exact despite the credential split: ses_cred-a was
        // served by both credentials but is one session.
        expect(yield* ModelRouteLog.targetSessions(db, 0)).toEqual([{ providerID: "multi", modelID: "m", sessions: 3 }]);
    }));
});
describe("hedge accuracy", () => {
    it.live("scores each leg of a hedged pair", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        const now = Date.now();
        const leg = (provider, outcome) => ModelRouteLog.observer({
            routeID: "r",
            providerID: provider,
            modelID: "m",
            assistantMessageID: "msg_hedge",
            startedAt: now,
            hedged: true,
        }).done(outcome, {
            outputStarted: outcome === "success",
            firstOutputAt: outcome === "success" ? now : undefined,
        });
        leg("openai", "hedged-out");
        leg("anthropic", "success");
        yield* Effect.sleep("100 millis");
        expect(yield* ModelRouteLog.hedgeAccuracy(db, 0)).toMatchObject([
            { providerID: "anthropic", modelID: "m", hedges: 1, wins: 1 },
            { providerID: "openai", modelID: "m", hedges: 1, wins: 0 },
        ]);
    }));
});
describe("demotion restore (#1151)", () => {
    const quotaAttempt = (provider_id, at, credential_id) => ModelRouteLog.record({
        kind: "attempt",
        row: attempt({
            provider_id,
            model_id: "m",
            time_started: at - 100,
            time_ended: at,
            outcome: "failure",
            output_started: false,
            ...(credential_id ? { credential_id } : {}),
            ...ModelRouteLog.failureFields({ _tag: "QuotaExceeded", message: "out of quota" }),
        }),
    });
    it.live("demotion counts survive a restart: the ledger rehydrates the hot cache", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        for (const at of [now - 3000, now - 2000, now - 1000])
            quotaAttempt("demote-restart", at);
        // Only two quota errors: below the threshold of three, even after a restore.
        for (const at of [now - 2000, now - 1000])
            quotaAttempt("demote-few", at);
        // Non-quota failures are not demotion evidence, however many the ledger holds.
        for (const at of [now - 3000, now - 2000, now - 1000])
            ModelRouteLog.record({
                kind: "attempt",
                row: attempt({
                    provider_id: "demote-other",
                    model_id: "m",
                    time_started: at - 100,
                    time_ended: at,
                    outcome: "failure",
                    output_started: false,
                    ...ModelRouteLog.failureFields({ _tag: "ProviderInternal", message: "upstream said no" }),
                }),
            });
        yield* Effect.sleep("100 millis");
        // The simulated restart: the in-process cache is wiped, the ledger is all that remains.
        ModelRoute.resetHealth();
        const target = (providerID) => ModelRoute.ref({ providerID, model: "m" });
        expect(ModelRoute.demoted(target("demote-restart"), now)).toBe(false);
        yield* ModelRouteLog.restoreDemotionFrom(db);
        expect(ModelRoute.demoted(target("demote-restart"), now)).toBe(true);
        expect(ModelRoute.demoted(target("demote-few"), now)).toBe(false);
        expect(ModelRoute.demoted(target("demote-other"), now)).toBe(false);
        // A repeated restore over the same ledger must not count an attempt twice:
        // demote-few would cross the threshold if its two rows were replayed again.
        yield* ModelRouteLog.restoreDemotionFrom(db);
        expect(ModelRoute.demoted(target("demote-few"), now)).toBe(false);
        expect(ModelRoute.demoted(target("demote-restart"), now)).toBe(true);
    }));
    it.live("restored counts still expire with the demotion window", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        const fiveHoursAgo = now - 5 * 3600000;
        for (const at of [fiveHoursAgo, fiveHoursAgo + 1000, fiveHoursAgo + 2000])
            quotaAttempt("demote-old", at);
        yield* Effect.sleep("100 millis");
        ModelRoute.resetHealth();
        yield* ModelRouteLog.restoreDemotionFrom(db);
        const target = ModelRoute.ref({ providerID: "demote-old", model: "m" });
        // The rows are restored (they demote when judged inside their window) but the
        // default four-hour window has passed by now, so the target is not demoted.
        expect(ModelRoute.demoted(target, fiveHoursAgo + 3000)).toBe(true);
        expect(ModelRoute.demoted(target, now)).toBe(false);
    }));
    it.live("a credential's quota rows restore onto that credential only", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        for (const at of [now - 3000, now - 2000, now - 1000])
            quotaAttempt("demote-cred", at, "cred-a");
        yield* Effect.sleep("100 millis");
        ModelRoute.resetHealth();
        yield* ModelRouteLog.restoreDemotionFrom(db);
        const target = ModelRoute.ref({ providerID: "demote-cred", model: "m" });
        expect(ModelRoute.demoted(target, now, "cred-a")).toBe(true);
        expect(ModelRoute.demoted(target, now, "cred-b")).toBe(false);
        expect(ModelRoute.demoted(target, now)).toBe(false);
    }));
    it.live("distinct attempts that share a millisecond each count toward demotion", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        // Three distinct ledger rows, one time_ended: live recordQuota would count all
        // three, so the restore must too — deduplication is by row id, not timestamp.
        for (let i = 0; i < 3; i++)
            quotaAttempt("demote-same-ms", now - 1000);
        yield* Effect.sleep("100 millis");
        ModelRoute.resetHealth();
        yield* ModelRouteLog.restoreDemotionFrom(db);
        const target = ModelRoute.ref({ providerID: "demote-same-ms", model: "m" });
        expect(ModelRoute.demoted(target, now)).toBe(true);
    }));
    it.live("restored history survives when the judging window registers after the restore", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        // One failure inside the default retention, two far outside it: replaying
        // through the default four-hour retention would keep only the latest.
        for (const at of [now - 48 * 3600000, now - 24 * 3600000, now - 3600000])
            quotaAttempt("demote-late-window", at);
        yield* Effect.sleep("100 millis");
        ModelRoute.resetHealth();
        // No demotion config is registered yet, so retention at restore time is
        // the default; the seven-day policy only arrives afterwards.
        yield* ModelRouteLog.restoreDemotionFrom(db);
        const target = ModelRoute.ref({ providerID: "demote-late-window", model: "m" });
        expect(ModelRoute.demoted(target, now)).toBe(false);
        const off = ModelRoute.onDemotionConfig(() => ({ windowMs: 7 * 86400000 }));
        try {
            expect(ModelRoute.demoted(target, now)).toBe(true);
        }
        finally {
            off();
        }
    }));
    it.live("rows older than a day restore when the configured window reaches them", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        ModelRoute.resetHealth();
        const now = Date.now();
        const twoDaysAgo = now - 2 * 86400000;
        for (const at of [twoDaysAgo, twoDaysAgo + 1000, twoDaysAgo + 2000])
            quotaAttempt("demote-long-window", at);
        yield* Effect.sleep("100 millis");
        ModelRoute.resetHealth();
        // A seven-day demotion window (the schema admits up to ninety days): rows from
        // two days ago still count, so the restore must reach back past one day.
        const off = ModelRoute.onDemotionConfig(() => ({ windowMs: 7 * 86400000 }));
        try {
            yield* ModelRouteLog.restoreDemotionFrom(db);
            const target = ModelRoute.ref({ providerID: "demote-long-window", model: "m" });
            expect(ModelRoute.demoted(target, now)).toBe(true);
        }
        finally {
            off();
        }
    }));
});
describe("ModelRouteLog.failureFields surrogate-pair guard (#1973)", () => {
    test("a pair straddling the error_body cut is dropped whole", () => {
        const body = "a".repeat(1999) + "\u{1F600}" + "b".repeat(10);
        const fields = ModelRouteLog.failureFields({ _tag: "RateLimit", message: "x", body }, { captureBody: true });
        expect(fields.error_body).toBe("a".repeat(1999));
        expect(fields.error_body?.isWellFormed()).toBe(true);
    });
});
describe("writer persistence failure (#2331)", () => {
    it.live("a failed batch is retained, retried and persisted exactly once after the database recovers", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        const now = Date.now();
        // Sabotage: with the attempt table renamed away, every batch carrying an
        // attempt fails part-way through its inserts.
        yield* db.run(sql `ALTER TABLE route_attempt RENAME TO route_attempt_down`);
        ModelRouteLog.record({
            kind: "decision",
            row: {
                time: 1,
                route_id: "luna",
                selection: "weighted",
                candidates: ["openai/gpt-6-luna"],
                chosen: "openai/gpt-6-luna",
                reason: "drawn",
            },
        });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                provider_id: "recovery-probe",
                model_id: "m-recovery",
                time_started: now - 2000,
                time_ended: now - 1000,
                tokens_input: 10,
                tokens_output: 5,
            }),
        });
        ModelRouteLog.record({
            kind: "attempt",
            row: attempt({
                provider_id: "recovery-probe",
                model_id: "m-recovery",
                time_started: now - 900,
                time_ended: now - 100,
                outcome: "failure",
                output_started: false,
                tokens_input: 20,
                tokens_output: 5,
            }),
        });
        // Wait until a failed persistence attempt is OBSERVED — the writer logs a
        // warning for every retained batch it retries — instead of sleeping a fixed
        // interval and hoping the writer ran. The test cannot pass unless the
        // writer actually attempted the batch and the failure was seen.
        let failureObserved = false;
        for (let i = 0; i < 100 && !failureObserved; i++) {
            const lines = yield* TestConsole.logLines;
            failureObserved = lines.some((line) => typeof line === "string" &&
                line.includes("failed to persist model route telemetry; batch retained for retry"));
            if (!failureObserved)
                yield* Effect.sleep("50 millis");
        }
        expect(failureObserved).toBe(true);
        // Atomicity: the decision from the same batch is not visible either —
        // the failed batch rolled back in full instead of leaving partial rows.
        expect(yield* db.select().from(RouteDecisionTable).all()).toHaveLength(0);
        // The database recovers; the retained batch must land exactly once.
        yield* db.run(sql `ALTER TABLE route_attempt_down RENAME TO route_attempt`);
        let attempts = [];
        for (let i = 0; i < 50; i++) {
            attempts = yield* db.select().from(RouteAttemptTable).all();
            if (attempts.length === 2)
                break;
            yield* Effect.sleep("200 millis");
        }
        expect(attempts).toHaveLength(2);
        expect(yield* db.select().from(RouteDecisionTable).all()).toHaveLength(1);
        // The recovered rows feed the diagnostic stats for the target.
        const stats = yield* ModelRouteLog.targetStats(db, 0, "luna");
        expect(stats).toHaveLength(1);
        expect(stats[0]).toMatchObject({ attempts: 2, failures: 1 });
        // …and the quota usage read: each recovered attempt counted exactly once.
        const usage = yield* ModelRouteLog.targetUsage(db, 0);
        const recovered = ModelUsage.sum(usage.filter((row) => row.providerID === "recovery-probe"));
        expect(recovered.input).toBe(30);
        expect(recovered.output).toBe(10);
        // …and the restart restoration read: a restore from the persisted rows
        // rebuilds the same usage (current timestamps keep the rows inside the
        // restoration window, which only reaches back one day).
        ModelRoute.resetHealth();
        yield* ModelRouteLog.restoreUsageFrom(db);
        expect(ModelRoute.usageOf(ModelRoute.ref({ providerID: "recovery-probe", model: "m-recovery" })).day).toEqual({
            requests: 2,
            tokens: 40,
        });
    }));
});
describe("read API over the ledger (#2497)", () => {
    it.live("filters attempts by window, provider, model and session, and never selects credential or body columns", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        const rows = [
            attempt({
                time_started: 1000,
                time_ended: 2000,
                session_id: "ses_1",
                tokens_input: 100,
                tokens_output: 10,
                credential_id: "cred_secret",
            }),
            attempt({
                time_started: 3000,
                time_ended: 4000,
                session_id: "ses_2",
                outcome: "failure",
                output_started: false,
                tokens_input: 50,
                ...ModelRouteLog.failureFields({ _tag: "QuotaExceeded", message: "quota" }),
            }),
            attempt({
                time_started: 4000,
                time_ended: 5000,
                session_id: "ses_1",
                provider_id: "anthropic",
                model_id: "claude-x",
                tokens_input: 200,
            }),
            attempt({ time_started: 9000, time_ended: 10000, session_id: "ses_1" }),
        ];
        for (const row of rows)
            ModelRouteLog.record({ kind: "attempt", row });
        ModelRouteLog.record({
            kind: "decision",
            row: {
                time: 2000,
                session_id: "ses_1",
                route_id: "luna",
                selection: "weighted",
                candidates: ["openai/gpt-6-luna"],
                chosen: "openai/gpt-6-luna",
                reason: "drawn",
            },
        });
        ModelRouteLog.record({
            kind: "decision",
            row: {
                time: 6000,
                session_id: "ses_2",
                route_id: "other",
                selection: "weighted",
                candidates: ["anthropic/claude-x"],
                chosen: "anthropic/claude-x",
                reason: "drawn",
            },
        });
        yield* Effect.sleep("100 millis");
        const byProvider = yield* ModelRouteLog.filteredAttempts(db, { since: 0, providerID: "openai" });
        expect(byProvider.map((row) => row.timeStarted)).toEqual([9000, 3000, 1000]);
        // The API contract: no credential, no provider error body, no quota snapshot is ever selected.
        expect(Object.keys(byProvider[0] ?? {})).not.toContain("credentialID");
        expect(Object.keys(byProvider[0] ?? {})).not.toContain("errorBody");
        expect(Object.keys(byProvider[0] ?? {})).not.toContain("quota");
        const byWindowAndSession = yield* ModelRouteLog.filteredAttempts(db, {
            since: 0,
            until: 5000,
            sessionID: "ses_1",
        });
        expect(byWindowAndSession.map((row) => row.timeStarted)).toEqual([4000, 1000]);
        const byModel = yield* ModelRouteLog.filteredAttempts(db, { since: 0, modelID: "claude-x" });
        expect(byModel).toHaveLength(1);
        expect(byModel[0]?.providerID).toBe("anthropic");
        const limited = yield* ModelRouteLog.filteredAttempts(db, { since: 0, limit: 2 });
        expect(limited.map((row) => row.timeStarted)).toEqual([9000, 4000]);
        const totals = yield* ModelRouteLog.targetTotals(db, 0, 5000);
        expect(totals).toHaveLength(2);
        expect(totals.find((row) => row.providerID === "openai")).toMatchObject({
            attempts: 2,
            successes: 1,
            failures: 1,
            tokensInput: 150,
            tokensOutput: 10,
            sessions: 2,
            first: 1000,
            last: 4000,
        });
        expect(totals.find((row) => row.providerID === "anthropic")).toMatchObject({
            attempts: 1,
            successes: 1,
            tokensInput: 200,
            sessions: 1,
        });
        const coverage = yield* ModelRouteLog.ledgerCoverage(db, 0, 5000);
        expect(coverage).toMatchObject({ attempts: 3, providers: 2, models: 2, sessions: 2, routes: 1, first: 1000, last: 5000 });
        const errors = yield* ModelRouteLog.errorBreakdown(db, 0, 5000);
        expect(errors.find((row) => row.tag === "QuotaExceeded")?.count).toBe(1);
        expect(yield* ModelRouteLog.errorBreakdown(db, 0, 2000)).toHaveLength(0);
        const decisions = yield* ModelRouteLog.filteredDecisions(db, { since: 0, routeID: "luna" });
        expect(decisions).toHaveLength(1);
        expect(decisions[0]?.chosen).toBe("openai/gpt-6-luna");
        expect(yield* ModelRouteLog.filteredDecisions(db, { since: 0, until: 5000 })).toHaveLength(1);
    }));
});
describe("rollup read over the ledger (#2795)", () => {
    it.live("buckets by day, hour of day and day of week, groups by credential as an opaque key, and treats until as exclusive", () => Effect.gen(function* () {
        const db = (yield* Database.Service).db;
        const monday = Date.UTC(2026, 0, 5);
        const hour = 3600000;
        const rows = [
            attempt({
                time_started: monday + hour,
                time_ended: monday + hour + 500,
                credential_id: "cred_secret_a",
                tokens_input: 100,
                tokens_output: 10,
                cost_usd: 0.5,
                variant: "high",
            }),
            attempt({
                time_started: monday + hour + 60000,
                time_ended: monday + hour + 61000,
                credential_id: "cred_secret_a",
                outcome: "failure",
                output_started: false,
                tokens_input: 50,
                ...ModelRouteLog.failureFields({ _tag: "QuotaExceeded", message: "quota" }),
            }),
            attempt({ time_started: monday + 3 * hour, time_ended: monday + 3 * hour + 500, tokens_input: 7 }),
            attempt({
                time_started: monday + 25 * hour,
                time_ended: monday + 25 * hour + 500,
                provider_id: "anthropic",
                model_id: "claude-x",
                credential_id: "cred_secret_b",
                tokens_input: 200,
                tokens_output: 20,
                tokens_cache_read: 5,
                tokens_cache_write: 1,
                cost_usd: 1.25,
            }),
        ];
        for (const row of rows)
            ModelRouteLog.record({ kind: "attempt", row });
        yield* Effect.sleep("100 millis");
        const byDay = yield* ModelRouteLog.attemptRollup(db, {
            since: monday,
            until: monday + 2 * 24 * hour,
            bucket: "day",
            group: ["provider", "credential"],
        });
        // The id never leaves the rollup: only its digest does.
        expect(JSON.stringify(byDay)).not.toContain("cred_secret");
        const keyA = ModelRouteLog.credentialKey("cred_secret_a");
        const keyB = ModelRouteLog.credentialKey("cred_secret_b");
        expect(keyA).toMatch(/^[0-9a-f]{16}$/);
        expect(byDay).toHaveLength(3);
        expect(byDay.find((row) => row.credentialKey === keyA)).toMatchObject({
            bucket: "2026-01-05",
            providerID: "openai",
            attempts: 2,
            successes: 1,
            tokensInput: 150,
            tokensOutput: 10,
            // Neither Monday row records cache tokens, so neither enters the four-way sum.
            tokensCombined: 0,
            costUsd: 0.5,
            costRows: 1,
            credentialRows: 2,
            first: monday + hour,
            last: monday + hour + 60000,
        });
        expect(byDay.find((row) => row.bucket === "2026-01-05" && row.credentialKey === null)).toMatchObject({
            attempts: 1,
            tokensInput: 7,
            credentialRows: 0,
        });
        expect(byDay.find((row) => row.credentialKey === keyB)).toMatchObject({
            bucket: "2026-01-06",
            providerID: "anthropic",
            attempts: 1,
            tokensCombined: 226,
            costUsd: 1.25,
        });
        // Dimensions that were not asked for are absent, not null.
        expect(Object.keys(byDay[0] ?? {})).not.toContain("modelID");
        // until is exclusive: a window ending exactly at Tuesday's row leaves it out.
        const beforeTuesday = yield* ModelRouteLog.attemptRollup(db, { since: monday, until: monday + 25 * hour });
        expect(beforeTuesday).toHaveLength(1);
        expect(beforeTuesday[0]).toMatchObject({ bucket: null, attempts: 3, credentialRows: 2, costRows: 1 });
        const byWeekday = yield* ModelRouteLog.attemptRollup(db, { since: monday, bucket: "dayOfWeek" });
        expect(byWeekday.map((row) => [row.bucket, row.attempts])).toEqual([
            [1, 3],
            [2, 1],
        ]);
        const byHourOfDay = yield* ModelRouteLog.attemptRollup(db, { since: monday, bucket: "hourOfDay" });
        expect(byHourOfDay.map((row) => [row.bucket, row.attempts])).toEqual([
            [1, 3],
            [3, 1],
        ]);
        const byModel = yield* ModelRouteLog.attemptRollup(db, { since: monday, group: ["model", "variant"] });
        expect(byModel.find((row) => row.variant === "high")).toMatchObject({ modelID: "gpt-6-luna", attempts: 1 });
        expect(yield* ModelRouteLog.attemptRollup(db, { since: monday + 30 * 24 * hour })).toEqual([]);
    }));
});
