import { describe, expect, test } from "bun:test"
import { extensionEnabled } from "@opencode/gui-extensions/sdk/bridge"
import details from "../../../../gui-extensions/src/details/index"
import context from "../../../../gui-extensions/src/context/index"
import { openDatabase } from "../storage/database"
import { extension } from "../storage/schema"
import { readEnableState } from "./enable-state"
import { createManager, downloadArchive, EXTENSION_DOWNLOAD_DEADLINE_MS } from "./manager"
import { ExtensionError } from "./error"

test.each([
  { name: "no setting", rows: [], expected: true },
  { name: "an old disabled setting", rows: [{ id: "older", enabled: false }], expected: false },
  { name: "an old enabled setting", rows: [{ id: "older", enabled: true }], expected: true },
  {
    name: "the newest old setting",
    rows: [{ id: "older", enabled: false }, { id: "previous", enabled: true }],
    expected: true,
  },
  {
    name: "the current enabled setting",
    rows: [{ id: "previous", enabled: false }, { id: "current", enabled: true }],
    expected: true,
  },
  {
    name: "the current disabled setting",
    rows: [{ id: "previous", enabled: true }, { id: "current", enabled: false }],
    expected: false,
  },
])("both hosts resolve $name from real database rows, and a new setting wins", (input) => {
  const database = openDatabase(":memory:")
  const definition = { id: "current", legacy: ["previous", "older"] }
  const manager = createManager(database.db, () => false, [definition])
  input.rows.forEach((row) => database.db.insert(extension).values(row).run())

  expect(manager.enabled(definition.id)).toBe(input.expected)
  expect(extensionEnabled(definition, readEnableState(database.db.$client))).toBe(input.expected)

  const before = database.db.select().from(extension).all()

  manager.setEnabled(definition.id, !input.expected)
  expect(manager.enabled(definition.id)).toBe(!input.expected)
  expect(extensionEnabled(definition, readEnableState(database.db.$client))).toBe(!input.expected)
  expect(database.db.select().from(extension).all().filter((row) => row.id !== definition.id)).toEqual(
    before.filter((row) => row.id !== definition.id),
  )
  database.close()
})

test.each([details, context])("$id preserves disabled state from its shipping legacy declaration", (definition) => {
  const database = openDatabase(":memory:")
  const manager = createManager(database.db, () => false, [definition])
  database.db.insert(extension).values({ id: definition.legacy[0], enabled: false }).run()

  expect(manager.enabled(definition.id)).toBe(false)
  expect(extensionEnabled(definition, readEnableState(database.db.$client))).toBe(false)
  database.close()
})

describe("downloadArchive deadline (#1091)", () => {
  test("the overall deadline is a named constant sized for the archive cap", () => {
    expect(EXTENSION_DOWNLOAD_DEADLINE_MS).toBe(300_000)
  })

  test("a response that never arrives settles as a download timeout, not a hang", async () => {
    const stalled = () => new Promise<Response>(() => {})
    const error = await downloadArchive("https://example.test/ext.ocdx", { fetch: stalled, deadlineMs: 25 }).catch(
      (caught) => caught,
    )
    expect(error).toBeInstanceOf(ExtensionError)
    expect(error.code).toBe("download")
    expect(error.message).toContain("timed out after 25 ms")
  })

  test("a body that stalls mid-transfer settles as the same download timeout", async () => {
    const drip = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]))
              // never close: the rest of the body never arrives
            },
          }),
          { headers: { "content-length": "10" } },
        ),
      )
    const error = await downloadArchive("https://example.test/ext.ocdx", { fetch: drip, deadlineMs: 25 }).catch(
      (caught) => caught,
    )
    expect(error).toBeInstanceOf(ExtensionError)
    expect(error.code).toBe("download")
    expect(error.message).toContain("timed out after 25 ms")
  })

  test("a slow-drip body that keeps arriving still settles at the overall deadline", async () => {
    const drip = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 10))
              controller.enqueue(new Uint8Array([1]))
            },
          }),
          { headers: { "content-length": "1000000" } },
        ),
      )
    const started = Date.now()
    const error = await downloadArchive("https://example.test/ext.ocdx", { fetch: drip, deadlineMs: 50 }).catch(
      (caught) => caught,
    )
    expect(error).toBeInstanceOf(ExtensionError)
    expect(error.code).toBe("download")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("the happy path returns the bytes and the declared-length pre-check still fires first", async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const ok = () =>
      Promise.resolve(new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } }))
    await expect(downloadArchive("https://example.test/ext.ocdx", { fetch: ok })).resolves.toEqual(Buffer.from(bytes))

    const tooLarge = () =>
      Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }), {
          headers: { "content-length": String(104_857_601) },
        }),
      )
    const error = await downloadArchive("https://example.test/ext.ocdx", { fetch: tooLarge }).catch((caught) => caught)
    expect(error).toBeInstanceOf(ExtensionError)
    expect(error.code).toBe("tooLarge")
  })
})
