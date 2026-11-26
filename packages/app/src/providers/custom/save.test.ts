import { describe, expect, test } from "bun:test"
import { emptyCustomProviderForm, type CustomProviderConfig, type FormState } from "./form"
import { saveCustomProvider, type CustomProviderApi } from "./save"

const t = (key: string) => key

const form = (overrides: Partial<FormState> = {}): FormState => ({
  ...emptyCustomProviderForm(),
  providerID: "acme",
  name: "Acme",
  baseURL: "https://api.acme.example/v1",
  apiKey: "sk-test",
  models: [{ row: "m1", id: "acme-1", name: "Acme 1", err: {} }],
  headers: [{ row: "h1", key: "", value: "", err: {} }],
  ...overrides,
})

/**
 * A fake server: the config document and the credential store are separate
 * persisted maps, and `reload()` re-reads both from scratch the way a client
 * reload re-fetches the catalogs — so a provider that only existed in memory
 * during the save would not survive it.
 */
function fakeServer(fail: { config?: boolean; credential?: boolean } = {}) {
  const configDocument: { providers: Record<string, CustomProviderConfig> } = { providers: {} }
  const credentials = new Map<string, { type: "key"; key: string }>()
  const calls: string[] = []

  const api: CustomProviderApi = {
    updateConfig: async (input) => {
      calls.push("config")

      if (fail.config) throw new Error("config unavailable")
      Object.assign(configDocument.providers, input.providers)
    },
    createCredential: async (input) => {
      calls.push("credential")

      if (fail.credential) throw new Error("credential unavailable")
      credentials.set(input.integrationID, input.value)
    },
    removeCredentials: async (integrationID) => {
      calls.push("credential.remove")

      if (fail.credential) throw new Error("credential unavailable")
      credentials.delete(integrationID)
    },
    reload: async () => {
      calls.push("reload")
    },
  }

  // What provider resolution sees after a reload: the persisted provider
  // definition plus, for a key credential under the provider's own
  // integration ID, the apiKey the model resolver derives from it.
  const resolvedAfterReload = (providerID: string) => {
    const provider = configDocument.providers[providerID]

    if (!provider) return undefined
    const credential = credentials.get(providerID)

    return {
      ...provider,
      settings: {
        ...provider.settings,
        ...(credential ? { apiKey: credential.key } : {}),
      },
    }
  }

  return { api, calls, configDocument, credentials, resolvedAfterReload }
}

describe("saveCustomProvider", () => {
  test("saves config and credential separately and the provider survives a reload", async () => {
    const server = fakeServer()

    const result = await saveCustomProvider({ form: form(), t, existingProviderIDs: new Set(), api: server.api })

    expect(result).toEqual({ ok: true, providerID: "acme" })
    expect(server.calls).toEqual(["config", "credential", "reload"])
    // The persisted config never contains the secret.
    expect(JSON.stringify(server.configDocument)).not.toContain("sk-test")
    expect(server.credentials.get("acme")).toEqual({ type: "key", key: "sk-test" })

    const resolved = server.resolvedAfterReload("acme")
    expect(resolved?.package).toBe("@opencode/ai/providers/openai-compatible")
    expect(resolved?.settings.baseURL).toBe("https://api.acme.example/v1")
    expect(resolved?.settings.apiKey).toBe("sk-test")
    expect(resolved?.models).toEqual({ "acme-1": { name: "Acme 1" } })
  })

  test("an env-reference key stores no credential", async () => {
    const server = fakeServer()

    const result = await saveCustomProvider({
      form: form({ apiKey: "{env:ACME_API_KEY}" }),
      t,
      existingProviderIDs: new Set(),
      api: server.api,
    })

    expect(result).toEqual({ ok: true, providerID: "acme" })
    expect(server.calls).toEqual(["config", "reload"])
    expect(server.configDocument.providers.acme?.env).toEqual(["ACME_API_KEY"])
    expect(server.credentials.size).toBe(0)
  })

  test("a config failure stores no credential and reports the config stage", async () => {
    const server = fakeServer({ config: true })

    const result = await saveCustomProvider({ form: form(), t, existingProviderIDs: new Set(), api: server.api })

    expect(result.ok).toBe(false)

    if (!result.ok) {
      expect(result.stage).toBe("config")
    }

    expect(server.calls).toEqual(["config"])
    expect(server.credentials.size).toBe(0)
    expect(server.resolvedAfterReload("acme")).toBeUndefined()
  })

  test("a credential failure reports the partial state without claiming success", async () => {
    const server = fakeServer({ credential: true })

    const result = await saveCustomProvider({ form: form(), t, existingProviderIDs: new Set(), api: server.api })

    expect(result.ok).toBe(false)

    if (!result.ok && result.stage === "credential") {
      expect(result.configSaved).toBe(true)
    } else {
      throw new Error("expected a credential-stage failure")
    }

    // The config persisted; the provider is configured but has no key yet.
    expect(server.configDocument.providers.acme?.name).toBe("Acme")
    expect(server.resolvedAfterReload("acme")?.settings.apiKey).toBeUndefined()
  })

  test("invalid input is a validation failure and calls no API", async () => {
    const server = fakeServer()

    const result = await saveCustomProvider({
      form: form({ baseURL: "not-a-url" }),
      t,
      existingProviderIDs: new Set(),
      api: server.api,
    })

    expect(result.ok).toBe(false)

    if (!result.ok) expect(result.stage).toBe("validation")
    expect(server.calls).toEqual([])
  })
})

describe("saveCustomProvider editing", () => {
  test("an edit patches the same provider ID despite it already existing", async () => {
    const server = fakeServer()

    const result = await saveCustomProvider({
      form: form({ name: "Acme Renamed", apiKey: "" }),
      t,
      existingProviderIDs: new Set(["acme"]),
      editingProviderID: "acme",
      api: server.api,
    })

    expect(result).toEqual({ ok: true, providerID: "acme" })
    // No key entered on edit: the stored credential is left untouched.
    expect(server.calls).toEqual(["config", "reload"])
    expect(server.configDocument.providers.acme?.name).toBe("Acme Renamed")
  })

  test("an edit with a new key stores it as the provider credential", async () => {
    const server = fakeServer()
    server.credentials.set("acme", { type: "key", key: "sk-old" })

    const result = await saveCustomProvider({
      form: form({ apiKey: "sk-new" }),
      t,
      existingProviderIDs: new Set(["acme"]),
      editingProviderID: "acme",
      api: server.api,
    })

    expect(result).toEqual({ ok: true, providerID: "acme" })
    expect(server.calls).toEqual(["config", "credential", "reload"])
    expect(server.resolvedAfterReload("acme")?.settings.apiKey).toBe("sk-new")
  })

  test("an edit that clears the key removes the stored credential after the config patch", async () => {
    const server = fakeServer()
    server.credentials.set("acme", { type: "key", key: "sk-old" })

    const result = await saveCustomProvider({
      form: form({ apiKey: "" }),
      t,
      existingProviderIDs: new Set(["acme"]),
      editingProviderID: "acme",
      clearKey: true,
      api: server.api,
    })

    expect(result).toEqual({ ok: true, providerID: "acme" })
    expect(server.calls).toEqual(["config", "credential.remove", "reload"])
    expect(server.credentials.size).toBe(0)
    expect(server.resolvedAfterReload("acme")?.settings.apiKey).toBeUndefined()
  })

  test("a failed key clear reports the credential stage with the config saved", async () => {
    const server = fakeServer({ credential: true })
    server.credentials.set("acme", { type: "key", key: "sk-old" })

    const result = await saveCustomProvider({
      form: form({ apiKey: "" }),
      t,
      existingProviderIDs: new Set(["acme"]),
      editingProviderID: "acme",
      clearKey: true,
      api: server.api,
    })

    expect(result.ok).toBe(false)

    if (!result.ok && result.stage === "credential") {
      expect(result.configSaved).toBe(true)
    } else {
      throw new Error("expected a credential-stage failure")
    }

    expect(server.configDocument.providers.acme?.name).toBe("Acme")
    expect(server.credentials.get("acme")).toEqual({ type: "key", key: "sk-old" })
  })
})
