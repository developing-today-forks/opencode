import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { extractFeishuMessageText, verifyFeishuRequest } from "../src/feishu"

const TOKEN = "verification-token-1"
const KEY = "encrypt-key-1"

const sign = (rawBody: string, key = KEY, timestamp = "1700000000", nonce = "nonce-1") => ({
  timestamp,
  nonce,
  signature: createHash("sha256").update(`${timestamp}${nonce}${key}${rawBody}`).digest("hex"),
})

const encrypt = (payload: unknown, key = KEY) => {
  const iv = randomBytes(16)
  const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(key).digest(), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()])
  return Buffer.concat([iv, data]).toString("base64")
}

describe("verifyFeishuRequest", () => {
  test("fails closed when no verification secret is configured", () => {
    const result = verifyFeishuRequest({ rawBody: JSON.stringify({ token: TOKEN, challenge: "c" }) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  test("accepts a challenge carrying the verification token", () => {
    const result = verifyFeishuRequest({
      rawBody: JSON.stringify({ token: TOKEN, challenge: "abc" }),
      verificationToken: TOKEN,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.body.challenge).toBe("abc")
  })

  test("rejects a wrong or missing token with 401", () => {
    const wrong = verifyFeishuRequest({
      rawBody: JSON.stringify({ token: "nope", event: { message: { content: "hi" } } }),
      verificationToken: TOKEN,
    })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.status).toBe(401)
    const missing = verifyFeishuRequest({
      rawBody: JSON.stringify({ event: { message: { content: "hi" } } }),
      verificationToken: TOKEN,
    })
    expect(missing.ok).toBe(false)
  })

  test("accepts the v2 header token", () => {
    const result = verifyFeishuRequest({
      rawBody: JSON.stringify({ header: { token: TOKEN, event_type: "im.message.receive_v1" }, event: {} }),
      verificationToken: TOKEN,
    })
    expect(result.ok).toBe(true)
  })

  test("rejects malformed JSON with 400, not a throw", () => {
    const result = verifyFeishuRequest({ rawBody: "{not json", verificationToken: TOKEN })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  test("verifies the signature when an encrypt key is configured", () => {
    const rawBody = JSON.stringify({ event: { message: { content: "hi" } } })
    const good = verifyFeishuRequest({ rawBody, ...sign(rawBody), encryptKey: KEY })
    expect(good.ok).toBe(true)
    const tampered = verifyFeishuRequest({ rawBody: `${rawBody} `, ...sign(rawBody), encryptKey: KEY })
    expect(tampered.ok).toBe(false)
    if (!tampered.ok) expect(tampered.status).toBe(401)
    const unsigned = verifyFeishuRequest({ rawBody, encryptKey: KEY })
    expect(unsigned.ok).toBe(false)
  })

  test("decrypts an encrypted payload after verifying its signature", () => {
    const rawBody = JSON.stringify({
      encrypt: encrypt({ token: TOKEN, event: { message: { message_id: "m1", content: "{\"text\":\"hello\"}" } } }),
    })
    const result = verifyFeishuRequest({ rawBody, ...sign(rawBody), verificationToken: TOKEN, encryptKey: KEY })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.body.event?.message?.message_id).toBe("m1")
    const badSignature = verifyFeishuRequest({
      rawBody,
      ...sign(rawBody, "the-wrong-key"),
      verificationToken: TOKEN,
      encryptKey: KEY,
    })
    expect(badSignature.ok).toBe(false)
  })

  test("rejects an encrypted payload when no encrypt key is configured", () => {
    const result = verifyFeishuRequest({
      rawBody: JSON.stringify({ encrypt: encrypt({ token: TOKEN }) }),
      verificationToken: TOKEN,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })
})

describe("extractFeishuMessageText", () => {
  test("reads text out of JSON content", () => {
    expect(extractFeishuMessageText("{\"text\":\"hello support\"}")).toEqual({ ok: true, text: "hello support" })
  })

  test("passes plain content through", () => {
    expect(extractFeishuMessageText("plain message")).toEqual({ ok: true, text: "plain message" })
  })

  test("falls back to the raw content when the JSON has no text field", () => {
    expect(extractFeishuMessageText("{\"other\":1}")).toEqual({ ok: true, text: "{\"other\":1}" })
  })

  test("rejects malformed JSON content instead of throwing", () => {
    expect(extractFeishuMessageText("{not json")).toEqual({ ok: false })
  })

  test("treats missing content as empty", () => {
    expect(extractFeishuMessageText(undefined)).toEqual({ ok: true, text: "" })
  })
})
