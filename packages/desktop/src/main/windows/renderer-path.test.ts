import { describe, expect, test } from "bun:test"
import path from "node:path"
import { resolveRendererPath } from "./renderer-path"

describe("renderer path resolution", () => {
  test.each(["/%E0%A4%A", "/%zz", "/assets/%"])("returns 404 for malformed path %s", (pathname) => {
    const result = resolveRendererPath("/app/renderer", pathname)

    expect(result.kind).toBe("malformed")
    if (result.kind !== "malformed") throw new Error("Expected malformed path")
    expect(result.response.status).toBe(404)
  })

  test("decodes valid paths before resolving them", () => {
    expect(resolveRendererPath("/app/renderer", "/assets/app%2ejs")).toEqual({
      kind: "resolved",
      file: path.resolve("/app/renderer", "./assets/app.js"),
    })
  })

  test("rejects traversal after decoding", () => {
    const result = resolveRendererPath("/app/renderer", "/%2e%2e/secrets")

    expect(result.kind).toBe("rejected")
    if (result.kind !== "rejected") throw new Error("Expected path traversal rejection")
    expect(result.response.status).toBe(404)
  })
})
