import { afterAll, expect, mock, test } from "bun:test"

// The Resource module is an SST link snapshot whose contents are frozen process-wide
// on first access, so env-based fixtures depend on which test file runs first. Mock
// the module instead: these tests only need the handful of values below.
mock.module("@opencode/console-resource", () => {
  const fixtures: Record<string, unknown> = {
    AWS_SES_ACCESS_KEY_ID: { value: "local-test-access-key" },
    AWS_SES_SECRET_ACCESS_KEY: { value: "local-test-secret-key" },
    ENTERPRISE_SALES_INBOX_EMAIL: { value: "sales@example.test" },
    EMAILOCTOPUS_API_KEY: { value: "local-test-octopus-key" },
  }
  // mock.module is process-wide in Bun and restoring fetch in afterAll does not
  // undo it: if this file runs before salesforce.test.ts in the same process,
  // that suite would otherwise see a Resource with no Salesforce entries and
  // throw before reaching its local server. Fall back to the SST env snapshot
  // (SST_RESOURCE_<name>, parsed at access time, like the real module) for any
  // property this file does not fixture, so other suites keep working.
  const Resource = new Proxy(fixtures, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target]
      const raw = process.env[`SST_RESOURCE_${String(prop)}`]
      if (!raw) return undefined
      try {
        return JSON.parse(raw)
      } catch {
        return undefined
      }
    },
  })
  return { Resource, waitUntil: (promise: Promise<unknown>) => promise }
})

const originalFetch = globalThis.fetch
const seen: { url: string; method: string; body: string; signal: AbortSignal | null }[] = []
let sesBehavior: "ok" | "stall" | "error" = "ok"

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(input, init)
  const url = request.url
  if (url.includes("email.us-east-1.amazonaws.com")) {
    seen.push({
      url,
      method: request.method,
      body: await request.clone().text(),
      signal: request.signal,
    })
    if (sesBehavior === "error") return new Response("SES unavailable", { status: 500, statusText: "Internal Server Error" })
    if (sesBehavior === "stall") {
      // A stalled SES endpoint: never responds; only the caller's abort ends the call,
      // exactly like a real fetch against an unresponsive host.
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
      })
    }
    return new Response("{}", { status: 200 })
  }
  if (url.includes("api.emailoctopus.com")) return Response.json({ status: "SUBSCRIBED" }, { status: 201 })
  return originalFetch(input, init)
}) as typeof fetch

afterAll(() => {
  globalThis.fetch = originalFetch
})

test("sendEmail posts the usual SES shape and carries the named timeout signal", async () => {
  sesBehavior = "ok"
  const { sendEmail, SEND_EMAIL_TIMEOUT_MS } = await import("./aws")
  expect(SEND_EMAIL_TIMEOUT_MS).toBe(5_000)
  await sendEmail({ to: "buyer@example.test", subject: "Hello", body: "Body text", replyTo: "buyer@example.test" })
  expect(seen).toHaveLength(1)
  const call = seen[0]!
  expect(call.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails")
  expect(call.method).toBe("POST")
  const payload = JSON.parse(call.body) as {
    FromEmailAddress: string
    Destination: { ToAddresses: string[] }
    ReplyToAddresses?: string[]
    Content: { Simple: { Subject: { Data: string } } }
  }
  expect(payload.FromEmailAddress).toContain("contact@anoma.ly")
  expect(payload.Destination.ToAddresses).toEqual(["buyer@example.test"])
  expect(payload.ReplyToAddresses).toEqual(["buyer@example.test"])
  expect(payload.Content.Simple.Subject.Data).toBe("Hello")
  expect(call.signal).toBeInstanceOf(AbortSignal)
  expect(call.signal!.aborted).toBe(false)
})

test(
  "a stalled SES endpoint rejects within the timeout bound instead of hanging",
  async () => {
    sesBehavior = "stall"
    seen.length = 0
    const { sendEmail, SEND_EMAIL_TIMEOUT_MS } = await import("./aws")
    const started = Date.now()
    await expect(
      sendEmail({ to: "buyer@example.test", subject: "Hello", body: "Body text" }),
    ).rejects.toThrow()
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(SEND_EMAIL_TIMEOUT_MS - 250)
    expect(elapsed).toBeLessThan(SEND_EMAIL_TIMEOUT_MS + 4_000)
  },
  15_000,
)

test("a 5xx SES response is not retried past the bound", async () => {
  sesBehavior = "error"
  seen.length = 0
  const { sendEmail, SEND_EMAIL_TIMEOUT_MS } = await import("./aws")
  const started = Date.now()
  await expect(sendEmail({ to: "buyer@example.test", subject: "Hello", body: "Body text" })).rejects.toThrow(
    "Failed to send email",
  )
  const elapsed = Date.now() - started
  // retries: 0 on the AwsClient — exactly one attempt, no backoff wait.
  expect(seen).toHaveLength(1)
  expect(elapsed).toBeLessThan(SEND_EMAIL_TIMEOUT_MS)
})

test(
  "the enterprise flow degrades to mail=false on a stalled SES endpoint instead of hanging",
  async () => {
    sesBehavior = "stall"
    seen.length = 0
    const { handleEnterpriseRequest } = await import("./enterprise")
    const { SEND_EMAIL_TIMEOUT_MS } = await import("./aws")
    const started = Date.now()
    const response = await handleEnterpriseRequest(
      new Request("https://console.example.test/enterprise", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Fake Console Visitor",
          role: "Engineering lead",
          company: "Example Test Company",
          email: "fake-visitor@example.test",
          message: "We need SSO for our developers.",
        }),
      }),
      {
        salesforceSubmit: async () => true,
        accountLookup: async () => null,
      },
    )
    const elapsed = Date.now() - started
    // The lead succeeded, so the request succeeds even though the mail leg timed out;
    // before the bound it never resolved at all.
    expect(response.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.signal!.aborted).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(SEND_EMAIL_TIMEOUT_MS - 250)
    expect(elapsed).toBeLessThan(10_000)
  },
  15_000,
)
