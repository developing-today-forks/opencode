import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Headers } from "effect/http"
import {
  API_KEY_ENV_VAR,
  CLI_USER_AGENT,
  KEYRING_SERVICE,
  LEGACY_KEYRING_SERVICE,
  NOT_SIGNED_IN_MESSAGE,
  parseDotEnv,
  resolveApiKey,
  vibeAuth,
  type ShadowDiagnostic,
  type CredentialSources,
} from "../../src/providers/vibe-auth.js"

const noFile = () => undefined
const keyringWith =
  (entries: Readonly<Record<string, string>>) =>
  async (service: string): Promise<string | undefined> =>
    entries[service]

describe("parseDotEnv", () => {
  test("parses plain, quoted, exported, and commented lines", () => {
    const parsed = parseDotEnv(
      [
        "# a comment",
        "",
        "MISTRAL_API_KEY=plain-key",
        'QUOTED="dq-key"',
        "SINGLE='sq-key'",
        "export EXPORTED=exp-key",
        "SPACED = spaced-key ",
        "TRAILING=trail-key # a trailing comment",
        "NO_EQUALS_SIGN",
        "=no-key",
      ].join("\n"),
    )
    expect(parsed).toEqual({
      MISTRAL_API_KEY: "plain-key",
      QUOTED: "dq-key",
      SINGLE: "sq-key",
      EXPORTED: "exp-key",
      SPACED: "spaced-key",
      TRAILING: "trail-key",
    })
  })

  test("handles CRLF and empty values", () => {
    const parsed = parseDotEnv("A=1\r\nB=\r\nC=3")
    expect(parsed).toEqual({ A: "1", B: "", C: "3" })
  })
})

describe("resolveApiKey — the binary's resolution order", () => {
  test("environment wins over the .env file and the keyring", async () => {
    const sources: CredentialSources = {
      env: { MISTRAL_API_KEY: "env-key" },
      readFile: () => "MISTRAL_API_KEY=file-key",
      keyringLookup: keyringWith({ [KEYRING_SERVICE]: "keyring-key" }),
    }
    await expect(resolveApiKey(sources)).resolves.toBe("env-key")
  })

  test(".env file wins over the keyring; the real env wins over the file", async () => {
    const sources: CredentialSources = {
      env: {},
      readFile: () => "MISTRAL_API_KEY=file-key",
      keyringLookup: keyringWith({ [KEYRING_SERVICE]: "keyring-key" }),
    }
    await expect(resolveApiKey(sources)).resolves.toBe("file-key")
  })

  test("keyring primary service is read with the binary's coordinates", async () => {
    const seen: Array<[string, string]> = []
    const sources: CredentialSources = {
      env: {},
      readFile: noFile,
      keyringLookup: async (service, username) => {
        seen.push([service, username])
        return service === KEYRING_SERVICE ? "keyring-key" : undefined
      },
    }
    await expect(resolveApiKey(sources)).resolves.toBe("keyring-key")
    expect(seen).toEqual([[KEYRING_SERVICE, API_KEY_ENV_VAR]])
  })

  test("legacy keyring service is the fallback", async () => {
    const sources: CredentialSources = {
      env: {},
      readFile: noFile,
      keyringLookup: keyringWith({ [LEGACY_KEYRING_SERVICE]: "legacy-key" }),
    }
    await expect(resolveApiKey(sources)).resolves.toBe("legacy-key")
  })

  test("blank values do not count as credentials", async () => {
    const sources: CredentialSources = {
      env: { MISTRAL_API_KEY: "   " },
      readFile: () => "MISTRAL_API_KEY=",
      keyringLookup: keyringWith({ [KEYRING_SERVICE]: "keyring-key" }),
    }
    await expect(resolveApiKey(sources)).resolves.toBe("keyring-key")
  })

  test("absent everywhere rejects with the not-signed-in guidance", async () => {
    const sources: CredentialSources = { env: {}, readFile: noFile, keyringLookup: async () => undefined }
    await expect(resolveApiKey(sources)).rejects.toThrow(NOT_SIGNED_IN_MESSAGE)
    await expect(resolveApiKey(sources)).rejects.toThrow("vibe --setup")
  })

  test("the .env file is read from $VIBE_HOME when set, else ~/.vibe", async () => {
    const paths: string[] = []
    const readFile = (path: string) => {
      paths.push(path)
      return undefined
    }
    await expect(
      resolveApiKey({ env: { VIBE_HOME: "/tmp/vibe-home" }, readFile, keyringLookup: async () => "k" }),
    ).resolves.toBe("k")
    await expect(resolveApiKey({ env: {}, readFile, keyringLookup: async () => "k" })).resolves.toBe("k")
    expect(paths[0]).toBe("/tmp/vibe-home/.env")
    expect(paths[1]).toMatch(/\/.vibe\/\.env$/)
  })
})

describe("vibeAuth - the Vibe CLI's User-Agent, stamped after the transport merge", () => {
  // Same merge hazard as claude-code-auth: without the auth-layer stamp,
  // a session request's own harness UA is what reaches Mistral's wire.
  const sessionHeaders = () => Headers.fromInput({ "User-Agent": "opencode/prod/test/cli" })
  const apply = (auth: ReturnType<typeof vibeAuth>) =>
    Effect.runPromise(
      auth.apply({
        request: {},
        method: "POST",
        url: "https://api.mistral.ai/v1/chat/completions",
        body: "{}",
        headers: sessionHeaders(),
      }),
    )

  test("CLI_USER_AGENT is the audited binary's wire value (mistral-vibe 3.1.0)", () => {
    expect(CLI_USER_AGENT).toBe("Mistral-Vibe/3.1.0")
  })

  test("the static apiKey path stamps the Vibe UA over the session UA", async () => {
    const headers = await apply(vibeAuth({ apiKey: "fixture-key" }))
    expect(headers["user-agent"]).toBe(CLI_USER_AGENT)
    expect(headers.authorization).toBe("Bearer " + "fixture-key")
  })

  test("the env-resolved key path stamps the Vibe UA over the session UA", async () => {
    const headers = await apply(vibeAuth({ sources: { env: { MISTRAL_API_KEY: "env-key" } } }))
    expect(headers["user-agent"]).toBe(CLI_USER_AGENT)
    expect(headers.authorization).toBe("Bearer " + "env-key")
  })
})

describe("resolveApiKey — shadow diagnostic (#1809)", () => {
  const capture = () => {
    const seen: ShadowDiagnostic[] = []
    return { seen, onShadowDiagnostic: (diagnostic: ShadowDiagnostic) => void seen.push(diagnostic) }
  }

  test("environment win over an existing keyring entry emits the diagnostic", async () => {
    const { seen, onShadowDiagnostic } = capture()
    const sources: CredentialSources = {
      env: { MISTRAL_API_KEY: "env-key" },
      readFile: noFile,
      keyringLookup: keyringWith({ [KEYRING_SERVICE]: "keyring-key" }),
      onShadowDiagnostic,
    }
    await expect(resolveApiKey(sources)).resolves.toBe("env-key")
    expect(seen).toEqual([{ winningTier: "environment", shadowedService: KEYRING_SERVICE }])
    // The diagnostic names the tier and the shadowed service only — no
    // part of either credential value may appear in it.
    expect(JSON.stringify(seen)).not.toContain("env-key")
    expect(JSON.stringify(seen)).not.toContain("keyring-key")
  })

  test(".env file win over an existing keyring entry emits the diagnostic", async () => {
    const { seen, onShadowDiagnostic } = capture()
    const sources: CredentialSources = {
      env: {},
      readFile: () => "MISTRAL_API_KEY=" + "file-key",
      keyringLookup: keyringWith({ [LEGACY_KEYRING_SERVICE]: "legacy-key" }),
      onShadowDiagnostic,
    }
    await expect(resolveApiKey(sources)).resolves.toBe("file-key")
    expect(seen).toEqual([{ winningTier: "dotenv-file", shadowedService: LEGACY_KEYRING_SERVICE }])
  })

  test("keyring win emits no shadow diagnostic", async () => {
    const { seen, onShadowDiagnostic } = capture()
    const sources: CredentialSources = {
      env: {},
      readFile: noFile,
      keyringLookup: keyringWith({ [KEYRING_SERVICE]: "keyring-key" }),
      onShadowDiagnostic,
    }
    await expect(resolveApiKey(sources)).resolves.toBe("keyring-key")
    expect(seen).toEqual([])
  })

  test("environment win with no keyring entry does not claim a shadow", async () => {
    const { seen, onShadowDiagnostic } = capture()
    const sources: CredentialSources = {
      env: { MISTRAL_API_KEY: "env-key" },
      readFile: noFile,
      keyringLookup: async () => undefined,
      onShadowDiagnostic,
    }
    await expect(resolveApiKey(sources)).resolves.toBe("env-key")
    expect(seen).toEqual([])
  })
})
