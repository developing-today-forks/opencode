import { describe, expect, test } from "bun:test"
import { changelogMaxResponseBytes, readBoundedChangelogText } from "./changelog"

describe("readBoundedChangelogText response size cap (#1061)", () => {
  test("returns a normal changelog-sized body", async () => {
    const body = JSON.stringify({ releases: [] })
    const text = await readBoundedChangelogText(new Response(body))
    expect(text).toBe(body)
  })

  test("rejects a declared oversized body before reading it", async () => {
    let bodyRead = false

    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("small body"))
        },
        pull(controller) {
          bodyRead = true
          controller.close()
        },
      }),
      { headers: { "content-length": String(changelogMaxResponseBytes + 1) } },
    )

    await expect(readBoundedChangelogText(response)).rejects.toThrow(
      `Changelog response exceeded ${changelogMaxResponseBytes} bytes`,
    )
    expect(bodyRead).toBe(false)
  })

  test("rejects a streamed oversized body in flight", async () => {
    const chunkBytes = changelogMaxResponseBytes / 2
    const totalChunks = 8
    let pulled = 0

    const response = new Response(
      new ReadableStream({
        pull(controller) {
          if (pulled === totalChunks) return controller.close()
          pulled++
          controller.enqueue(new Uint8Array(chunkBytes))
        },
      }),
    )

    await expect(readBoundedChangelogText(response)).rejects.toThrow(
      `Changelog response exceeded ${changelogMaxResponseBytes} bytes`,
    )
    expect(pulled).toBeLessThan(totalChunks)
  })

  test("rejects an oversized body when the response has no readable stream", async () => {
    // "é" is 2 bytes in UTF-8 but 1 UTF-16 code unit, so its length stays under the cap
    // while its byte length exceeds it — this also pins the byte-count (not text.length) check.
    const big = "é".repeat(changelogMaxResponseBytes / 2 + 1)
    const response = Object.assign(new Response(null), { text: async () => big })

    expect(response.body).toBeNull()
    expect(big.length).toBeLessThan(changelogMaxResponseBytes)
    await expect(readBoundedChangelogText(response)).rejects.toThrow(
      `Changelog response exceeded ${changelogMaxResponseBytes} bytes`,
    )
  })
})
