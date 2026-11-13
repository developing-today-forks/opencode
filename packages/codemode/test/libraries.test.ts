import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Extension, Std, Tool } from "../src/index.js"

const runWithStd = (code: string) =>
  Effect.runPromise(CodeMode.make({ libraries: [Std.library] }).execute(code))

const valueWithStd = async (code: string) => {
  const result = await runWithStd(code)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

describe("program-source libraries", () => {
  test("exposes std.version and the pure helpers", async () => {
    expect(await valueWithStd(`return std.version`)).toBe("1.0.0")
    expect(await valueWithStd(`return std.chunk([1, 2, 3, 4, 5], 2)`)).toEqual([[1, 2], [3, 4], [5]])
    expect(await valueWithStd(`return std.chunk([], 3)`)).toEqual([])
    expect(
      await valueWithStd(`return std.uniqBy([{ id: 1 }, { id: 1 }, { id: 2 }], (row) => row.id)`),
    ).toEqual([{ id: 1 }, { id: 2 }])
    expect(await valueWithStd(`return std.uniqBy([{ id: 1 }, { id: 1 }], "id")`)).toEqual([{ id: 1 }])
    expect(await valueWithStd(`return std.keyBy([{ id: "a", v: 1 }, { id: "b", v: 2 }], "id")`)).toEqual({
      a: { id: "a", v: 1 },
      b: { id: "b", v: 2 },
    })
    expect(await valueWithStd(`return [std.pick({ a: 1, b: 2 }, ["a"]), std.omit({ a: 1, b: 2 }, ["a"])]`)).toEqual([
      { a: 1 },
      { b: 2 },
    ])
  })

  test("std.pick copies only own properties, never prototype-chain members", async () => {
    // Prototype-named keys are not fabricated from Object.prototype.
    for (const key of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(await valueWithStd(`return std.pick({}, ["${key}"])`)).toEqual({})
    }
    // Inherited data properties are not copied.
    expect(
      await valueWithStd(
        `const proto = { inherited: 1 }; const obj = Object.create(proto); obj.own = 2; return std.pick(obj, ["inherited", "own"])`,
      ),
    ).toEqual({ own: 2 })
    // Keys simply absent from the object are skipped, not fabricated (ported from closed #859).
    expect(await valueWithStd(`return std.pick({ a: 1 }, ["a", "missing"])`)).toEqual({ a: 1 })
    // An own property literally named "constructor" is still copied.
    expect(await valueWithStd(`return std.pick({ constructor: 42 }, ["constructor"])`)).toEqual({ constructor: 42 })
    // An own "__proto__" data property is still picked as a key.
    expect(
      await valueWithStd(
        `const obj = Object.create(null); obj["__proto__"] = 7; return Object.keys(std.pick(obj, ["__proto__"]))`,
      ),
    ).toEqual(["__proto__"])
    // pick and omit agree on the key set of the same object.
    expect(
      await valueWithStd(
        `const obj = { a: 1, b: 2, c: 3 }; return [Object.keys(std.pick(obj, ["a", "b"])).sort(), Object.keys(std.omit(obj, ["a", "b"])).sort()]`,
      ),
    ).toEqual([["a", "b"], ["c"]])
  })

  test("freezes the library namespace and its global binding", async () => {
    expect(await valueWithStd(`return Object.isFrozen(std)`)).toBe(true)
    expect(await valueWithStd(`try { std.extra = 1; return "wrote" } catch { return "frozen" }`)).toBe("frozen")
    expect(await valueWithStd(`try { std = 1; return "wrote" } catch { return "readonly" }`)).toBe("readonly")
  })

  test("leaves programs that never touch std exactly as today", async () => {
    const plain = await Effect.runPromise(CodeMode.execute({ code: `return [1, 2].map((n) => n * 2)` }))
    const withLibrary = await runWithStd(`return [1, 2].map((n) => n * 2)`)
    expect(withLibrary).toStrictEqual(plain)
  })

  test("reports the program's own line and column after library installation", async () => {
    const result = await runWithStd(`const rows = std.chunk([1, 2], 2)\nreturn missing()`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.location).toEqual({ line: 2, column: 8 })
  })

  test("rejects library names that are not identifiers or that collide", async () => {
    expect(() =>
      CodeMode.make({ libraries: [{ name: "not-a-name", version: "1.0.0", source: `return {}` }] }),
    ).toThrow('Library name "not-a-name" must be a valid JavaScript identifier.')
    expect(() => CodeMode.make({ libraries: [Std.library, Std.library] })).toThrow(
      'Library "std" is already defined.',
    )
    expect(() => CodeMode.make({ libraries: [{ name: "Array", version: "1.0.0", source: `return {}` }] })).toThrow(
      'Library "Array" global is already defined.',
    )
    for (const reserved of ["class", "return", "this"]) {
      expect(() =>
        CodeMode.make({ libraries: [{ name: reserved, version: "1.0.0", source: `return {}` }] }),
      ).toThrow(`Library name "${reserved}" must be a valid JavaScript identifier.`)
    }
  })

  test("leaves top-level this undefined", async () => {
    expect(await valueWithStd(`return typeof this`)).toBe("undefined")
  })
})

describe("std.bind", () => {
  const echo = Tool.make({
    description: "Echo with profile",
    input: Schema.Struct({ text: Schema.String, aws_profile: Schema.optionalKey(Schema.String) }),
    output: Schema.String,
    execute: (input) => Effect.succeed(`${input.aws_profile ?? "none"}:${input.text}`),
  })

  const bindRuntime = (hooks?: CodeMode.Hooks) =>
    CodeMode.make({ tools: { host: { echo } }, libraries: [Std.library], ...(hooks ? { hooks } : {}) })

  test("applies namespace defaults and lets explicit args win", async () => {
    const runtime = bindRuntime()
    const applied = await Effect.runPromise(
      runtime.execute(`const bound = std.bind(tools.host, { aws_profile: "dev" }); return await bound.echo({ text: "hi" })`),
    )
    expect(applied).toMatchObject({ ok: true, value: "dev:hi", toolCalls: [{ name: "host.echo" }] })
    const explicit = await Effect.runPromise(
      runtime.execute(
        `const bound = std.bind(tools.host, { aws_profile: "dev" }); return await bound.echo({ text: "hi", aws_profile: "prod" })`,
      ),
    )
    expect(explicit).toMatchObject({ ok: true, value: "prod:hi" })
  })

  test("binds namespace children named name and length", async () => {
    const runtime = CodeMode.make({
      tools: { api: { name: echo, length: echo } },
      libraries: [Std.library],
    })
    const named = await Effect.runPromise(
      runtime.execute(`const bound = std.bind(tools.api, {}); return await bound.name({ text: "n" })`),
    )
    expect(named).toMatchObject({ ok: true, value: "none:n", toolCalls: [{ name: "api.name" }] })
    const lengthed = await Effect.runPromise(
      runtime.execute(`const bound = std.bind(tools.api, {}); return await bound.length({ text: "l" })`),
    )
    expect(lengthed).toMatchObject({ ok: true, value: "none:l", toolCalls: [{ name: "api.length" }] })
  })

  test("wraps a single tool callable and records the original tool", async () => {
    const seen: Array<CodeMode.ToolInvocation> = []
    const runtime = bindRuntime({ "tool.before": (call) => Effect.sync(() => void seen.push(call)) })
    const result = await Effect.runPromise(
      runtime.execute(`const bound = std.bind(tools.host.echo, { aws_profile: "dev" }); return await bound({ text: "hi" })`),
    )
    expect(result).toMatchObject({ ok: true, value: "dev:hi", toolCalls: [{ name: "host.echo" }] })
    expect(seen).toEqual([{ name: "host.echo", input: { text: "hi", aws_profile: "dev" } }])
  })
})

describe("std async helpers (#803)", () => {
  // A test sleep primitive standing in for core's sleep extension: it records
  // every requested delay and actually waits, scaled down by the tests' use
  // of small millisecond values.
  const sleepCalls: Array<number> = []
  const sleepExtension = Extension.make({
    name: "sleep",
    globals: {
      [Std.sleepHostGlobal]: async (ms: number) => {
        sleepCalls.push(ms)
        await new Promise((resolve) => setTimeout(resolve, ms))
      },
    },
  })
  const runAsync = (code: string, limits?: { timeoutMs?: number; maxToolCalls?: number }) =>
    Effect.runPromise(
      CodeMode.make({ extensions: [sleepExtension], libraries: [Std.library], limits }).execute(code),
    )
  const valueAsync = async (code: string) => {
    const result = await runAsync(code)
    if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
    return result.value
  }

  test("std.sleep waits through the host primitive and is not exposed under its own name", async () => {
    sleepCalls.length = 0
    expect(await valueAsync(`await std.sleep(5); return "slept"`)).toBe("slept")
    expect(sleepCalls).toEqual([5])
    const bare = await runAsync(`return typeof sleep`)
    expect(bare.ok).toBe(true)
    if (bare.ok) expect(bare.value).not.toBe("function")
  })

  test("std.sleep rejects unavailable when no runtime provides the primitive", async () => {
    const result = await runWithStd(`await std.sleep(1); return "slept"`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain("std.sleep is unavailable")
  })

  test("a sleep longer than the execution budget does not extend the execution", async () => {
    const result = await runAsync(`await std.sleep(60_000); return "slept"`, { timeoutMs: 50 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("TimeoutExceeded")
  })

  test("std.sleep waits out the full request when the host primitive caps a single wait", async () => {
    // A host primitive that caps one wait at 10ms, the way core caps one wait
    // at 30s: a 35ms sleep must be re-waited in segments, never shortened to
    // the cap, and a withTimeout deadline must fire at its requested time.
    const clampedCalls: Array<number> = []
    const clamped = Extension.make({
      name: "sleep",
      globals: {
        [Std.sleepHostGlobal]: async (ms: number) => {
          clampedCalls.push(ms)
          await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)))
        },
      },
    })
    const runClamped = (code: string) =>
      Effect.runPromise(CodeMode.make({ extensions: [clamped], libraries: [Std.library] }).execute(code))
    const slept = await runClamped("const start = Date.now(); await std.sleep(35); return Date.now() - start")
    expect(slept.ok).toBe(true)
    if (slept.ok) expect(slept.value as number).toBeGreaterThanOrEqual(30)
    expect(clampedCalls.length).toBeGreaterThanOrEqual(3)
    const timed = await runClamped(`
      const start = Date.now();
      let rejectedAt = -1;
      const slow = (async () => { await std.sleep(45); return "slow"; })();
      try {
        await std.withTimeout(slow, 25);
      } catch {
        rejectedAt = Date.now() - start;
      }
      return rejectedAt;
    `)
    expect(timed.ok).toBe(true)
    if (timed.ok) {
      expect(timed.value as number).toBeGreaterThanOrEqual(20)
      expect(timed.value as number).toBeLessThan(45)
    }
  })

  test("std.mapLimit bounds concurrency, preserves order, and stops starting after a rejection", async () => {
    const outcome = await valueAsync(`
      let active = 0;
      let peak = 0;
      const results = await std.mapLimit([30, 5, 20, 10], 2, async (ms) => {
        active += 1;
        peak = Math.max(peak, active);
        await std.sleep(ms);
        active -= 1;
        return ms * 2;
      });
      return [results, peak];
    `)
    expect(outcome).toEqual([[60, 10, 40, 20], 2])

    const started: Array<number> = []
    const failed = await runAsync(`
      const started = [];
      try {
        await std.mapLimit([1, 2, 3, 4], 1, async (n) => {
          started.push(n);
          if (n === 2) throw new Error("boom");
          return n;
        });
        return "no-throw";
      } catch (error) {
        return [error.message, started];
      }
    `)
    expect(failed.ok).toBe(true)
    if (failed.ok) expect(failed.value).toEqual(["boom", [1, 2]])
    expect(started).toEqual([])
  })

  test("std.retry retries rejections only, delays through std.sleep, and stops at attempts", async () => {
    sleepCalls.length = 0
    const outcome = await valueAsync(`
      let calls = 0;
      const value = await std.retry(async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient " + calls);
        return "ok-" + calls;
      }, { attempts: 5, delayMs: 5, backoff: 2 });
      return [value, calls];
    `)
    expect(outcome).toEqual(["ok-3", 3])
    expect(sleepCalls).toEqual([5, 10])

    sleepCalls.length = 0
    const exhausted = await runAsync(`
      let calls = 0;
      try {
        await std.retry(async () => { calls += 1; throw new Error("always"); }, { attempts: 2, delayMs: 1 });
        return "no-throw";
      } catch (error) {
        return [error.message, calls];
      }
    `)
    expect(exhausted.ok).toBe(true)
    if (exhausted.ok) expect(exhausted.value).toEqual(["always", 2])
    // A resolved value is never retried.
    expect(await valueAsync(`let calls = 0; const v = await std.retry(async () => { calls += 1; return 7; }); return [v, calls]`)).toEqual([7, 1])
  })

  test("std.withTimeout rejects at the deadline while the underlying work still completes", async () => {
    const outcome = await valueAsync(`
      let completed = false;
      const slow = (async () => { await std.sleep(40); completed = true; return "slow"; })();
      let message = "";
      try {
        await std.withTimeout(slow, 5);
      } catch (error) {
        message = error.message;
      }
      await std.sleep(60);
      return [message.includes("not cancelled"), completed];
    `)
    expect(outcome).toEqual([true, true])
  })

  test("tool calls inside helpers count and record exactly as direct calls", async () => {
    const echo = Tool.make({
      description: "Echo",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.String,
      execute: (input) => Effect.succeed(input.text),
    })
    const runtime = CodeMode.make({
      tools: { echo },
      extensions: [sleepExtension],
      libraries: [Std.library],
      limits: { maxToolCalls: 10 },
    })
    const result = await Effect.runPromise(
      runtime.execute(`return std.mapLimit(["a", "b", "c"], 2, async (text) => tools.echo({ text }))`),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual(["a", "b", "c"])
      expect(result.toolCalls).toEqual([{ name: "echo" }, { name: "echo" }, { name: "echo" }])
    }
    const capped = await Effect.runPromise(
      CodeMode.make({
        tools: { echo },
        extensions: [sleepExtension],
        libraries: [Std.library],
        limits: { maxToolCalls: 2 },
      }).execute(`return std.mapLimit(["a", "b", "c"], 2, async (text) => tools.echo({ text }))`),
    )
    expect(capped.ok).toBe(false)
    if (!capped.ok) {
      // The limit error surfaces through the helper's worker promise, wrapped
      // as an execution failure naming the tool call limit.
      expect(capped.error.message).toContain("tool-call limit")
      expect(capped.toolCalls).toHaveLength(2)
    }
  })
})
