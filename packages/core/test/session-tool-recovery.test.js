// Interrupted file-mutation calls across a restart (developing-today-forks/opencode#2670): the restart
// sweep settles them from the durable history and, for `write`, from the filesystem itself — a write
// whose recorded content already matches the file settles as success and is never repeated, a missing
// target settles as failed (verified not applied), and anything the sweep cannot prove settles as
// failed unconfirmed. The harness mirrors session-execution.test.ts: sessions are seeded in their
// suspended (claim-preserved) state with the exact durable events a dead process leaves behind.
import { describe, expect } from "bun:test";
import path from "path";
import { Context, Effect, Exit, Layer, LayerMap, Scope } from "effect";
import { Agent } from "@opencode/core/agent";
import { Bus } from "@opencode/core/bus";
import { Database } from "@opencode/core/database/database";
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder";
import { Environment } from "@opencode/core/environment/index";
import { FileAccess } from "@opencode/core/file-access";
import { Instance } from "@opencode/core/instance/service";
import { Job } from "@opencode/core/job";
import { KV } from "@opencode/core/kv";
import { LocationServiceMap } from "@opencode/core/location-service-map";
import { ID } from "@opencode/core/model";
import { Project } from "@opencode/core/project";
import { ProjectTable } from "@opencode/core/project/sql";
import { Provider } from "@opencode/core/provider";
import { AbsolutePath } from "@opencode/core/schema";
import { Session } from "@opencode/core/session";
import { SessionExecution } from "@opencode/core/session/execution";
import { SessionRestart } from "@opencode/core/session/execution/restart";
import { SessionEvent } from "@opencode/core/session/event";
import { SessionInbox } from "@opencode/core/session/inbox";
import { SessionMessage } from "@opencode/core/session/message";
import { SessionRunner } from "@opencode/core/session/runner/index";
import { SessionTable } from "@opencode/core/session/sql";
import { SessionStore } from "@opencode/core/session/store";
import { Shell } from "@opencode/core/shell";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { testEffect } from "./lib/effect";
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionStore.node, SessionInbox.node, Job.node, KV.node, Session.node])));
function seedSessions(database, sessionIDs, values = {}) {
    return Effect.gen(function* () {
        yield* database.db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie);
        yield* database.db
            .insert(SessionTable)
            .values(sessionIDs.map((id) => ({
            id,
            project_id: Project.ID.global,
            slug: id,
            directory: "/project",
            title: id,
            version: "test",
            ...values,
        })))
            .run()
            .pipe(Effect.orDie);
    });
}
/** Records a mutation call the model made that is still running, as a killed server leaves it. */
function seedMutationCall(bus, sessionID, callID, name, input) {
    return Effect.gen(function* () {
        const assistantMessageID = SessionMessage.ID.create();
        yield* bus.publish(SessionEvent.Step.Started, {
            sessionID,
            assistantMessageID,
            agent: Agent.ID.make("build"),
            model: { id: ID.make("fake-model"), providerID: Provider.ID.make("fake") },
            started: 0,
        });
        yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, id: callID, name });
        yield* bus.publish(SessionEvent.Tool.Called, {
            sessionID,
            assistantMessageID,
            id: callID,
            input,
            executed: false,
        });
        return assistantMessageID;
    });
}
function toolStates(store, sessionID) {
    return store.context(sessionID).pipe(Effect.map((messages) => messages.flatMap((message) => message.type === "assistant"
        ? message.content.flatMap((part) => (part.type === "tool" ? [part.state] : []))
        : [])));
}
/**
 * Runs the restart sweep over a suspended session whose Location resolves paths under /project in the
 * given in-memory environment: FileAccess is a pure resolver over that root, Environment is the memory
 * driver's host, so the sweep verifies writes against exactly the files the test seeded.
 */
function recover(sessionID, environment) {
    return Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const location = Layer.mergeAll(Layer.succeed(Environment.Service, environment), Layer.succeed(FileAccess.Service, FileAccess.Service.of({
            locate: (text) => Effect.succeed({
                absolute: AbsolutePath.make(path.posix.resolve("/project", text)),
                environment: { id: environment.id },
            }),
            resolve: () => Effect.die("unused"),
            authorizeExternal: () => Effect.die("unused"),
            authorizeRead: () => Effect.die("unused"),
        })));
        const context = yield* buildExecution(scope, () => Effect.void, undefined, undefined, undefined, location);
        yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions;
    });
}
describe("interrupted file mutations across a restart", () => {
    it.live("settles a write whose recorded content already matches the file as success, unrepeated", () => Effect.gen(function* () {
        const database = yield* Database.Service;
        const store = yield* SessionStore.Service;
        const bus = yield* Bus.Service;
        const sessionID = Session.ID.make("ses_recovery_write_applied");
        yield* seedSessions(database, [sessionID], { time_suspended: Date.now() });
        yield* seedMutationCall(bus, sessionID, "call-write", "write", { path: "notes.txt", content: "hello\n" });
        const driver = Environment.makeMemoryDriver();
        const files = Environment.makeFiles(driver);
        yield* files.mkdir("/project").pipe(Effect.ignore);
        yield* files.write("/project/notes.txt", new TextEncoder().encode("hello\n"));
        yield* recover(sessionID, Environment.make(Environment.localID, driver));
        expect(yield* toolStates(store, sessionID)).toMatchObject([
            {
                status: "completed",
                content: [
                    { type: "text", text: expect.stringContaining("already contains exactly the content this write recorded") },
                ],
                metadata: { recovery: "interrupted", verified: "applied" },
            },
        ]);
        // The write was not repeated: the file is byte-identical afterwards.
        expect((yield* files.read("/project/notes.txt")).bytes).toEqual(new TextEncoder().encode("hello\n"));
    }));
    it.live("settles a write whose target does not exist as failed, verified not applied", () => Effect.gen(function* () {
        const database = yield* Database.Service;
        const store = yield* SessionStore.Service;
        const bus = yield* Bus.Service;
        const sessionID = Session.ID.make("ses_recovery_write_missing");
        yield* seedSessions(database, [sessionID], { time_suspended: Date.now() });
        yield* seedMutationCall(bus, sessionID, "call-write", "write", { path: "gone.txt", content: "hello\n" });
        const driver = Environment.makeMemoryDriver();
        const files = Environment.makeFiles(driver);
        yield* files.mkdir("/project").pipe(Effect.ignore);
        yield* recover(sessionID, Environment.make(Environment.localID, driver));
        expect(yield* toolStates(store, sessionID)).toMatchObject([
            {
                status: "error",
                error: {
                    type: "tool.interrupted",
                    message: expect.stringContaining("recovery verified its target file does not exist"),
                },
                metadata: { recovery: "interrupted", verified: "not-applied" },
            },
        ]);
    }));
    it.live("settles a write whose file content differs as failed, unconfirmed", () => Effect.gen(function* () {
        const database = yield* Database.Service;
        const store = yield* SessionStore.Service;
        const bus = yield* Bus.Service;
        const sessionID = Session.ID.make("ses_recovery_write_diverged");
        yield* seedSessions(database, [sessionID], { time_suspended: Date.now() });
        yield* seedMutationCall(bus, sessionID, "call-write", "write", { path: "notes.txt", content: "hello\n" });
        const driver = Environment.makeMemoryDriver();
        const files = Environment.makeFiles(driver);
        yield* files.mkdir("/project").pipe(Effect.ignore);
        yield* files.write("/project/notes.txt", new TextEncoder().encode("someone else's text\n"));
        yield* recover(sessionID, Environment.make(Environment.localID, driver));
        expect(yield* toolStates(store, sessionID)).toMatchObject([
            {
                status: "error",
                error: {
                    type: "tool.interrupted",
                    message: expect.stringContaining("recovery could not confirm it took effect"),
                },
                metadata: { recovery: "interrupted", verified: "unverified" },
            },
        ]);
        expect((yield* files.read("/project/notes.txt")).bytes).toEqual(new TextEncoder().encode("someone else's text\n"));
    }));
    it.live("settles an interrupted edit as failed, unconfirmed, with the file untouched", () => Effect.gen(function* () {
        const database = yield* Database.Service;
        const store = yield* SessionStore.Service;
        const bus = yield* Bus.Service;
        const sessionID = Session.ID.make("ses_recovery_edit_unverified");
        yield* seedSessions(database, [sessionID], { time_suspended: Date.now() });
        yield* seedMutationCall(bus, sessionID, "call-edit", "edit", {
            path: "notes.txt",
            oldString: "hello",
            newString: "goodbye",
        });
        const driver = Environment.makeMemoryDriver();
        const files = Environment.makeFiles(driver);
        yield* files.mkdir("/project").pipe(Effect.ignore);
        yield* files.write("/project/notes.txt", new TextEncoder().encode("hello\n"));
        yield* recover(sessionID, Environment.make(Environment.localID, driver));
        expect(yield* toolStates(store, sessionID)).toMatchObject([
            {
                status: "error",
                error: {
                    type: "tool.interrupted",
                    message: expect.stringContaining("Its file effect cannot be verified from the recorded input"),
                },
                metadata: { recovery: "interrupted", verified: "unverified" },
            },
        ]);
        expect((yield* files.read("/project/notes.txt")).bytes).toEqual(new TextEncoder().encode("hello\n"));
    }));
});
function buildExecution(scope, drain, options, overrideJobs, shell, 
// Extra Location services, such as those a recovered video job continues with.
extra) {
    return Effect.gen(function* () {
        const database = yield* Database.Service;
        const bus = yield* Bus.Service;
        const store = yield* SessionStore.Service;
        const jobs = overrideJobs ?? (yield* Job.Service);
        const sessions = yield* Session.Service;
        const inbox = yield* SessionInbox.Service;
        const sessionLayer = Layer.effect(Session.Service, Effect.gen(function* () {
            const execution = yield* SessionExecution.Service;
            return Session.Service.of({
                ...sessions,
                synthetic: (input) => sessions
                    .synthetic({ ...input, resume: false })
                    .pipe(Effect.tap(() => (input.resume === false ? Effect.void : execution.wake(input.sessionID)))),
            });
        }));
        const runner = Layer.succeed(SessionRunner.Service, SessionRunner.Service.of({
            drain: (input) => drain(input).pipe(Effect.as(SessionRunner.DrainResult.Complete())),
        }));
        const locations = Layer.effect(LocationServiceMap.Service, LayerMap.make(() => 
        // The local execution test only needs the Session runner (and the Shell, if given) from the Location graph.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        Layer.mergeAll(runner, shell ? Layer.succeed(Shell.Service, shell) : Layer.empty, extra ?? Layer.empty)));
        return yield* Layer.buildWithScope(SessionRestart.layer(options).pipe(Layer.provideMerge(sessionLayer), Layer.provideMerge(Layer.fresh(SessionExecution.layer)), Layer.provide(Layer.succeed(Database.Service, database)), Layer.provide(Layer.succeed(Bus.Service, bus)), Layer.provide(Layer.succeed(SessionStore.Service, store)), Layer.provide(Layer.succeed(Job.Service, jobs)), Layer.provide(Layer.succeed(Shell.Daemon, Shell.Daemon.of({
            at: () => Effect.die("the harness has no daemon registry"),
            watch: (effect) => effect.pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid),
            handoffPrepared: () => false,
        }))), Layer.provide(Layer.succeed(SessionInbox.Service, inbox)), 
        // Do not reuse the outer harness's selector with its already-captured Location map.
        Layer.provide(AppNodeBuilder.build(Instance.node, [LocationServiceMap.node.replace(locations)]).pipe(Layer.fresh))), scope);
    });
}
