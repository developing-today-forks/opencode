import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Mcp } from "../src/mcp.js"

describe("Mcp resources", () => {
  test("decodes resource catalogs and omits absent metadata", () => {
    const value = Schema.decodeUnknownSync(Mcp.ResourceCatalog)({
      resources: [{ server: "docs", name: "Readme", uri: "docs://readme" }],
      templates: [{ server: "docs", name: "File", uriTemplate: "docs://{path}" }],
    })

    expect(Schema.encodeSync(Mcp.ResourceCatalog)(value)).toEqual({
      resources: [{ server: "docs", name: "Readme", uri: "docs://readme" }],
      templates: [{ server: "docs", name: "File", uriTemplate: "docs://{path}" }],
    })
  })

  test("preserves text and base64 blob contents", () => {
    expect(
      Schema.decodeUnknownSync(Mcp.ResourceContent)({
        server: "docs",
        uri: "docs://readme",
        contents: [
          { type: "text", uri: "docs://readme", text: "hello", mimeType: "text/plain" },
          { type: "blob", uri: "docs://logo", blob: "aGVsbG8=", mimeType: "image/png" },
        ],
      }),
    ).toEqual({
      server: "docs",
      uri: "docs://readme",
      contents: [
        { type: "text", uri: "docs://readme", text: "hello", mimeType: "text/plain" },
        { type: "blob", uri: "docs://logo", blob: "aGVsbG8=", mimeType: "image/png" },
      ],
    })
  })
})

describe("Mcp timeouts (#1077)", () => {
  const cap = 2_147_483_647

  test("decodes timeouts at and just under the setTimeout cap", () => {
    const value = Schema.decodeUnknownSync(Mcp.TimeoutConfig)({
      startup: cap,
      catalog: cap - 1,
      execution: cap,
    })
    expect(value.startup).toEqual(cap)
    expect(value.catalog).toEqual(cap - 1)
    expect(value.execution).toEqual(cap)
  })

  test.each(["startup", "catalog", "execution"] as const)(
    "rejects a %s timeout over the cap, naming the maximum",
    (field) => {
      for (const over of [2 ** 31, 10 ** 15]) {
        let message = ""
        try {
          Schema.decodeUnknownSync(Mcp.TimeoutConfig)({ [field]: over })
        } catch (error) {
          message = String(error)
        }
        expect(message).toContain(field)
        expect(message).toContain("2147483647")
      }
    },
  )

  test("rejects an oversized timeout in a server config", () => {
    expect(() =>
      Schema.decodeUnknownSync(Mcp.ServerConfig)({
        type: "local",
        command: ["server"],
        timeout: { execution: 2 ** 31 },
      }),
    ).toThrow()
  })
})
