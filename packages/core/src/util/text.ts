export * as Text from "./text.js"

/**
 * Re-export of the `@opencode/util` truncation primitive (design
 * #2208, phase 1 / #2209): the shared guard and helpers now live in
 * `packages/util/src/text.ts` — the lowest layer, the one package
 * `ai`, `core`, `tui` and `util` itself can all import — and this
 * module re-exports them behaviour-identically, so core's landed call
 * sites (`messaging/log.ts`'s re-export of `Text.splitsPair`,
 * `messaging.ts`, `session/title.ts`, and the #2135-migrated sites)
 * keep their imports and their behaviour untouched. The contract and
 * the cross-package truncation inventory live with the primitive in
 * the util module header.
 */
export { splitsPair, truncate, truncateMiddle, truncateTail } from "@opencode/util/text"
