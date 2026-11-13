import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import path from "node:path"

type Artifact = {
  channel: string
  name: string
  distribution: string
  version: string
  metadata: Record<string, unknown>
}

const REQUEST_TIMEOUTS = {
  oidcToken: 10_000,
  publish: 30_000,
  cloudflareTokenVerify: 10_000,
}

/**
 * Hard cap on update-artifact response bodies. All three responses read
 * through readResponseBody are small, schema-known JSON (OIDC token,
 * publish error text, Cloudflare verify), so 1 MiB leaves generous
 * headroom while bounding memory. The request deadlines bound duration,
 * not bytes, so the body is read through the capped reader below
 * (#1333, in the style of #1250's CHANGELOG_MAX_BYTES).
 */
export const UPDATE_ARTIFACT_RESPONSE_MAX_BYTES = 1024 * 1024

type RequestTimeouts = {
  oidcToken: number
  publish: number
  cloudflareTokenVerify: number
}

type Options = {
  fetchImpl?: typeof fetch
  timeouts?: Partial<RequestTimeouts>
}

export namespace UpdateArtifact {
  /** Publishes an artifact using deadline-bound OIDC and update service requests. */
  export async function publish(artifact: Artifact, options: Options = {}) {
    if (process.env.GITHUB_ACTIONS !== "true") {
      console.log("skipped update artifact publication outside GitHub Actions")
      return
    }
    const requestURL = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    if (!requestURL || !requestToken) throw new Error("GitHub Actions OIDC is unavailable")

    const url = new URL(requestURL)
    url.searchParams.set("audience", "https://update.opencode.ai")
    const fetchImpl = options.fetchImpl ?? fetch
    const timeouts = { ...REQUEST_TIMEOUTS, ...options.timeouts }
    const token: unknown = await withDeadline("GitHub OIDC token request", timeouts.oidcToken, async (signal) => {
      const tokenResponse = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${requestToken}` },
        signal,
      })
      if (!tokenResponse.ok) throw new Error(`Failed to request GitHub OIDC token: ${tokenResponse.status}`)
      return readResponseJson(tokenResponse, signal, "GitHub OIDC token request")
    })
    if (!isRecord(token) || typeof token.value !== "string")
      throw new Error("GitHub OIDC response did not include a token")

    for (const attempt of [0, 1, 2]) {
      const outcome = await withDeadline("Update artifact publish request", timeouts.publish, async (signal) => {
        const response = await fetchImpl("https://opencode.ai/update/api/publish", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.value}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(artifact),
          signal,
        })
        if (response.ok) return { retry: false }
        // D1 can commit the upsert and still time out. Replaying the same artifact is safe.
        if (response.status >= 500 && attempt < 2) {
          await readResponseBody(response, signal, "Update artifact publish request")
          return { retry: true, status: response.status }
        }
        throw new Error(`Failed to publish update artifact: ${response.status} ${await readResponseText(response, signal, "Update artifact publish request")}`)
      })
      if (!outcome.retry) return
      console.warn(`Update artifact publication returned ${outcome.status}; retrying`)
      await Bun.sleep((attempt + 1) * 1_000)
    }
  }

  /** Uploads release files to R2 after verifying the Cloudflare token. */
  export async function upload(input: { version: string; files: string[]; dryRun?: boolean }, options: Options = {}) {
    const r2Credentials = input.dryRun ? undefined : await credentials(options)
    const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3")
    const client = r2Credentials ? new S3Client(r2Credentials) : undefined
    const prefix = `bin/${input.version}/`
    const base = `https://opencode.ai/files/bin/${encodeURIComponent(input.version)}/`
    try {
      return Object.fromEntries(
        await Promise.all(
          input.files.map(async (filepath) => {
            const file = Bun.file(filepath)
            const name = path.basename(filepath)
            if (!file.size) throw new Error(`Empty release file: ${filepath}`)
            const hash = createHash("sha256")
            for await (const chunk of file.stream()) hash.update(chunk)
            const metadata = { url: `${base}${encodeURIComponent(name)}`, sha256: hash.digest("hex"), size: file.size }
            console.log(`${input.dryRun ? "dry-run upload" : "upload"}: ${prefix}${name}`)
            if (client) {
              await client.send(
                new PutObjectCommand({
                  Bucket: "opencode-production-files",
                  Key: `${prefix}${name}`,
                  Body: createReadStream(filepath),
                  ContentLength: file.size,
                  ContentType: name.endsWith(".tar.gz") ? "application/gzip" : file.type || "application/octet-stream",
                  ContentDisposition: `attachment; filename="${name}"`,
                  CacheControl: "public, max-age=31536000, immutable",
                }),
              )
            }
            return [name, metadata] as const
          }),
        ),
      )
    } finally {
      client?.destroy()
    }
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

/** Verifies the Cloudflare token and derives the R2 client credentials. */
async function credentials(options: Options) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required")
  const fetchImpl = options.fetchImpl ?? fetch
  const timeouts = { ...REQUEST_TIMEOUTS, ...options.timeouts }
  // R2 uses the token ID as its access key and SHA-256(token) as its secret.
  for (const scope of [`accounts/${account}`, "user"]) {
    const data: unknown = await withDeadline("Cloudflare token verification", timeouts.cloudflareTokenVerify, async (signal) => {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/${scope}/tokens/verify`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      })
      if (!response.ok) return undefined
      return readResponseJson(response, signal, "Cloudflare token verification")
    })
    if (data === undefined) continue
    if (!isRecord(data) || data.success !== true || !isRecord(data.result) || typeof data.result.id !== "string")
      continue
    return {
      region: "auto",
      endpoint: `https://${account}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: data.result.id,
        secretAccessKey: createHash("sha256").update(token).digest("hex"),
      },
    }
  }
  throw new Error("Cloudflare token verification failed")
}

/** Runs a request and its body reads under one named timeout. */
async function withDeadline<T>(operation: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>) {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const result = await run(signal)
    signal.throwIfAborted()
    return result
  } catch (error) {
    if (signal.aborted) throw new Error(`${operation} timed out after ${timeoutMs}ms`, { cause: error })
    throw error
  }
}

async function readResponseJson(response: Response, signal: AbortSignal, operation: string): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readResponseBody(response, signal, operation)))
}

async function readResponseText(response: Response, signal: AbortSignal, operation: string): Promise<string> {
  return new TextDecoder().decode(await readResponseBody(response, signal, operation))
}

/** Reads a response body until it completes, its request deadline aborts, or it exceeds the byte cap. */
async function readResponseBody(response: Response, signal: AbortSignal, operation: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > UPDATE_ARTIFACT_RESPONSE_MAX_BYTES) {
    await response.body.cancel().catch(() => undefined)
    throw new Error(`${operation} response exceeded ${UPDATE_ARTIFACT_RESPONSE_MAX_BYTES} bytes`)
  }
  const reader = response.body.getReader()
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined)
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > UPDATE_ARTIFACT_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${operation} response exceeded ${UPDATE_ARTIFACT_RESPONSE_MAX_BYTES} bytes`)
      }
      chunks.push(result.value)
    }
    // Cancelling a stalled stream may settle its pending read as done; the
    // signal still owns the body read and must reject before partial data is used.
    signal.throwIfAborted()
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } finally {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}
