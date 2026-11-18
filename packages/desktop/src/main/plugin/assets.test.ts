import { describe, expect, test } from "bun:test"
import { openDatabase } from "../storage/database"
import { extension, extensionFile } from "../storage/schema"
import { extensionAsset } from "./assets"

describe("extension assets", () => {
  test.each([
    { name: "malformed extension id", url: "oc://extensions/%zz/assets/app.js" },
    { name: "invalid UTF-8 extension id", url: "oc://extensions/%E0%A4%A/assets/app.js" },
    { name: "invalid UTF-8 asset path", url: "oc://extensions/my-ext/assets/%E0%A4%A" },
    { name: "trailing percent in asset path", url: "oc://extensions/my-ext/assets/%" },
  ])("returns 404 for a $name", ({ url: input }) => {
    const database = openDatabase(":memory:")

    try {
      const url = new URL(input)
      const response = extensionAsset(database.db, new Request(url), url)

      expect(response.status).toBe(404)
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*")
    } finally {
      database.close()
    }
  })

  test("decodes valid ids and paths before serving byte ranges", async () => {
    const database = openDatabase(":memory:")

    try {
      database.db.insert(extension).values({ id: "my ext", enabled: true }).run()
      database.db
        .insert(extensionFile)
        .values({ extension_id: "my ext", path: "assets/app.js", data: Buffer.from("hello") })
        .run()

      const url = new URL("oc://extensions/my%20ext/assets/app%2ejs")
      const request = new Request(url, { headers: { range: "bytes=1-3" } })
      const response = extensionAsset(database.db, request, url)

      expect({
        status: response.status,
        contentRange: response.headers.get("Content-Range"),
        contentLength: response.headers.get("Content-Length"),
        body: await response.text(),
      }).toEqual({ status: 206, contentRange: "bytes 1-3/5", contentLength: "3", body: "ell" })
    } finally {
      database.close()
    }
  })
})
