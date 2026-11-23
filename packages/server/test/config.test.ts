import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Config } from "@opencode/schema/config"
import { Effect, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"
import { AbsolutePath } from "@opencode/schema/schema"

it.live("returns ordered config entries for the requested directory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-endpoint-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    const config = path.join(project, "opencode.json")
    yield* Effect.promise(() =>
      Promise.all([fs.mkdir(global, { recursive: true }), fs.mkdir(project, { recursive: true })]),
    )
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        JSON.stringify({
          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status", effect: "allow" },
          ],
          mcp: { servers: { docs: { type: "remote", url: "https://example.com/mcp" } } },
        }),
      ),
    )
    const server = yield* startServer(global)
    const url = new URL("/api/config", server.base)
    url.searchParams.set("location[directory]", project)
    const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    const body: unknown = yield* Effect.promise(() => response.json())
    const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(body)

    expect(response.status).toBe(200)
    expect(Array.isArray(entries)).toBe(true)
    const document = entries.find(
      (entry): entry is Config.Document => entry.type === "document" && entry.path === config,
    )
    expect(document?.info.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
    expect(document?.path).toBe(AbsolutePath.make(config))
    if (!Array.isArray(body)) throw new Error("Expected a config entry array")
    const raw = body.find((entry) => isRecord(entry) && entry["type"] === "document" && entry["path"] === config)
    if (!isRecord(raw) || !isRecord(raw["info"])) throw new Error("Expected a config document")
    expect(raw["info"]).not.toHaveProperty("default_agent")
    expect(raw["info"]).not.toHaveProperty("model")
    const mcp = raw["info"]["mcp"]
    if (!isRecord(mcp) || !isRecord(mcp["servers"]) || !isRecord(mcp["servers"]["docs"]))
      throw new Error("Expected an MCP server config")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("headers")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("oauth")
  }),
)

it.live("updates the global shell without replacing unrelated JSONC", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-shells-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        `{
  // keep this comment
  "model": "provider/model",
  "shell": "bash"
}
`,
      ),
    )
    const server = yield* startServer(global)
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ shell: "/bin/zsh" }),
      }),
    )

    expect(response.status).toBe(204)
    const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(text).toContain("// keep this comment")
    expect(text).toContain('"model": "provider/model"')
    expect(text).toContain('"shell": "/bin/zsh"')

    const shells = yield* Effect.promise(() =>
      fetch(new URL("/api/config/shell", server.base), { headers: server.headers }),
    )
    expect(shells.status).toBe(200)
    expect(Array.isArray(yield* Effect.promise(() => shells.json()))).toBe(true)
  }),
)

it.live("persists a custom provider through the config patch and keeps its key in the credential store", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-provider-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        `{
  // keep this comment
  "shell": "bash"
}
`,
      ),
    )
    const server = yield* startServer(global)

    // Criteria 1: the provider definition saves through the V2 config API,
    // with no shell field in the patch and no key material in it.
    const patch = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({
          providers: {
            acme: {
              name: "Acme",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: "https://api.acme.example/v1" },
              headers: { "X-Team": "blue" },
              models: { "acme-1": { name: "Acme 1" } },
            },
          },
        }),
      }),
    )
    expect(patch.status).toBe(204)

    // The key goes through the provider-scoped credential path: the
    // provider's own ID is its integration ID.
    const credential = yield* Effect.promise(() =>
      fetch(new URL("/api/credential", server.base), {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ integrationID: "acme", value: { type: "key", key: "sk-test-secret" } }),
      }),
    )
    expect(credential.status).toBe(200)

    const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(text).toContain("// keep this comment")
    expect(text).toContain('"shell": "bash"')
    expect(text).toContain('"acme"')
    expect(text).toContain("https://api.acme.example/v1")
    // The secret is never written into the config document.
    expect(text).not.toContain("sk-test-secret")

    // Criteria 2: after the reload the patch triggered, the provider is in
    // the served config and in the provider catalog with its model.
    const url = new URL("/api/config", server.base)
    url.searchParams.set("location[directory]", tmp.path)
    const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(
      yield* Effect.promise(() => fetch(url, { headers: server.headers }).then((response) => response.json())),
    )
    const document = entries.find(
      (entry): entry is Config.Document => entry.type === "document" && entry.path === config,
    )
    expect(document?.info.providers?.acme?.name).toBe("Acme")
    expect(document?.info.providers?.acme?.package).toBe("@opencode/ai/providers/openai-compatible")
    expect(document?.info.providers?.acme?.models?.["acme-1"]?.name).toBe("Acme 1")

    const providerURL = new URL("/api/provider", server.base)
    providerURL.searchParams.set("location[directory]", tmp.path)
    // The catalog rebuilds when the config reload lands, so poll briefly.
    let providers: unknown
    for (let attempt = 0; attempt < 20; attempt++) {
      providers = yield* Effect.promise(() =>
        fetch(providerURL, { headers: server.headers }).then((response) => response.json()),
      )
      if (JSON.stringify(providers).includes("acme-1")) break
      yield* Effect.sleep("250 millis")
    }
    expect(JSON.stringify(providers)).toContain("acme")
    expect(JSON.stringify(providers)).toContain("acme-1")
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
