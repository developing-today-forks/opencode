export type EnsureTiming = {
  readonly pollInterval: number
  readonly requestTimeout: number
  readonly spawnDelay: number
  readonly maxSpawnDelay: number
  readonly promiseTimeout: number
  readonly stopPollInterval: number
  readonly stopTimeout: number
}

const timings = new WeakMap<object, EnsureTiming>()

// A freshly spawned service registers in ~250 ms, so the poll cadence is a large share of the
// time a client waits for it. Probes are sequential, so the wait between them only matters while
// the connection is refused; both variants give up after promiseTimeout of wall-clock time.
export const defaultEnsureTiming: EnsureTiming = {
  pollInterval: 25,
  requestTimeout: 2_000,
  spawnDelay: 5_000,
  maxSpawnDelay: 30_000,
  promiseTimeout: 120_000,
  stopPollInterval: 50,
  stopTimeout: serverShutdownGrace() + 5_000,
}

// A server drains running sessions for OPENCODE_SHUTDOWN_GRACE_MS before it exits; the stop path
// must outwait that drain, so it mirrors the server's default and reads the same variable.
export function serverShutdownGrace() {
  // Mirror of shutdownGrace() in packages/cli/src/server-process.ts; the two copies must agree,
  // because this stop path has to outwait the server's drain. A blank value is absent, not an
  // authored 0 (#874): bare Number() reads "" as 0 and also accepts hex and exponent spellings,
  // so only a plain non-negative decimal (surrounding whitespace trimmed) names a duration;
  // anything else falls back to the default.
  const raw = process.env.OPENCODE_SHUTDOWN_GRACE_MS?.trim()
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  return Number.isFinite(value) ? value : 30_000
}

export function ensureTiming(options: object) {
  return timings.get(options) ?? defaultEnsureTiming
}

// Keep test timing out of the public lifecycle option types.
export function withEnsureTiming<A extends object>(options: A, overrides: Partial<EnsureTiming>): A {
  timings.set(options, { ...defaultEnsureTiming, ...overrides })
  return options
}
