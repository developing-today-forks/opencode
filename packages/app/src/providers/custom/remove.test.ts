import { describe, expect, test } from "bun:test"
import { CUSTOM_PROVIDER_PACKAGE, type CustomProviderConfig } from "./form"
import { removeCustomProvider, type RemoveCustomProviderApi } from "./remove"

const existing: CustomProviderConfig = {
  name: "Acme",
  package: CUSTOM_PROVIDER_PACKAGE,
  settings: { baseURL: "https://api.acme.example/v1" },
  models: { "acme-1": { name: "Acme 1" } },
}

/**
 * A fake server mirroring save.test.ts: the config document and the
 * credential store are separate persisted maps, and `reload()` re-reads both
 * from scratch — so a provider that only disappeared in memory during the
 * removal would reappear here.
 */
function fakeServer(fail: { config?: boolean; credential?: boolean } = {}) {
  const configDocument: { providers: Record<string, CustomProviderConfig> } = { providers: { acme: existing } }
  const credentials = new Map<string, { type: "key"; key: string }>([["cred-1", { type: "key", key: "sk-test" }]])
  const calls: string[] = []

  const api: RemoveCustomProviderApi = {
    updateConfig: async (input) => {
      calls.push("config")

      if (fail.config) throw new Error("config unavailable")

      for (const [id, value] of Object.entries(input.providers)) {
        if (value === null) delete configDocument.providers[id]
      }
    },
    removeCredential: async (input) => {
      calls.push("credential")

      if (fail.credential) throw new Error("credential unavailable")
      credentials.delete(input.credentialID)
    },
    reload: async () => {
      calls.push("reload")
    },
  }

  return { api, calls, configDocument, credentials }
}

describe("removeCustomProvider", () => {
  test("removes the config entry and the credential, and the provider stays gone after a reload", async () => {
    const server = fakeServer()

    const result = await removeCustomProvider({ providerID: "acme", credentialIDs: ["cred-1"], api: server.api })

    expect(result).toEqual({ ok: true, providerID: "acme" })
    expect(server.calls).toEqual(["config", "credential", "reload"])
    expect(server.configDocument.providers.acme).toBeUndefined()
    expect(server.credentials.size).toBe(0)
  })

  test("a provider with no stored credential is removed with the config patch only", async () => {
    const server = fakeServer()

    const result = await removeCustomProvider({ providerID: "acme", credentialIDs: [], api: server.api })

    expect(result).toEqual({ ok: true, providerID: "acme" })
    expect(server.calls).toEqual(["config", "reload"])
    expect(server.configDocument.providers.acme).toBeUndefined()
  })

  test("a config failure removes nothing and reports the config stage", async () => {
    const server = fakeServer({ config: true })

    const result = await removeCustomProvider({ providerID: "acme", credentialIDs: ["cred-1"], api: server.api })

    expect(result.ok).toBe(false)

    if (!result.ok) expect(result.stage).toBe("config")
    expect(server.calls).toEqual(["config"])
    expect(server.configDocument.providers.acme).toEqual(existing)
    expect(server.credentials.size).toBe(1)
  })

  test("a credential failure reports the partial state without claiming success", async () => {
    const server = fakeServer({ credential: true })

    const result = await removeCustomProvider({ providerID: "acme", credentialIDs: ["cred-1"], api: server.api })

    expect(result.ok).toBe(false)

    if (!result.ok && result.stage === "credential") {
      expect(result.configRemoved).toBe(true)
    } else {
      throw new Error("expected a credential-stage failure")
    }

    // The config entry is gone; only the orphaned credential remains.
    expect(server.configDocument.providers.acme).toBeUndefined()
    expect(server.credentials.size).toBe(1)
  })
})
