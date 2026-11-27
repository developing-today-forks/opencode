import { spawn } from "child_process";
import path from "path";
const root = path.join(import.meta.dir, "../..");
export function runLockWorker(entrypoint, payload) {
    return new Promise((resolve) => {
        const proc = spawn(process.execPath, [entrypoint, JSON.stringify(payload)], { cwd: root });
        const stdout = [];
        const stderr = [];
        proc.stdout?.on("data", (data) => stdout.push(Buffer.from(data)));
        proc.stderr?.on("data", (data) => stderr.push(Buffer.from(data)));
        proc.on("close", (code) => {
            resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
        });
    });
}
export function spawnLockWorker(entrypoint, payload) {
    return spawn(process.execPath, [entrypoint, JSON.stringify(payload)], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
    });
}
export async function stopLockWorker(proc) {
    if (proc.exitCode !== null || proc.signalCode !== null)
        return;
    const closed = new Promise((resolve) => proc.once("close", () => resolve()));
    if (process.platform !== "win32" || !proc.pid) {
        proc.kill();
        await closed;
        return;
    }
    await new Promise((resolve) => {
        const killProc = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
        killProc.on("close", () => {
            proc.kill();
            resolve();
        });
    });
    await closed;
}
export async function waitForFile(file, timeout = 3000) {
    const stop = Date.now() + timeout;
    while (Date.now() < stop) {
        if (await Bun.file(file).exists())
            return;
        await Bun.sleep(20);
    }
    throw new Error(`Timed out waiting for file: ${file}`);
}
