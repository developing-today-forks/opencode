import { describe, expect, test } from "bun:test"
import { WinGetGitHub } from "../../../script/publish-winget-github"

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
