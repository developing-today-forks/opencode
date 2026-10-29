import type { Library } from "./codemode.js"

export const name = "std"
export const version = "1.0.0"

// Pure program-side helpers in the interpreter's supported subset. No imports,
// no async helpers (phase 2), no host calls: every helper below runs as plain
// program code so tool wrappers keep their original call identity.
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
    if (key in obj) out[key] = obj[key];
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

return Object.freeze({ version, bind, chunk, uniqBy, keyBy, pick, omit });
`

export const library: Library = { name, version, source }
