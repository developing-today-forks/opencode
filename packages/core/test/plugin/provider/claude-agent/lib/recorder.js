import * as Recorder_1 from "./recorder";
export { Recorder_1 as Recorder };
import { readFileSync } from "node:fs";
import path from "node:path";
const DIRECTORY = path.join(import.meta.dir, "../fixtures/recordings");
// Never retain thinking, including signed or redacted blocks and echoed input history.
export function parse(line) {
    return JSON.parse(line, (_key, value) => {
        if (!value || typeof value !== "object")
            return value;
        if (Array.isArray(value))
            return value.filter((item) => item !== undefined);
        if (value.type === "thinking" ||
            value.type === "thinking_delta" ||
            value.type === "redacted_thinking" ||
            value.type === "signature_delta")
            return undefined;
        if (value.type === "reasoning" ||
            value.type === "reasoning-start" ||
            value.type === "reasoning-delta" ||
            value.type === "reasoning-end")
            return undefined;
        if (value.type === "content_block_start" && value.content_block === undefined)
            return undefined;
        if (value.type === "content_block_delta" && value.delta === undefined)
            return undefined;
        if (value.type === "stream_event" && value.event === undefined)
            return undefined;
        return value;
    });
}
// What `claude` answered to the SDK's first start-up request
export function startupReply(lines) {
    const line = lines.find((line) => line.from === "claude" && line.message.type === "control_response");
    return line?.from === "claude" ? line.message.response.response : undefined;
}
export function load(name) {
    const text = readFileSync(path.join(DIRECTORY, `${name}.jsonl`), "utf8");
    // The first line is the header
    return text
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => JSON.parse(line));
}
// An independent usage oracle for tests: the CLI's result, rather than our stream converter.
export function result(name, index = 0) {
    const line = load(name).filter((line) => line.from === "claude" && line.message.type === "result")[index];
    if (line?.from === "claude")
        return line.message;
    throw new Error(`No result ${index} in ${name}`);
}
