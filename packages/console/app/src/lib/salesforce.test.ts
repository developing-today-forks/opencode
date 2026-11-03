import type { Server } from "bun"
import { afterAll, expect, test } from "bun:test"

const leads: Record<string, unknown>[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, instance) {
    const path = new URL(request.url).pathname
    if (path === "/services/oauth2/token") {
      return Response.json({ access_token: "local-test-token", instance_url: instance.url.origin })
    }
    if (path === "/services/data/v59.0/sobjects/Lead" && request.method === "POST") {
      leads.push(await request.json())
      return Response.json({ id: "local-test-lead", success: true }, { status: 201 })
    }
    return new Response("Not found", { status: 404 })
  },
})

const resources = {
  SST_RESOURCE_SALESFORCE_INSTANCE_URL: server.url.origin,
  SST_RESOURCE_SALESFORCE_CLIENT_ID: "local-test-client",
  SST_RESOURCE_SALESFORCE_CLIENT_SECRET: "local-test-secret",
}
const previous = Object.fromEntries(Object.keys(resources).map((key) => [key, process.env[key]]))
Object.entries(resources).forEach(([key, value]) => {
  process.env[key] = JSON.stringify({ value })
})

afterAll(async () => {
  await server.stop(true)
  await Promise.all(scenarioServers.map((scenario) => scenario.stop(true)))
  Object.entries(previous).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key]
      return
    }
    process.env[key] = value
  })
})

const scenarioServers: Array<ReturnType<typeof Bun.serve>> = []

function startScenarioServer(fetch: (request: Request, server: Server<unknown>) => Response | Promise<Response>) {
  const scenario = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  scenarioServers.push(scenario)
  return scenario
}

/**
 * Run one real createLead() against a scenario fake in a fresh process.
 * SST's Resource snapshots process env process-wide at first access, so
 * per-scenario instance URLs cannot be swapped in-process after the first
 * read; the driver re-imports the real module with its own env preset.
 */
async function runLeadAttempt(origin: string) {
  const child = Bun.spawn([process.execPath, "./salesforce-lead-driver.ts", JSON.stringify(stalledInput)], {
    cwd: import.meta.dir,
    env: { ...process.env, SST_RESOURCE_SALESFORCE_INSTANCE_URL: JSON.stringify({ value: origin }) },
    stdout: "pipe",
    stderr: "pipe",
  })
  const killTimer = setTimeout(() => child.kill(), 25_000)
  try {
    const start = Date.now()
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { output, exitCode, elapsed: Date.now() - start }
  } finally {
    clearTimeout(killTimer)
  }
}

test("a fake entry keeps the visitor message, spend range, and enterprise lead source in their own fields", async () => {
  const { createLead } = await import("./salesforce")
  const accepted = await createLead({
    name: "Fake Console Visitor",
    role: "Engineering lead",
    company: "Example Test Company",
    email: "fake-visitor@example.test",
    inferenceSpend: "$10K–$50K",
    message: "  We need SSO for our developers.\nPlease share the enterprise options.  ",
  })

  expect(accepted).toBe(true)
  expect(leads).toHaveLength(1)
  expect(leads[0]).toEqual({
    LastName: "Fake Console Visitor",
    Company: "Example Test Company",
    Email: "fake-visitor@example.test",
    Phone: null,
    Title: "Engineering lead",
    Description: "  We need SSO for our developers.\nPlease share the enterprise options.  ",
    Current_Monthly_Inference_Spend__c: "$10K–$50K",
    LeadSource: "enterprise website form",
  })
})

test("the local Enterprise request handler applies the updated mapping to a form submission", async () => {
  const { handleEnterpriseRequest } = await import("./enterprise")
  const response = await handleEnterpriseRequest(
    new Request("http://localhost/api/enterprise", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Fake Local Form Visitor",
        role: "Engineering lead",
        company: "Example Test Company",
        email: "fake-local-visitor@example.test",
        inferenceSpend: "50k-100k",
        message: "  How are you bro!\nThis is a local form test.  ",
        alias: "",
      }),
    }),
    {
      salesforceSubmit: async (payload) => {
        const response = await fetch(`${server.url.origin}/services/data/v59.0/sobjects/Lead`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        return response.ok
      },
      notifications: false,
      accountLookup: async () => ({
        id: "user_test",
        email: "fake-local-visitor@example.test",
        name: null,
        createdAt: "2026-10-01T12:00:00.000Z",
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ success: true })
  expect(leads.at(-1)).toMatchObject({
    LastName: "Fake Local Form Visitor",
    Description: "  How are you bro!\nThis is a local form test.  ",
    Current_Monthly_Inference_Spend__c: "$50K–$100K",
    LeadSource: "enterprise website form",
    Has_Console_Account__c: true,
    Console_Account_ID__c: "user_test",
    Console_Signup_Date__c: "2026-10-01T12:00:00.000Z",
  })
})

const stalledInput = {
  name: "Stalled Endpoint Visitor",
  role: "Engineering lead",
  email: "stalled-visitor@example.test",
  message: "Do you offer SSO for our developers?",
}

test(
  "a never-responding token endpoint settles as a failed lead within the request bound",
  async () => {
    const { SALESFORCE_REQUEST_TIMEOUT_MS } = await import("./salesforce")
    const stalled = startScenarioServer(() => new Promise<Response>(() => {}))
    const { output, exitCode, elapsed } = await runLeadAttempt(stalled.url.origin)
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({ accepted: false })
    expect(elapsed).toBeGreaterThanOrEqual(6000)
    expect(elapsed).toBeLessThan(SALESFORCE_REQUEST_TIMEOUT_MS + 10_000)
  },
  30_000,
)

test(
  "a never-responding lead endpoint settles as a failed lead within the request bound",
  async () => {
    const { SALESFORCE_REQUEST_TIMEOUT_MS } = await import("./salesforce")
    const stalledLead = startScenarioServer((request) => {
      if (new URL(request.url).pathname === "/services/oauth2/token") {
        return Response.json({ access_token: "scenario-test-token", instance_url: new URL(request.url).origin })
      }
      return new Promise<Response>(() => {})
    })
    const { output, exitCode, elapsed } = await runLeadAttempt(stalledLead.url.origin)
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({ accepted: false })
    expect(elapsed).toBeGreaterThanOrEqual(6000)
    expect(elapsed).toBeLessThan(SALESFORCE_REQUEST_TIMEOUT_MS + 10_000)
  },
  30_000,
)

test("an over-cap token success body fails the lead instead of buffering unbounded", async () => {
  const { SALESFORCE_MAX_RESPONSE_BYTES } = await import("./salesforce")
  const oversized = startScenarioServer((request) =>
    Response.json({
      access_token: "x".repeat(SALESFORCE_MAX_RESPONSE_BYTES + 1),
      instance_url: new URL(request.url).origin,
    }),
  )
  const { output, exitCode } = await runLeadAttempt(oversized.url.origin)
  expect(exitCode).toBe(0)
  expect(JSON.parse(output)).toEqual({ accepted: false })
})

test("an over-cap token error body still settles as a failed lead", async () => {
  const { SALESFORCE_MAX_RESPONSE_BYTES } = await import("./salesforce")
  const oversizedError = startScenarioServer(
    () => new Response("e".repeat(SALESFORCE_MAX_RESPONSE_BYTES + 1), { status: 500 }),
  )
  const { output, exitCode } = await runLeadAttempt(oversizedError.url.origin)
  expect(exitCode).toBe(0)
  expect(JSON.parse(output)).toEqual({ accepted: false })
})

test("an over-cap streamed lead error body is cancelled instead of buffering unbounded", async () => {
  const streamedError = startScenarioServer((request) => {
    if (new URL(request.url).pathname === "/services/oauth2/token") {
      return Response.json({ access_token: "scenario-test-token", instance_url: new URL(request.url).origin })
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 64; i++) controller.enqueue(new TextEncoder().encode("e".repeat(32768)))
          controller.close()
        },
      }),
      { status: 400, headers: { "Content-Type": "text/plain" } },
    )
  })
  const { output, exitCode } = await runLeadAttempt(streamedError.url.origin)
  expect(exitCode).toBe(0)
  expect(JSON.parse(output)).toEqual({ accepted: false })
})

test("small error bodies and malformed token JSON keep the existing failure returns", async () => {
  const badToken = startScenarioServer(() => Response.json({ error: "invalid_client" }, { status: 401 }))
  const badTokenResult = await runLeadAttempt(badToken.url.origin)
  expect(badTokenResult.exitCode).toBe(0)
  expect(JSON.parse(badTokenResult.output)).toEqual({ accepted: false })
  const malformedToken = startScenarioServer(
    () => new Response("not json {{{", { headers: { "Content-Type": "application/json" } }),
  )
  const malformedResult = await runLeadAttempt(malformedToken.url.origin)
  expect(malformedResult.exitCode).toBe(0)
  expect(JSON.parse(malformedResult.output)).toEqual({ accepted: false })
  const badLead = startScenarioServer((request) => {
    if (new URL(request.url).pathname === "/services/oauth2/token") {
      return Response.json({ access_token: "scenario-test-token", instance_url: new URL(request.url).origin })
    }
    return Response.json({ message: "bad request" }, { status: 400 })
  })
  const badLeadResult = await runLeadAttempt(badLead.url.origin)
  expect(badLeadResult.exitCode).toBe(0)
  expect(JSON.parse(badLeadResult.output)).toEqual({ accepted: false })
})
