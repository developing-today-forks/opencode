import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  API_KEY_ENV_VAR,
  KEYRING_SERVICE,
  LEGACY_KEYRING_SERVICE,
  NOT_SIGNED_IN_MESSAGE,
  parseDotEnv,
  resolveApiKey,
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
