import { describe, expect, test } from "bun:test"
import { Patch } from "@opencode/util/patch"
import { Result } from "effect"

const parse = (input: string) => Result.getOrThrow(Patch.parse(input))

describe("probe pure-add with changeContext", () => {
  test("parse shape", () => {
    const hunks = parse("*** Begin Patch\n*** Update File: f.txt\n@@ fn a\n+inserted\n*** End Patch")
    console.log(JSON.stringify(hunks))
  })
  test("derive anchored pure-add", () => {
    const original = "fn a\nx\nfn b\ny\n"
    const out = Patch.derive("f.txt", [{ oldLines: [], newLines: ["inserted"], changeContext: "fn a" }], original)
    console.log("ANCHORED RESULT:", JSON.stringify(out.content))
    // also via parse
    const hunks = parse("*** Begin Patch\n*** Update File: f.txt\n@@ fn a\n+inserted\n*** End Patch")
    const h = hunks[0] as any
    const out2 = Patch.derive("f.txt", h.chunks, original)
    console.log("PARSED RESULT:", JSON.stringify(out2.content))
  })
  test("derive anchored pure-add at second context", () => {
    const original = "fn a\nx\nfn b\ny\n"
    const out = Patch.derive("f.txt", [{ oldLines: [], newLines: ["inserted"], changeContext: "fn b" }], original)
    console.log("ANCHORED-B RESULT:", JSON.stringify(out.content))
  })
  test("control: context-free pure-add appends at EOF (pinned)", () => {
    const out = Patch.derive("f.txt", [{ oldLines: [], newLines: ["inserted"] }], "a\nb\n")
    console.log("CONTROL RESULT:", JSON.stringify(out.content))
    expect(out.content).toBe("a\nb\ninserted\n")
  })
  test("control: anchored replacement works", () => {
    const out = Patch.derive("f.txt", [{ oldLines: ["x=10"], newLines: ["x=11"], changeContext: "fn b" }], "fn a\nx=10\nfn b\nx=10\n")
    console.log("REPL RESULT:", JSON.stringify(out.content))
    expect(out.content).toBe("fn a\nx=10\nfn b\nx=11\n")
  })
  test("missing context pure-add: does it throw?", () => {
    try {
      const out = Patch.derive("f.txt", [{ oldLines: [], newLines: ["inserted"], changeContext: "nope" }], "a\nb\n")
      console.log("MISSING-CTX RESULT (no throw):", JSON.stringify(out.content))
    } catch (e) {
      console.log("MISSING-CTX THREW:", (e as Error).message)
    }
  })
})
