import { describe, expect, test } from "bun:test"
import { UPDATE_ARTIFACT_RESPONSE_MAX_BYTES, UpdateArtifact } from "../../../script/update-artifact"

const artifact = {
  channel: "latest",
  name: "opencode",
  distribution: "npm",
  version: "1.0.0",
  metadata: {},
}

const timeouts = {
  oidcToken: 25,
  publish: 25,
  cloudflareTokenVerify: 25,
}

function stalledBody() {
  return new ReadableStream<Uint8Array>({
    start() {
      // Keep the stream open until production code cancels it on timeout.
    },
  })
}

/** Applies environment values for a test and restores the previous values afterward. */
async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("UpdateArtifact request deadlines (#1329)", () => {
  test("a stalled OIDC body is cancelled at its deadline", async () => {
    await withEnv(
      {
        GITHUB_ACTIONS: "true",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-token",
      },
      async () => {
        let signal: AbortSignal | null | undefined
        const fetchImpl: typeof fetch = async (_input, init) => {
          signal = init?.signal
          return new Response(stalledBody())
        }
        await expect(UpdateArtifact.publish(artifact, { fetchImpl, timeouts })).rejects.toThrow(
          "GitHub OIDC token request timed out",
        )
        expect(signal?.aborted).toBe(true)
      },
    )
  })

  test("a stalled publish error body is cancelled at its deadline", async () => {
    await withEnv(
      {
        GITHUB_ACTIONS: "true",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-token",
      },
      async () => {
        let calls = 0
        let signal: AbortSignal | null | undefined
        const fetchImpl: typeof fetch = async (_input, init) => {
          calls += 1
          if (calls === 1) return new Response(JSON.stringify({ value: "test-token" }))
          signal = init?.signal
          return new Response(stalledBody(), { status: 400 })
        }
        await expect(UpdateArtifact.publish(artifact, { fetchImpl, timeouts })).rejects.toThrow(
          "Update artifact publish request timed out",
        )
        expect(calls).toBe(2)
        expect(signal?.aborted).toBe(true)
      },
    )
  })

  test("a stalled Cloudflare verify body is cancelled at its deadline", async () => {
    await withEnv(
      {
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "test-token",
      },
      async () => {
        let signal: AbortSignal | null | undefined
        const fetchImpl: typeof fetch = async (_input, init) => {
          signal = init?.signal
          return new Response(stalledBody())
        }
        await expect(UpdateArtifact.upload({ version: "1.0.0", files: [] }, { fetchImpl, timeouts })).rejects.toThrow(
          "Cloudflare token verification timed out",
        )
        expect(signal?.aborted).toBe(true)
      },
    )
  })

  test("an answered publish 5xx still retries", async () => {
    await withEnv(
      {
        GITHUB_ACTIONS: "true",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-token",
      },
      async () => {
        let publishes = 0
        const fetchImpl: typeof fetch = async (input) => {
          if (String(input).startsWith("https://actions.example/token"))
            return new Response(JSON.stringify({ value: "test-token" }))
          publishes += 1
          if (publishes === 1) return new Response("retry", { status: 503 })
          return new Response(null, { status: 204 })
        }
        await UpdateArtifact.publish(artifact, { fetchImpl, timeouts })
        expect(publishes).toBe(2)
      },
    )
  })

  test("an over-cap OIDC body is cancelled and rejected naming the operation and cap", async () => {
    await withEnv(
      {
        GITHUB_ACTIONS: "true",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-token",
      },
      async () => {
        const fetchImpl: typeof fetch = async () => {
          return new Response("x".repeat(UPDATE_ARTIFACT_RESPONSE_MAX_BYTES + 1))
        }
        await expect(UpdateArtifact.publish(artifact, { fetchImpl, timeouts })).rejects.toThrow(
          `GitHub OIDC token request response exceeded ${UPDATE_ARTIFACT_RESPONSE_MAX_BYTES} bytes`,
        )
      },
    )
  })

  test("an over-cap body streamed in chunks without a content-length is rejected", async () => {
    await withEnv(
      {
        GITHUB_ACTIONS: "true",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-token",
      },
      async () => {
        const chunk = new Uint8Array(64 * 1024).fill(120)
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < UPDATE_ARTIFACT_RESPONSE_MAX_BYTES / chunk.byteLength + 1; i++) {
              controller.enqueue(chunk)
            }
            controller.close()
          },
        })
        const fetchImpl: typeof fetch = async () => new Response(body)
        await expect(UpdateArtifact.publish(artifact, { fetchImpl, timeouts })).rejects.toThrow(
          `GitHub OIDC token request response exceeded ${UPDATE_ARTIFACT_RESPONSE_MAX_BYTES} bytes`,
        )
      },
    )
  })

  test("the response byte cap is 1 MiB", () => {
    expect(UPDATE_ARTIFACT_RESPONSE_MAX_BYTES).toBe(1024 * 1024)
  })

  test("the publish dry-run path does not make a request", async () => {
    await withEnv({ GITHUB_ACTIONS: undefined }, async () => {
      const fetchImpl: typeof fetch = async () => {
        throw new Error("unexpected request")
      }
      await expect(UpdateArtifact.publish(artifact, { fetchImpl, timeouts })).resolves.toBeUndefined()
    })
  })
})
