import { describe, expect, test } from "bun:test"
import {
  KEYRING_SERVICE,
  LEGACY_KEYRING_SERVICE,
  resolveApiKey,
  type CredentialSources,
  type ShadowDiagnostic,
} from "../../src/providers/vibe-auth.js"

const noFile = () => undefined

describe("probe: shadow diagnostic never-break guarantee", () => {
  test("a THROWING keyringLookup still resolves the environment key, no diagnostic", async () => {
    const seen: ShadowDiagnostic[] = []
    const sources: CredentialSources = {
      env: { MISTRAL_API_KEY: "env-key" },
      readFile: noFile,
      keyringLookup: async () => { throw new Error("keyring daemon down") },
      onShadowDiagnostic: (d) => void seen.push(d),
    }
    await expect(resolveApiKey(sources)).resolves.toBe("env-key")
    expect(seen).toEqual([])
  })
  test("a THROWING onShadowDiagnostic sink still resolves the environment key", async () => {
    const sources: CredentialSources = {
      env: { MISTRAL_API_KEY: "env-key" },
      readFile: noFile,
      keyringLookup: async (service) => (service === KEYRING_SERVICE ? "keyring-key" : undefined),
      onShadowDiagnostic: () => { throw new Error("sink broken") },
    }
    await expect(resolveApiKey(sources)).resolves.toBe("env-key")
  })
  test("a THROWING keyringLookup still resolves the dotenv-file key", async () => {
    const sources: CredentialSources = {
      env: {},
      readFile: () => "MISTRAL_API_KEY=file-key",
      keyringLookup: async () => { throw new Error("keyring daemon down") },
      onShadowDiagnostic: () => {},
    }
    await expect(resolveApiKey(sources)).resolves.toBe("file-key")
  })
  test("a lookup throwing on the FIRST service abandons the probe: legacy entry never checked, no diagnostic", async () => {
    const seen: ShadowDiagnostic[] = []
    const calls: string[] = []
    const sources: CredentialSources = {
      env: { MISTRAL_API_KEY: "env-key" },
      readFile: noFile,
      keyringLookup: async (service) => {
        calls.push(service)
        if (service === KEYRING_SERVICE) throw new Error("primary lookup down")
        return "legacy-key"
      },
      onShadowDiagnostic: (d) => void seen.push(d),
    }
    await expect(resolveApiKey(sources)).resolves.toBe("env-key")
    expect(calls).toEqual([KEYRING_SERVICE])
    expect(seen).toEqual([])
  })
  test("CONTROL: non-throwing shadow case emits exactly one diagnostic", async () => {
    const seen: ShadowDiagnostic[] = []
    const sources: CredentialSources = {
      env: { MISTRAL_API_KEY: "env-key" },
      readFile: noFile,
      keyringLookup: async (service) => (service === LEGACY_KEYRING_SERVICE ? "legacy-key" : undefined),
      onShadowDiagnostic: (d) => void seen.push(d),
    }
    await expect(resolveApiKey(sources)).resolves.toBe("env-key")
    expect(seen).toEqual([{ winningTier: "environment", shadowedService: LEGACY_KEYRING_SERVICE }])
  })
})
