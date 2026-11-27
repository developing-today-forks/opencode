import * as Expected_1 from "./session-message.js";
export { Expected_1 as Expected };
// Partial expected values, not input fixtures. Keep each assertion's matcher and fields explicit.
export const user = (text) => ({ type: "user", text });
export const text = (text) => ({ type: "text", text });
export const reasoning = (text) => ({ type: "reasoning", text });
export const assistant = (fields, content) => ({
    ...fields,
    type: "assistant",
    content,
});
export const completedTool = (identity, fields) => ({
    ...identity,
    type: "tool",
    state: { ...fields, status: "completed" },
});
export const failedTool = (identity, fields) => ({
    ...identity,
    type: "tool",
    state: { ...fields, status: "error" },
});
