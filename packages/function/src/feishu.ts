import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto"

// Verification for the Feishu (Lark) event webhook in api.ts (#2564).
// The handler previously relayed any POST body to the Discord support
// channel: no verification token, no signature check, and the full
// payload written to the worker log. Feishu carries a verification
// token in every payload (top level, or header.token on v2 events) and,
// once an encrypt key is configured, signs every request with
// x-lark-signature over timestamp + nonce + key + raw body; encrypted
// payloads are AES-256-CBC under sha256(encrypt key). Requests are
// verified before any side effect, and the endpoint fails closed when
// no verification secret is configured at all.

export interface FeishuMessage {
  message_id?: string
  root_id?: string
  parent_id?: string
  chat_id?: string
  content?: string
}

export interface FeishuPayload {
  challenge?: string
  token?: string
  encrypt?: string
  header?: { token?: string; event_type?: string }
  event?: { message?: FeishuMessage }
}

export type FeishuVerification =
  | { ok: true; body: FeishuPayload }
  | { ok: false; status: 400 | 401; error: string }

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  return left.length === right.length && timingSafeEqual(left, right)
}

export function verifyFeishuSignature(input: {
  timestamp?: string
  nonce?: string
  signature?: string
  encryptKey: string
  rawBody: string
}): boolean {
  if (!input.timestamp || !input.nonce || !input.signature) return false
  const expected = createHash("sha256")
    .update(`${input.timestamp}${input.nonce}${input.encryptKey}${input.rawBody}`)
    .digest("hex")
  return safeEqual(expected, input.signature.toLowerCase())
}

export function decryptFeishuPayload(encrypt: string, encryptKey: string): FeishuPayload {
  const key = createHash("sha256").update(encryptKey).digest()
  const data = Buffer.from(encrypt, "base64")
  const decipher = createDecipheriv("aes-256-cbc", key, data.subarray(0, 16))
  const plain = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()])
  return JSON.parse(plain.toString("utf8")) as FeishuPayload
}

export function verifyFeishuRequest(input: {
  rawBody: string
  signature?: string
  timestamp?: string
  nonce?: string
  verificationToken?: string
  encryptKey?: string
}): FeishuVerification {
  const verificationToken = input.verificationToken || undefined
  const encryptKey = input.encryptKey || undefined
  if (!verificationToken && !encryptKey) {
    return { ok: false, status: 401, error: "feishu verification is not configured" }
  }
  // The signature covers the raw body, so it is checked before parsing —
  // and always before decrypting anything.
  if (encryptKey) {
    const valid = verifyFeishuSignature({
      timestamp: input.timestamp,
      nonce: input.nonce,
      signature: input.signature,
      encryptKey,
      rawBody: input.rawBody,
    })
    if (!valid) return { ok: false, status: 401, error: "invalid feishu signature" }
  }
  let body: FeishuPayload
  try {
    body = JSON.parse(input.rawBody) as FeishuPayload
  } catch {
    return { ok: false, status: 400, error: "invalid request body" }
  }
  if (typeof body?.encrypt === "string") {
    if (!encryptKey) return { ok: false, status: 401, error: "encrypted feishu payload without an encrypt key" }
    try {
      body = decryptFeishuPayload(body.encrypt, encryptKey)
    } catch {
      return { ok: false, status: 400, error: "invalid encrypted payload" }
    }
  }
  if (verificationToken) {
    const presented = body?.token ?? body?.header?.token
    if (typeof presented !== "string" || !safeEqual(presented, verificationToken)) {
      return { ok: false, status: 401, error: "invalid feishu verification token" }
    }
  }
  return { ok: true, body }
}

// The relayed text: message content is a JSON string for text messages,
// but Feishu also sends plain strings, and JSON without a text field
// relays raw (the previous behavior). Malformed JSON is a client error
// for the caller to report, not a throw that surfaces as a 500.
export function extractFeishuMessageText(content: unknown): { ok: true; text: string } | { ok: false } {
  if (typeof content !== "string") return { ok: true, text: "" }
  if (!content.trim().startsWith("{")) return { ok: true, text: content }
  try {
    const parsed = JSON.parse(content) as { text?: unknown }
    return { ok: true, text: typeof parsed?.text === "string" ? parsed.text : content }
  } catch {
    return { ok: false }
  }
}
