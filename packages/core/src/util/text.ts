export * as Text from "./text.js"

/**
 * A cut at an index splits a surrogate pair when the code unit before it is
 * a high surrogate and the one at it is that pair low half: keeping either
 * side alone leaves ill-formed text that re-encodes as U+FFFD (#1966). The
 * house rule is to never split a pair, so a straddling pair is dropped whole.
 *
 * Shared home (#1973): this guard used to live in messaging/log.ts, so
 * truncations outside messaging (session titles, codemode catalog, embedding
 * clips, LLM input excerpts, route-log bodies, ripgrep match text) each
 * sliced at raw code-unit offsets and could emit a lone surrogate. Every
 * truncation now cuts through here.
 */
export const splitsPair = (text: string, index: number) =>
  index > 0 &&
  index < text.length &&
  text.charCodeAt(index - 1) >= 0xd800 &&
  text.charCodeAt(index - 1) <= 0xdbff &&
  text.charCodeAt(index) >= 0xdc00 &&
  text.charCodeAt(index) <= 0xdfff

/** Truncates to at most limit code units, dropping a straddling surrogate pair whole. Budgets are unchanged. */
export const truncate = (text: string, limit: number) =>
  text.length <= limit ? text : text.slice(0, splitsPair(text, limit) ? limit - 1 : limit)
