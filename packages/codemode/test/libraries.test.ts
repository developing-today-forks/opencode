import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Std, Tool } from "../src/index.js"

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
