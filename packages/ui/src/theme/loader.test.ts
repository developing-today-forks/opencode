import { afterEach, describe, expect, test } from "bun:test"
import { loadThemeFromUrl, themeMaxResponseBytes } from "./loader"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(response: () => Response) {
  globalThis.fetch = (async () => response()) as unknown as typeof fetch
}

describe("loadThemeFromUrl response size cap (#1061)", () => {
  test("loads a normal theme JSON body", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ id: "custom" }), {
          headers: { "content-type": "application/json" },
        }),
    )
    const theme = await loadThemeFromUrl("https://example.com/theme.json")
    expect(theme.id).toBe("custom")
  })

  test("rejects a declared oversized body before reading it", async () => {
    let bodyRead = false
    stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("small body"))
            },
            pull(controller) {
              bodyRead = true
              controller.close()
            },
          }),
          { headers: { "content-length": String(themeMaxResponseBytes + 1) } },
        ),
    )
    await expect(loadThemeFromUrl("https://example.com/theme.json")).rejects.toThrow(
      `exceeded ${themeMaxResponseBytes} bytes`,
    )
    expect(bodyRead).toBe(false)
  })

  test("rejects a streamed oversized body in flight", async () => {
    const chunkBytes = themeMaxResponseBytes / 2
    const totalChunks = 8
    let pulled = 0
    stubFetch(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (pulled === totalChunks) return controller.close()
              pulled++
              controller.enqueue(new Uint8Array(chunkBytes))
            },
          }),
        ),
    )
    await expect(loadThemeFromUrl("https://example.com/theme.json")).rejects.toThrow(
      `exceeded ${themeMaxResponseBytes} bytes`,
    )
    expect(pulled).toBeLessThan(totalChunks)
  })
})
