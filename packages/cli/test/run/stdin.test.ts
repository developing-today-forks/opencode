import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { readPipedStdin } from "../../src/util/io"

const fakeStdin = () => new PassThrough() as unknown as NodeJS.ReadStream

describe("readPipedStdin (code#1359)", () => {
  test("an open, never-written pipe is treated as no piped input instead of hanging", async () => {
    const stream = fakeStdin()
    const started = Date.now()
    const result = await readPipedStdin(undefined, stream, 50)
    expect(result).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("a pipe that writes and closes is read to EOF", async () => {
    const stream = fakeStdin()
    const reading = readPipedStdin(undefined, stream, 50)
    stream.write("hello ")
    setTimeout(() => {
      stream.write("world")
      stream.end()
    }, 75)
    expect(await reading).toBe("hello world")
  })

  test("a delayed first byte is preserved when the grace is unbounded (stdin is the only prompt source)", async () => {
    const stream = fakeStdin()
    const reading = readPipedStdin(undefined, stream, Number.POSITIVE_INFINITY)
    setTimeout(() => {
      stream.write("delayed prompt")
      stream.end()
    }, 75)
    expect(await reading).toBe("delayed prompt")
  })

  test("a pipe already at EOF resolves with its content, not the grace path", async () => {
    const stream = fakeStdin()
    const reading = readPipedStdin(undefined, stream, 5_000)
    stream.end("piped prompt")
    expect(await reading).toBe("piped prompt")
  })

  test("an empty pipe at EOF resolves empty (the /dev/null shape)", async () => {
    const stream = fakeStdin()
    const reading = readPipedStdin(undefined, stream, 5_000)
    stream.end()
    expect(await reading).toBe("")
  })
})
