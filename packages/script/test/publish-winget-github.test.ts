import { describe, expect, test } from "bun:test"
import { WINGET_GITHUB_RESPONSE_MAX_BYTES, WinGetGitHub } from "../../../script/publish-winget-github"

function stalledBody() {
  return new ReadableStream<Uint8Array>({
    start() {
      // Keep the stream open until production code cancels it on timeout.
    },
  })
}

describe("WinGet GitHub API deadlines (#1332)", () => {
  test("a stalled response body is cancelled at its named deadline", async () => {
    let signal: AbortSignal | undefined
    const github = WinGetGitHub.create("test-token", {
      timeoutMs: 25,
      fetchImpl: async (_input, init) => {
        signal = init?.signal
        return new Response(stalledBody())
      },
    })
    const route = "/repos/microsoft/winget-pkgs/git/ref/heads/master"
    const response = await github.request(route)
    await expect(github.json(response)).rejects.toThrow(`WinGet GitHub GET ${route} timed out after 25ms`)
    expect(signal?.aborted).toBe(true)
  })

  test("answered responses still parse after a 422 ref response can trigger the existing retry", async () => {
    const github = WinGetGitHub.create("test-token", {
      fetchImpl: async (_input, init) =>
        init?.method === "PATCH"
          ? new Response(JSON.stringify({ ref: "refs/heads/Anomaly.OpenCode-2.0.31" }))
          : new Response(null, { status: 422 }),
    })
    const route = "/repos/fork/winget-pkgs/git/refs"
    const created = await github.request(route, { method: "POST" })
    expect(created.status).toBe(422)
    const updated = await github.request(`${route}/heads/Anomaly.OpenCode-2.0.31`, { method: "PATCH" })
    await expect(github.json(updated)).resolves.toEqual({ ref: "refs/heads/Anomaly.OpenCode-2.0.31" })
  })
})

describe("WinGet GitHub API response byte cap (#1336)", () => {
  test("a streamed body over the cap rejects naming the operation and the cap", async () => {
    const github = WinGetGitHub.create("test-token", {
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(WINGET_GITHUB_RESPONSE_MAX_BYTES + 1))
              controller.close()
            },
          }),
        ),
    })
    const route = "/repos/microsoft/winget-pkgs/pulls"
    const response = await github.request(route)
    await expect(github.json(response)).rejects.toThrow(
      `WinGet GitHub GET ${route} response exceeded ${WINGET_GITHUB_RESPONSE_MAX_BYTES} bytes`,
    )
  })

  test("a declared content-length over the cap fails fast", async () => {
    const github = WinGetGitHub.create("test-token", {
      fetchImpl: async () =>
        new Response("{}", {
          headers: { "content-length": String(WINGET_GITHUB_RESPONSE_MAX_BYTES + 1) },
        }),
    })
    const route = "/repos/microsoft/winget-pkgs/pulls"
    const response = await github.request(route)
    await expect(github.json(response)).rejects.toThrow(
      `WinGet GitHub GET ${route} response exceeded ${WINGET_GITHUB_RESPONSE_MAX_BYTES} bytes`,
    )
  })

  test("a non-OK error embeds only a bounded excerpt of the body", async () => {
    const github = WinGetGitHub.create("test-token", {
      fetchImpl: async () => new Response("x".repeat(5000), { status: 500 }),
    })
    const route = "/repos/microsoft/winget-pkgs/pulls"
    const response = await github.request(route)
    const error = await github.json(response).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message.length).toBeLessThan(2000)
    expect((error as Error).message).toContain("returned 500:")
  })
})
