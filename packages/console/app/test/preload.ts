import { mock } from "bun:test"

// One shared @opencode/console-resource fixture for the whole console-app
// suite (#1522). Six test files used to register their own partial
// mock.module for this specifier; Bun module mocks are process-wide, so
// whichever partial mock landed first froze the module shape for every
// other suite — suites lost keys their mock did not carry, and
// stats-proxy lost the waitUntil export entirely when a mock without one
// won. Register exactly one complete fixture here instead (bunfig.toml
// [test] preload), and let per-file setup stay local to each suite.
//
// Resolution mirrors the real module first: a key with an
// SST_RESOURCE_<name> env value resolves from the env, parsed at access
// time — the pattern salesforce/emailoctopus/enterprise suites rely on
// (they set those vars at load and salesforce restores them after). The
// fixture map supplies the values env cannot provide, as the union of
// every Resource.* key any suite fixtures. Anything else is undefined,
// like an unlinked resource.

// The INFERENCE service binding is stubbed per test by
// inference-proxy.test.ts, which cannot close over this module: its
// Resource.INFERENCE.fetch delegates to this holder, and that suite
// bridges its per-test implementation into it.
export const inferenceStub: {
  impl: (request: Request, init?: RequestInit) => Promise<Response>
} = {
  impl: async () => new Response(null, { status: 200 }),
}

const fixtures: Record<string, unknown> = {
  App: { stage: "dev" },
  AWS_SES_ACCESS_KEY_ID: { value: "local-test-access-key" },
  AWS_SES_SECRET_ACCESS_KEY: { value: "local-test-secret-key" },
  CONSOLE_CRM_LOOKUP_URL: { value: "https://crm.example.test/lookup" },
  CONSOLE_CRM_TOKEN: { value: "local-test-token" },
  ConsoleMigration: { inferenceUrl: "https://inference.example.test" },
  DISCORD_INCIDENT_WEBHOOK_URL: { value: "https://discord.example.test/api/webhooks/1/token" },
  EMAILOCTOPUS_API_KEY: { value: "local-test-moctopus-key" },
  ENTERPRISE_SALES_INBOX_EMAIL: { value: "sales@example.test" },
  HoneycombWebhookSecret: { value: "test-secret" },
  INFERENCE: {
    fetch: (request: Request, init?: RequestInit) => inferenceStub.impl(request, init),
  },
}

const Resource = new Proxy(fixtures, {
  get(target, prop: string) {
    const raw = process.env[`SST_RESOURCE_${String(prop)}`]
    if (raw) {
      try {
        return JSON.parse(raw)
      } catch {
        // Not a JSON snapshot value; fall through to the fixture map.
      }
    }
    if (prop in target) return target[prop as keyof typeof target]
    return undefined
  },
})

mock.module("@opencode/console-resource", () => ({
  Resource,
  waitUntil: (promise: Promise<unknown>) => promise,
}))
