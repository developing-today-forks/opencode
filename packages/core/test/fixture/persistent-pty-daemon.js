import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
export const pong = { type: "pong", instance_id: "test", pid: process.pid, protocol: 9, features: [] };
export function temporaryDirectory() {
    return Effect.acquireRelease(Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-pty-test-"))), (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })));
}
export function listen(socketPath, handle) {
    return Effect.acquireRelease(Effect.promise(async () => {
        const sockets = new Set();
        const server = net.createServer((socket) => {
            sockets.add(socket);
            // A client may close its end (an interrupted wait) just before a reply is written.
            socket.on("error", () => { });
            socket.once("close", () => sockets.delete(socket));
            // The ownership connection stays open for later requests, such as handoff preparation, like the real daemon's.
            let owner = false;
            const serve = () => readRequest(socket).then((envelope) => {
                const owning = envelope.request.op === "own";
                if (owning)
                    owner = true;
                const response = owning ? { type: "owned" } : handle(socket, envelope.request, envelope.token);
                return Promise.resolve(response).then((response) => {
                    if (response)
                        socket.write(frame(response));
                    if (owner)
                        return serve();
                });
            });
            void serve().catch(() => socket.destroy());
        });
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        return {
            close: () => {
                sockets.forEach((socket) => socket.destroy());
                return close(server);
            },
        };
    }), (server) => Effect.promise(server.close));
}
function readRequest(socket) {
    return new Promise((resolve, reject) => {
        let pending = Buffer.alloc(0);
        const cleanup = () => {
            socket.off("data", onData);
            socket.off("end", onEnd);
            socket.off("error", onError);
        };
        const onData = (value) => {
            pending = Buffer.concat([pending, value]);
            if (pending.length < 4)
                return;
            const length = pending.readUInt32BE(0);
            if (pending.length < length + 4)
                return;
            cleanup();
            resolve(pending.subarray(4, length + 4));
        };
        const onEnd = () => {
            cleanup();
            reject(new Error("connection closed before request"));
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        socket.on("data", onData);
        socket.on("end", onEnd);
        socket.on("error", onError);
    }).then((payload) => {
        const envelope = JSON.parse(payload.toString("utf8"));
        if (!isRecord(envelope) || typeof envelope.token !== "string" || !isRecord(envelope.request))
            throw new Error("Invalid test daemon envelope");
        return { token: envelope.token, request: envelope.request };
    });
}
export function frame(value) {
    const payload = Buffer.from(JSON.stringify(value));
    const output = Buffer.allocUnsafe(payload.length + 4);
    output.writeUInt32BE(payload.length);
    payload.copy(output, 4);
    return output;
}
export function writeRegistration(directory, socket, instance = "test", token = "test") {
    return writeFile(path.join(directory, "service.json"), JSON.stringify({ instance_id: instance, pid: process.pid, protocol: 9, socket, token, features: [] }));
}
// An in-process opencode-pty that a server adopts through a handoff, so no daemon is spawned. Pipe processes
// run nothing: they stay running until `exit` or a signal ends them (SIGTERM spares those in `trap`), and
// write only what `output` gives them.
export const fakeDaemon = Effect.fn(function* () {
    const base = yield* temporaryDirectory();
    const root = path.join(base, "root");
    const directory = path.join(root, "inherited");
    const socket = path.join(base, "daemon.sock");
    const processes = [];
    const waiters = new Map();
    const failTerminate = new Set();
    const trap = new Set();
    const failCreate = { message: undefined };
    // How long a prepared handoff's ticket stays valid.
    const handoffTTL = { ms: 60000 };
    // While set, `create_pipe` answers only once it resolves, like a daemon slow to start a command.
    const holdCreate = {};
    // While set, `list` answers only once it resolves, like a busy daemon.
    const holdList = {};
    const ops = [];
    const requests = [];
    let nextID = 1;
    const find = (id) => processes.find((item) => item.id === id);
    const exit = (id, exitCode, signal) => {
        const found = find(id);
        if (!found || found.lifecycle.status !== "running")
            return;
        found.lifecycle = { status: "exited", exit_code: exitCode, signal };
        found.exited_at = Date.now();
        const reply = exited(found);
        waiters.get(id)?.forEach((connection) => connection.end(frame(reply)));
        waiters.delete(id);
    };
    // Appends to the output file and counts it, as the daemon's reader does; after `fail`, the file stops growing.
    const output = (id, text) => {
        const found = find(id);
        if (!found?.pipe)
            return;
        if (found.pipe.output_error === undefined) {
            appendFileSync(found.pipe.output_path, text);
            found.pipe.output_lines += text.split("\n").length - 1;
        }
        found.output_tail += Buffer.byteLength(text);
    };
    // The daemon going away under a waiting server: the wait connection closes without a reply.
    const drop = (id) => {
        waiters.get(id)?.forEach((connection) => connection.destroy());
        waiters.delete(id);
    };
    const fail = (id, message) => {
        const found = find(id);
        if (found?.pipe)
            found.pipe.output_error = message;
    };
    yield* listen(socket, (connection, request) => {
        ops.push(String(request.op));
        requests.push(request);
        if (request.op === "ping")
            return pong;
        if (request.op === "list") {
            const list = () => ({ type: "processes", processes: processes.filter((item) => item.mode === request.mode) });
            return holdList.until ? holdList.until.then(list) : list();
        }
        if (request.op === "get") {
            const found = find(request.id);
            if (!found)
                return { type: "error", message: `terminal ${String(request.id)} not found` };
            return { type: "process", process: found };
        }
        if (request.op === "create_pty") {
            const created = terminal(nextID++, String(request.group_id));
            processes.push(created);
            return { type: "created", process: created };
        }
        if (request.op === "create_pipe") {
            if (typeof request.cwd !== "string" || !path.isAbsolute(request.cwd))
                return { type: "error", message: "cwd must be absolute" };
            if (failCreate.message !== undefined)
                return { type: "error", message: failCreate.message };
            const create = () => {
                const created = pipe(nextID++, request);
                writeFileSync(String(request.output_path), "");
                processes.push(created);
                return { type: "created", process: created };
            };
            return holdCreate.until ? holdCreate.until.then(create) : create();
        }
        if (request.op === "control")
            return { type: "ok" };
        // Unregisters, so the server sees it stopped; it keeps serving connections already open.
        if (request.op === "shutdown") {
            rmSync(path.join(directory, "service.json"), { force: true });
            return { type: "ok" };
        }
        if (request.op === "prepare_handoff")
            return { type: "handoff", ticket: "next", expires_at: Date.now() + handoffTTL.ms };
        if (request.op === "rename") {
            const found = find(request.id);
            if (!found?.pty)
                return { type: "error", message: "terminal not found" };
            found.pty.user_title = typeof request.title === "string" && request.title !== "" ? request.title : null;
            found.pty.title = found.pty.user_title ?? "test";
            return { type: "ok" };
        }
        if (request.op === "wait") {
            const found = find(request.id);
            if (!found?.pipe)
                return { type: "error", message: `terminal ${String(request.id)} not found` };
            if (found.lifecycle.status !== "running")
                return exited(found);
            waiters.set(found.id, [...(waiters.get(found.id) ?? []), connection]);
            connection.once("close", () => waiters.set(found.id, (waiters.get(found.id) ?? []).filter((waiter) => waiter !== connection)));
            return undefined;
        }
        if (request.op === "signal") {
            const found = find(request.id);
            if (!found?.pipe)
                return { type: "error", message: `terminal ${String(request.id)} not found` };
            if (request.signal !== "SIGTERM" || !trap.has(found.id))
                exit(found.id, null, String(request.signal));
            return { type: "ok" };
        }
        if (request.op === "set_metadata") {
            const found = find(request.id);
            if (!found?.pipe || !isRecord(request.metadata))
                return { type: "error", message: `terminal ${String(request.id)} not found` };
            found.pipe.metadata = request.metadata;
            return { type: "ok" };
        }
        if (request.op === "terminate") {
            if (failTerminate.has(`pty_persistent_${request.id}`))
                return { type: "error", message: "terminate failed" };
            const index = processes.findIndex((item) => item.id === request.id);
            if (index === -1)
                return { type: "error", message: `terminal ${String(request.id)} not found` };
            const [removed] = processes.splice(index, 1);
            waiters.get(removed.id)?.forEach((waiter) => waiter.end(frame({ type: "error", message: "terminated" })));
            waiters.delete(removed.id);
            return { type: "ok" };
        }
        return { type: "error", message: `unsupported request: ${String(request.op)}` };
    });
    yield* Effect.promise(async () => {
        await mkdir(directory, { recursive: true });
        await writeRegistration(directory, socket);
    });
    return {
        failTerminate,
        failCreate,
        holdCreate,
        holdList,
        handoffTTL,
        trap,
        ops,
        requests,
        exit,
        output,
        fail,
        drop,
        processes,
        waiters: (id) => waiters.get(id)?.length ?? 0,
        options: {
            root,
            handoff: { directory, instanceID: "test", ticket: "ticket", expiresAt: Date.now() + 60000 },
        },
    };
});
export function terminal(id, groupID = "ses_test") {
    return {
        id,
        mode: "pty",
        pid: null,
        command: ["test"],
        cwd: "/tmp",
        group_id: groupID,
        lifecycle: { status: "running" },
        output_head: 0,
        output_tail: 0,
        started_at: Date.now(),
        exited_at: null,
        pty: { title: "test", user_title: null, foreground_process: null, cols: 80, rows: 24 },
    };
}
function pipe(id, request) {
    return {
        id,
        mode: "pipe",
        pid: 1000 + id,
        command: [String(request.program), ...(Array.isArray(request.args) ? request.args.map(String) : [])],
        cwd: String(request.cwd),
        group_id: String(request.group_id),
        lifecycle: { status: "running" },
        output_head: 0,
        output_tail: 0,
        started_at: Date.now(),
        exited_at: null,
        pipe: {
            output_path: String(request.output_path),
            output_lines: 0,
            metadata: isRecord(request.metadata) ? request.metadata : {},
        },
    };
}
function exited(process) {
    return {
        type: "exited",
        exit_code: process.lifecycle.exit_code ?? null,
        signal: process.lifecycle.signal,
        final_offset: process.output_tail,
        output_lines: process.pipe?.output_lines,
        output_error: process.pipe?.output_error,
        exited_at: process.exited_at ?? Date.now(),
    };
}
function close(server) {
    if (!server.listening)
        return Promise.resolve();
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
