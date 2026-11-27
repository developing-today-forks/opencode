import { Environment } from "@opencode/core/environment/index";
import { Machine } from "@opencode/core/machine/index";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
/**
 * A worker in memory that keeps the worker's rules: files on a memory driver, scripted processes, and controls to
 * cut, restore and redial the connection, drop the next message of a type heading either way, and restart. Its
 * connections are served in the caller's scope.
 */
export const makeWorker = (host) => Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const files = Environment.makeMemoryDriver();
    const fs = Environment.makeFiles(files);
    const runs = [];
    /** Every message that reached the worker. */
    const received = [];
    const drops = [];
    let instance = Machine.Instance.make(crypto.randomUUID());
    let table = new Map();
    /** Processes the next hello still lists, then forgets before the home can attach. */
    const forgetting = new Set();
    let link;
    const dropped = (direction, type) => {
        const index = drops.findIndex((drop) => drop.direction === direction && drop.type === type);
        if (index !== -1)
            drops.splice(index, 1);
        return index !== -1;
    };
    const emit = (message) => {
        if (link?.open && !dropped("home", message.type))
            Queue.offerUnsafe(link.queue, message);
    };
    // Sends what an attachment has not seen, then the exit once everything is sent.
    const flush = (process) => {
        if (process.sent === undefined)
            return;
        const from = process.sent;
        process.sent = process.output.length;
        for (const chunk of process.chunks) {
            if (chunk.offset + chunk.data.length <= from)
                continue;
            const skip = Math.max(0, from - chunk.offset);
            emit({
                type: "output",
                id: process.run.id,
                ...chunk,
                offset: chunk.offset + skip,
                data: chunk.data.subarray(skip),
            });
        }
        if (!process.ended)
            return;
        process.sent = undefined;
        emit({ type: "exit", id: process.run.id, bytes: process.output.length, ...process.ended });
    };
    const start = (message) => {
        if (table.has(message.id))
            return emit({ type: "failed", id: message.id, request: "start", message: "exists" });
        const process = {
            output: new Uint8Array(),
            chunks: [],
            sent: 0,
            run: {
                id: message.id,
                pid: 1000 + runs.length,
                argv: message.argv,
                cwd: message.cwd,
                env: message.env,
                traps: new Set(),
                input: [],
                inputReceived: Deferred.makeUnsafe(),
                inputClosed: !message.stdin,
                print: (output, stream) => Effect.sync(() => {
                    const bytes = typeof output === "string" ? new TextEncoder().encode(output) : output;
                    process.chunks.push({ offset: process.output.length, data: bytes, stream: stream ?? "stdout" });
                    const next = new Uint8Array(process.output.length + bytes.length);
                    next.set(process.output);
                    next.set(bytes, process.output.length);
                    process.output = next;
                    flush(process);
                }),
                exit: (code) => Effect.sync(() => {
                    process.ended = { code };
                    flush(process);
                }),
            },
        };
        table.set(message.id, process);
        runs.push(process.run);
        emit({ type: "started", id: message.id, pid: process.run.pid });
    };
    const answer = (message) => {
        switch (message.call) {
            case "stat":
                return fs.stat(message.path);
            case "list":
                return fs.list(message.path);
            case "read":
                return fs.read(message.path, message.range);
            case "write":
                return fs.write(message.path, message.bytes).pipe(Effect.as(null));
            case "append":
                return fs.append(message.path, message.bytes).pipe(Effect.as(null));
            case "remove":
                return fs.remove(message.path).pipe(Effect.as(null));
            case "mkdir":
                return fs.mkdir(message.path).pipe(Effect.as(null));
            case "move":
                return fs.move(message.from, message.to).pipe(Effect.as(null));
        }
    };
    const receive = (message) => {
        if (dropped("worker", message.type))
            return;
        received.push(message);
        if (message.type === "start")
            return start(message);
        if (message.type === "fs")
            return emit(
            // The memory driver answers synchronously.
            Effect.runSync(answer(message).pipe(Effect.match({
                onSuccess: (result) => ({ type: "fs", req: message.req, ok: true, result }),
                onFailure: (error) => ({
                    type: "fs",
                    req: message.req,
                    ok: false,
                    error: error._tag === "Environment.NotFound"
                        ? { kind: "not_found", message: error.message }
                        : error._tag === "Environment.WrongKind"
                            ? { kind: "wrong_kind", message: error.message, actual: error.actual }
                            : { kind: "failed", message: String(error.cause) },
                }),
            }))));
        if (message.type === "release") {
            table.delete(message.id);
            return;
        }
        const process = table.get(message.id);
        if (message.type === "stdin") {
            if (!process || process.run.inputClosed || process.ended)
                return emit({ type: "stdin", id: message.id, req: message.req, ok: false, message: "Broken pipe" });
            if (message.data === null)
                process.run.inputClosed = true;
            else
                process.run.input.push(message.data);
            emit({ type: "stdin", id: message.id, req: message.req, ok: true });
            Deferred.doneUnsafe(process.run.inputReceived, Effect.void);
            return;
        }
        if (!process)
            return emit({ type: "failed", id: message.id, request: message.type, message: "unknown process" });
        if (message.type === "kill" && process.ended)
            return emit({ type: "failed", id: message.id, request: "kill", message: "already exited" });
        if (message.type === "attach")
            process.sent = message.from;
        if (message.type === "kill" && !process.run.traps.has(message.signal))
            process.ended = { code: null, signal: message.signal };
        flush(process);
    };
    // The worker stops using its connection, and its attachments end with it.
    const leave = () => {
        const current = link;
        link = undefined;
        if (current)
            current.open = false;
        table.forEach((process) => (process.sent = undefined));
        return current;
    };
    // The home sees the connection close; what was already sent still arrives.
    const close = (current) => Effect.gen(function* () {
        if (!current)
            return;
        Queue.endUnsafe(current.queue);
        if (current.fiber)
            yield* Fiber.join(current.fiber);
    });
    const cut = Effect.suspend(() => close(leave()));
    const dial = Effect.gen(function* () {
        const current = { open: true, queue: yield* Queue.unbounded() };
        const hello = {
            type: "hello",
            protocol: 2,
            os: "linux",
            arch: "x64",
            home: "/home/worker",
            instance,
            processes: [...table.values()].map((process) => ({
                id: process.run.id,
                pid: process.run.pid,
                bytes: process.output.length,
                ...(process.ended ? { state: "exited", ...process.ended } : { state: "running" }),
            })),
        };
        forgetting.forEach((processID) => table.delete(processID));
        forgetting.clear();
        // Live before the machine sees the hello, so what it sends while handling the hello is answered.
        link = current;
        current.fiber = yield* Effect.forkIn(host.connect({
            hello,
            send: (message) => {
                if (current.open)
                    receive(message);
            },
            messages: Stream.fromQueue(current.queue),
        }), scope, { startImmediately: true });
    });
    return {
        files,
        runs,
        received,
        cut,
        restore: Effect.andThen(cut, dial),
        /** Dials again before the home notices the old connection is gone. Returns what closes the old one. */
        redial: Effect.suspend(() => {
            const old = leave();
            return Effect.as(dial, close(old));
        }),
        /** A new worker process: new instance, no processes, then it dials in again. */
        restart: Effect.gen(function* () {
            yield* cut;
            instance = Machine.Instance.make(crypto.randomUUID());
            table = new Map();
            yield* dial;
        }),
        /** Forgets a process, as a worker may once it has run a while. */
        forget: (processID) => table.delete(processID),
        /** Forgets a process after listing it in the next hello, before the home can attach to it. */
        forgetAfterHello: (processID) => forgetting.add(processID),
        /** Drops the next message of `type` heading to `direction`. */
        drop: (direction, type) => drops.push({ direction, type }),
    };
});
