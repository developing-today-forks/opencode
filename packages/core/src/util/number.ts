/**
 * Shared numeric normalisation primitives for values that arrive from
 * outside a service (#993, phase 1 of design #992). Numbers at a service
 * boundary — plugin callers, query strings, OAuth servers, provider
 * responses, config — are not integers in range: they are `undefined`,
 * `NaN`, ±Infinity, negative, fractional, or unit-confused (a lifetime in
 * milliseconds, a timeout past the `setTimeout` cliff), and each of those
 * has a hostile JS default (a negative SQLite `LIMIT` is unlimited, a
 * fractional `slice` bound returns everything, an oversized `setTimeout`
 * delay fires in ~1 ms). The per-site fixes of 2026-10-27→30 each
 * re-derived the same guard locally and the policies diverged; this module
 * is the one place each class's policy is stated, with the policy choices
 * as named parameters at the call site.
 *
 * Admission rule: a primitive joins this module only when two or more
 * boundary sites share its exact policy shape. A site a primitive cannot
 * reproduce exactly keeps its local helper and is recorded here as a
 * named exception instead of bending the primitive to fit.
 *
 * Named exceptions: none yet. (`KV.scan`'s old inline spelling is the one
 * deliberate delta: it mapped +Infinity to its 1000 ceiling and -Infinity
 * to 1, where `pageLimit` maps every non-finite value to the default —
 * the shared contract the design adopts; its pinned tests cover NaN,
 * fractional, zero, negative and over-ceiling inputs and are unchanged.)
 */

/** The largest delay `setTimeout` honours (2^31 - 1 ms, ~24.8 days, #972); a larger delay overflows and fires in ~1 ms. */
export const SET_TIMEOUT_MAX_MS = 2_147_483_647

/**
 * A page size (the `sessionListLimit` / `branchListLimit` shape): absent
 * or non-finite → `default`; otherwise truncated, floored at 1, with an
 * optional per-surface ceiling `max` (the surfaces' HTTP handlers
 * genuinely differ on whether one exists, so it stays a call-site choice).
 */
export function pageLimit(value: number | undefined, options: { default: number; max?: number }): number {
  if (value === undefined || !Number.isFinite(value)) return options.default
  const truncated = Math.max(Math.trunc(value), 1)
  return options.max === undefined ? truncated : Math.min(truncated, options.max)
}

/** A page offset (the #953 shape): absent or non-finite → 0; otherwise truncated and floored at 0. */
export function pageOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(Math.trunc(value), 0)
}

/**
 * A count that reaches an array or an external tool (the Messaging `chars`
 * shape, #957): absent or non-finite → `default`; otherwise truncated,
 * floored at 1, and capped at the documented ceiling `max` — a fractional
 * or negative count defects the receiving call instead of sizing it.
 */
export function boundedCount(value: number | undefined, options: { default: number; max: number }): number {
  if (value === undefined || !Number.isFinite(value)) return options.default
  return Math.min(Math.max(Math.trunc(value), 1), options.max)
}

/**
 * A server-supplied lifetime or interval in seconds (the `expires.ts`
 * shape): non-positive, absent or non-finite → `fallback`; a value past
 * `max` is malformed or unit-confused and takes the per-site `oversized`
 * policy — `"fallback"` (the token-lifetime choice) or `"clamp"` (the
 * device-lifetime choice) — stated at the call site instead of diverging
 * silently. Valid values pass through unchanged, fractional seconds
 * included, exactly as the per-site helpers behaved.
 */
export function serverSeconds(
  value: number | undefined,
  options: { fallback: number; max: number; oversized: "fallback" | "clamp" },
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return options.fallback
  if (value > options.max) return options.oversized === "clamp" ? options.max : options.fallback
  return value
}

/**
 * A duration handed to a timer, in milliseconds: non-positive, absent or
 * non-finite → `fallback`; otherwise truncated and clamped to `max`,
 * which defaults to the `setTimeout` cliff so no call site can
 * reintroduce the ~1 ms overflow fire (or an unbounded wait) by omission.
 */
export function timeoutMs(value: number | undefined, options: { fallback: number; max?: number }): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return options.fallback
  return Math.min(Math.trunc(value), options.max ?? SET_TIMEOUT_MAX_MS)
}
