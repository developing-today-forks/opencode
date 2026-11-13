import type { Library } from "./codemode.js"

export const name = "std"
export const version = "1.0.0"

// Program-side helpers in the interpreter's supported subset. No imports:
// every helper below runs as plain program code so tool wrappers keep their
// original call identity. The async helpers (phase 2) are program code too;
// the one thing program code cannot do — wait — goes through the host sleep
// primitive the runtime may provide under the internal global named by
// `sleepHostGlobal`, wrapped here as `std.sleep` and never exposed to
// programs under its own name.
export const source = `
const version = "1.0.0";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(label + " expects an array.");
  return value;
}

function iterateeFn(iteratee, label) {
  if (typeof iteratee === "function") return iteratee;
  if (typeof iteratee === "string") {
    return (item) => (item !== null && typeof item === "object" ? item[iteratee] : undefined);
  }
  throw new TypeError(label + " iteratee must be a function or a property name string.");
}

function chunk(array, size) {
  requireArray(array, "std.chunk");
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    throw new TypeError("std.chunk size must be a positive integer.");
  }
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function uniqBy(array, iteratee) {
  requireArray(array, "std.uniqBy");
  const fn = iterateeFn(iteratee, "std.uniqBy");
  const seen = new Map();
  const out = [];
  for (let i = 0; i < array.length; i += 1) {
    const item = array[i];
    const key = fn(item, i, array);
    if (!seen.has(key)) {
      seen.set(key, true);
      out.push(item);
    }
  }
  return out;
}

function keyBy(array, iteratee) {
  requireArray(array, "std.keyBy");
  const fn = iterateeFn(iteratee, "std.keyBy");
  const out = {};
  for (let i = 0; i < array.length; i += 1) {
    const item = array[i];
    out[String(fn(item, i, array))] = item;
  }
  return out;
}

function pick(obj, keys) {
  if (obj === null || obj === undefined) throw new TypeError("std.pick expects an object.");
  if (!Array.isArray(keys)) throw new TypeError("std.pick keys must be an array.");
  const out = {};
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError("std.pick keys must be strings.");
    if (Object.hasOwn(obj, key)) out[key] = obj[key];
  }
  return out;
}

function omit(obj, keys) {
  if (obj === null || obj === undefined) throw new TypeError("std.omit expects an object.");
  if (!Array.isArray(keys)) throw new TypeError("std.omit keys must be an array.");
  const skip = new Set(keys);
  const out = {};
  for (const key of Object.keys(obj)) {
    if (!skip.has(key)) out[key] = obj[key];
  }
  return out;
}

function mergeInput(defaults, input) {
  if (input === undefined) return { ...defaults };
  if (isObject(input)) return { ...defaults, ...input };
  return input;
}

function bind(target, defaults) {
  if (defaults === undefined) defaults = {};
  if (!isObject(defaults)) throw new TypeError("std.bind defaults must be an object.");
  if (typeof target !== "function" && (typeof target !== "object" || target === null)) {
    throw new TypeError("std.bind target must be a tool or namespace object.");
  }
  if (typeof target === "function") {
    const bound = (input) => target(mergeInput(defaults, input));
    let collision = false;
    for (const key of Object.keys(target)) {
      try {
        bound[key] = bind(target[key], defaults);
      } catch {
        // A child named "name" or "length" cannot be assigned over a
        // function's read-only metadata; fall back to the namespace form.
        collision = true;
        break;
      }
    }
    if (!collision) return bound;
    const out = {};
    for (const key of Object.keys(target)) out[key] = bind(target[key], defaults);
    return out;
  }
  const out = {};
  for (const key of Object.keys(target)) {
    const value = target[key];
    if (typeof value === "function") out[key] = bind(value, defaults);
    else if (value !== null && typeof value === "object") out[key] = bind(value, defaults);
    else out[key] = value;
  }
  return out;
}

// The host sleep primitive, captured once at library evaluation. Runtimes
// without the sleep extension leave std.sleep present but rejecting, so a
// program can feature-check instead of dying on an unknown global.
const hostSleep = (() => {
  try {
    return __opencode_sleep;
  } catch {
    return undefined;
  }
})();

async function sleep(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new TypeError("std.sleep ms must be a non-negative finite number.");
  }
  if (typeof hostSleep !== "function") {
    throw new Error("std.sleep is unavailable: this execution has no sleep host primitive.");
  }
  // A host primitive may cap a single wait (core caps one call at 30s), so a
  // single call can return before the requested time has elapsed. Measure
  // against Date.now and keep waiting out the remainder instead of silently
  // shortening the sleep: deadlines built on sleep (withTimeout, retry
  // delays) must fire at the requested time, not at the host cap.
  const start = Date.now();
  let remaining = ms;
  while (remaining > 0) {
    await hostSleep(remaining);
    remaining = ms - (Date.now() - start);
  }
}

async function mapLimit(items, limit, fn) {
  requireArray(items, "std.mapLimit");
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("std.mapLimit limit must be a positive integer.");
  }
  if (typeof fn !== "function") throw new TypeError("std.mapLimit fn must be a function.");
  const results = new Array(items.length);
  let next = 0;
  let failure;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index], index, items);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  }
  const workers = [];
  const count = Math.min(limit, items.length);
  for (let i = 0; i < count; i += 1) workers.push(worker());
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}

async function retry(fn, options) {
  if (typeof fn !== "function") throw new TypeError("std.retry fn must be a function.");
  const opts = options === undefined ? {} : options;
  if (!isObject(opts)) throw new TypeError("std.retry options must be an object.");
  const attempts = opts.attempts === undefined ? 3 : opts.attempts;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts <= 0) {
    throw new TypeError("std.retry attempts must be a positive integer.");
  }
  const delayMs = opts.delayMs === undefined ? 0 : opts.delayMs;
  if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0) {
    throw new TypeError("std.retry delayMs must be a non-negative finite number.");
  }
  const backoff = opts.backoff === undefined ? 1 : opts.backoff;
  if (typeof backoff !== "number" || !Number.isFinite(backoff) || backoff < 1) {
    throw new TypeError("std.retry backoff must be a finite number of at least 1.");
  }
  const shouldRetry = opts.shouldRetry;
  if (shouldRetry !== undefined && typeof shouldRetry !== "function") {
    throw new TypeError("std.retry shouldRetry must be a function.");
  }
  let delay = delayMs;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      if (shouldRetry !== undefined && !shouldRetry(error, attempt)) break;
      if (delay > 0) await sleep(delay);
      delay = delay * backoff;
    }
  }
  throw lastError;
}

async function withTimeout(input, ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new TypeError("std.withTimeout ms must be a non-negative finite number.");
  }
  const promise = typeof input === "function" ? input() : input;
  const timeout = sleep(ms).then(() => {
    throw new Error(
      "std.withTimeout timed out after " + ms + "ms. The underlying work was not cancelled and may still complete.",
    );
  });
  return Promise.race([promise, timeout]);
}

return Object.freeze({ version, bind, chunk, uniqBy, keyBy, pick, omit, sleep, mapLimit, retry, withTimeout });
`

export const library: Library = { name, version, source }

/**
 * The internal global a runtime's sleep host extension provides and the std
 * source wraps as `std.sleep`. Deliberately not a program-facing name: the
 * only surface programs are told about is `std.sleep` itself.
 */
export const sleepHostGlobal = "__opencode_sleep"
