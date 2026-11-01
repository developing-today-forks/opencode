// Bounded Discord relay for the Mattermost -> Discord support bridge in
// api.ts. The relay POST previously carried no deadline, so a stalled
// discord.com pinned the request forever, and its error path buffered the
// whole response body via response.text() just to log it.

export const DISCORD_TIMEOUT_MS = 5_000
// The error log line needs the status and a short excerpt, nothing more.
export const DISCORD_ERROR_BODY_MAX_BYTES = 8192

const DISCORD_API_BASE = "https://discord.com/api/v10"

/**
 * Read a response body as text with a hard byte cap, tied to `signal` so a
 * timeout cancels the read instead of buffering an endless body whole.
 * Returns the excerpt read so far when the cap or an error cuts it short.
 */
export async function readErrorBodyExcerpt(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return ""
  const declared = Number(response.headers.get("content-length"))
  const reader = response.body.getReader()
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined)
  signal.addEventListener("abort", abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size <= DISCORD_ERROR_BODY_MAX_BYTES) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      chunks.push(result.value)
      if (Number.isFinite(declared) && declared > DISCORD_ERROR_BODY_MAX_BYTES) break
    }
  } catch {
    // A timeout or a broken stream still leaves a useful excerpt behind.
  } finally {
    signal.removeEventListener("abort", abort)
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(Math.min(size, DISCORD_ERROR_BODY_MAX_BYTES))
  let offset = 0
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, bytes.byteLength - offset)
    bytes.set(slice, offset)
    offset += slice.byteLength
    if (offset >= bytes.byteLength) break
  }
  return new TextDecoder().decode(bytes)
}

/**
 * POST one message to a Discord channel. Resolves `true` on a 2xx response;
 * on a non-OK response it logs a capped excerpt of the error body and
 * resolves `false`. Rejects when the fetch itself fails (including the
 * DISCORD_TIMEOUT_MS deadline) so the caller can map it to its own error.
 */
export async function postDiscordSupportMessage(input: {
  channelId: string
  token: string
  content: string
  baseUrl?: string
  timeoutMs?: number
}): Promise<boolean> {
  const signal = AbortSignal.timeout(input.timeoutMs ?? DISCORD_TIMEOUT_MS)
  const response = await fetch(`${input.baseUrl ?? DISCORD_API_BASE}/channels/${input.channelId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${input.token}`,
    },
    body: JSON.stringify({ content: input.content }),
    signal,
  })
  if (!response.ok) {
    console.error("Discord bot message failed:", response.status, await readErrorBodyExcerpt(response, signal))
    return false
  }
  return true
}
