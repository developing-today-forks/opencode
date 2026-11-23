import { describe, expect, test } from "bun:test"
import { recoverWindowBootstrap } from "./recovery"

describe("recoverWindowBootstrap", () => {
  test("returns the bootstrap the channel answers with", async () => {
    const bootstrap = { id: "win-1", firstLaunchPending: true, packaged: false }

    await expect(recoverWindowBootstrap(() => Promise.resolve(bootstrap))).resolves.toEqual(bootstrap)
  })

  test("returns undefined when the channel refuses (unknown sender)", async () => {
    await expect(recoverWindowBootstrap(() => Promise.resolve(undefined))).resolves.toBeUndefined()
  })

  test("returns undefined for a malformed answer", async () => {
    await expect(recoverWindowBootstrap(() => Promise.resolve({ id: 42 }))).resolves.toBeUndefined()
    await expect(recoverWindowBootstrap(() => Promise.resolve("win-1"))).resolves.toBeUndefined()
  })

  test("returns undefined when the channel errors, so the preload keeps the minimal bridge", async () => {
    await expect(recoverWindowBootstrap(() => Promise.reject(new Error("no handler")))).resolves.toBeUndefined()
  })
})
