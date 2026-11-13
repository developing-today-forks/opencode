import { Resource } from "@opencode/console-resource"
import { z } from "zod"

export const consoleAccountSchema = z.object({
  id: z.string().min(1).max(255),
  email: z.email(),
  name: z.string().nullable(),
  createdAt: z.iso.datetime(),
})
export type ConsoleAccount = z.infer<typeof consoleAccountSchema>

/**
 * Hard cap on the CRM lookup response body. A valid payload is under
 * 1 KiB by construction (the schema above caps `id` at 255 chars, plus
 * an email, a nullable name, and a datetime inside the `{account}`
 * wrapper); the 3s fetch timeout bounds duration, not bytes, so the
 * body is read through the capped reader below (#1158).
 */
export const CONSOLE_ACCOUNT_LOOKUP_MAX_BYTES = 64 * 1024

/** Read a lookup response body with a hard size cap; an over-cap read cancels the body and throws. */
async function readCappedLookupJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > CONSOLE_ACCOUNT_LOOKUP_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Console account lookup response too large (${declared} bytes)`)
  }
  if (!response.body) throw new Error("Console account lookup response had no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > CONSOLE_ACCOUNT_LOOKUP_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`Console account lookup response exceeded ${CONSOLE_ACCOUNT_LOOKUP_MAX_BYTES} bytes`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

export async function lookupConsoleAccount(email: string): Promise<ConsoleAccount | null> {
  const response = await fetch(`${Resource.CONSOLE_CRM_LOOKUP_URL.value}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Resource.CONSOLE_CRM_TOKEN.value}` },
    body: JSON.stringify({ email }),
    signal: AbortSignal.timeout(3000),
  })
  if (!response.ok) throw new Error(`Console account lookup failed (${response.status})`)
  const result = z.object({ account: consoleAccountSchema.nullable() }).parse(await readCappedLookupJson(response))
  return result.account
}

export function consoleAccountFields(account: ConsoleAccount | null) {
  if (!account) return { Has_Console_Account__c: false }
  return {
    Has_Console_Account__c: true,
    Console_Account_ID__c: account.id,
    Console_Signup_Date__c: account.createdAt,
  }
}
