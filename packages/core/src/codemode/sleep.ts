export * as CodeModeSleep from "./sleep.js"

import { Extension, Std } from "@opencode/codemode"

/** One host wait may not exceed this cap. std.sleep measures elapsed time and
 * re-waits the remainder, so the cap segments long sleeps instead of
 * shortening them; the execution's own timeout still bounds the total. */
const MAX_SLEEP_MS = 30_000

const sleep = async (ms: unknown) => {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0)
    throw new Error("sleep ms must be a non-negative finite number.")
  // Capped the way fetch caps itself in web.ts (AbortSignal.timeout pattern):
  // a single sleep never runs past the cap, and the execution's own timeout
  // still bounds the total wall time, so sleep loops cannot outlive it.
  await new Promise((resolve) => setTimeout(resolve, Math.min(ms, MAX_SLEEP_MS)))
}

/**
 * The one sleep host primitive (design #800 phase 2). Its global carries the
 * internal name std wraps (`Std.sleepHostGlobal`), never a program-facing
 * `sleep` global: programs see only `std.sleep`. Extension calls are not tool
 * calls and do not consume maxToolCalls.
 */
export const extension = Extension.make({ name: "sleep", globals: { [Std.sleepHostGlobal]: sleep } })
