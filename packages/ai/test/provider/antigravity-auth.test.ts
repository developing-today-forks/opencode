import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { refresh, TOKEN_REFRESH_MAX_RESPONSE_BYTES } from "../../src/providers/antigravity-auth.js"

const originalFetch = globalThis.fetch
const originalAgyBin = process.env.AGY_BIN

// refresh() extracts the OAuth client secret from the agy binary; point it
// at a fixture binary carrying an embedded GOCSPX blob + UA string.
const fixtureDir = mkdtempSync(join(tmpdir(), "antigravity-auth-test-"))
const fixtureBin = join(fixtureDir, "agy")
writeFileSync(
  fixtureBin,
  `fixture GOCSPX-${"a".repeat(40)} antigravity/cli/1.4.11 (aidev_client; os_type=linux; arch=amd64; cl=1010154931; auth_method=consumer)`,
)
chmodSync(fixtureBin, 0o755)
process.env.AGY_BIN = fixtureBin

afterEach(() => {
  globalThis.fetch = originalFetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  if (originalAgyBin === undefined) delete process.env.AGY_BIN
  else process.env.AGY_BIN = originalAgyBin
})

describe("Antigravity token refresh bounding (#1469)", () => {
  test("refresh succeeds against a stubbed token endpoint and sends a deadline signal", async () => {
    let seenSignal: AbortSignal | null | undefined
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenSignal = init?.signal
      return Response.json({ access_token: "fresh-token", expires_in: 3600 })
    }) as typeof fetch
    const token = await refresh("refresh-fixture")
    expect(token.accessToken).toBe("fresh-token")
    expect(token.expiryMs).toBeGreaterThan(Date.now())
    expect(seenSignal).toBeInstanceOf(AbortSignal)
    expect(seenSignal?.aborted).toBe(false)
  })

  test("refresh rejects a token response body over the cap", async () => {
    globalThis.fetch = (async () =>
      new Response("x".repeat(TOKEN_REFRESH_MAX_RESPONSE_BYTES + 1024), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch
    await expect(refresh("refresh-fixture")).rejects.toThrow("exceeded")
  })

  test("refresh rejects when the token endpoint stalls past its deadline", async () => {
    globalThis.fetch = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })) as typeof fetch
    await expect(refresh("refresh-fixture", 50)).rejects.toThrow()
  })
})
