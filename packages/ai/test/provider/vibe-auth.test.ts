import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Headers } from "effect/http"
import {
  API_KEY_ENV_VAR,
  CLI_USER_AGENT,
  KEYRING_SERVICE,
  LEGACY_KEYRING_SERVICE,
  NOT_SIGNED_IN_MESSAGE,
  invalidate,
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

  test("strips trailing comments after quoted values without stripping quoted hashes", () => {
    expect(parseDotEnv('MISTRAL_API_KEY="abc123" # rotated').MISTRAL_API_KEY).toBe("abc123")
    expect(parseDotEnv("MISTRAL_API_KEY='abc123' # note").MISTRAL_API_KEY).toBe("abc123")
    expect(parseDotEnv('MISTRAL_API_KEY="abc #123"').MISTRAL_API_KEY).toBe("abc #123")
    expect(parseDotEnv("MISTRAL_API_KEY=abc123 # note").MISTRAL_API_KEY).toBe("abc123")
    expect(parseDotEnv('MISTRAL_API_KEY="abc123" # note "comment" with quotes').MISTRAL_API_KEY).toBe("abc123")
    expect(parseDotEnv("MISTRAL_API_KEY='abc123' # don't fail").MISTRAL_API_KEY).toBe("abc123")
  })

  test("a multiline quoted value parses as one value and fabricates no keys from its inner lines", () => {
    const parsed = parseDotEnv(['A="line1', "B=injected", 'line3"', "C=real"].join("\n"))
    expect(parsed).toEqual({ A: "line1\nB=injected\nline3", C: "real" })
    const shadowed = parseDotEnv(['OUTER="x', "MISTRAL_API_KEY=fabricated", 'y"', "REAL=1"].join("\n"))
    expect(shadowed).toEqual({ OUTER: "x\nMISTRAL_API_KEY=fabricated\ny", REAL: "1" })
    expect("MISTRAL_API_KEY" in shadowed).toBe(false)
  })

  test("multiline single-quoted values stay literal, escapes included", () => {
    const parsed = parseDotEnv(["A='one", "two'", "B='a\\nb'"].join("\n"))
    expect(parsed).toEqual({ A: "one\ntwo", B: "a\\nb" })
  })

  test("double-quoted escapes expand while single-quoted values stay literal", () => {
    const parsed = parseDotEnv('D="a\\nb\\tc\\rd\\\\e\\"f"\nS=' + "'a\\nb'")
    expect(parsed).toEqual({ D: "a\nb\tc\rd\\e\"f", S: "a\\nb" })
  })

  test("unquoted trailing comments strip after a tab as well as a space", () => {
    expect(parseDotEnv("E=value\t# comment")).toEqual({ E: "value" })
    expect(parseDotEnv("E=value # comment")).toEqual({ E: "value" })
  })

  test("a quoted value followed by non-comment junk is skipped, not returned verbatim", () => {
    expect(parseDotEnv('F="quoted" junk')).toEqual({})
    expect(parseDotEnv('G="quoted" # a comment')).toEqual({ G: "quoted" })
    expect(parseDotEnv("H='quoted'\t# a comment")).toEqual({ H: "quoted" })
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
    expect(CLI_USER_AGENT).toBe("mistral-client-python/Mistral-Vibe/3.1.0")
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
  test("throwing keyringLookup on the environment win path still resolves with no diagnostic", async () => {
    const { seen, onShadowDiagnostic } = capture()
    const sources: CredentialSources = {
      env: { MISTRAL_API_KEY: "env-key" },
      readFile: noFile,
      keyringLookup: async () => {
        throw new Error("keyring unavailable")
      },
      onShadowDiagnostic,
    }
    await expect(resolveApiKey(sources)).resolves.toBe("env-key")
    expect(seen).toEqual([])
  })

  test("throwing keyringLookup on the .env file win path still resolves with no diagnostic", async () => {
    const { seen, onShadowDiagnostic } = capture()
    const sources: CredentialSources = {
      env: {},
      readFile: () => "MISTRAL_API_KEY=" + "file-key",
      keyringLookup: async () => {
        throw new Error("keyring unavailable")
      },
      onShadowDiagnostic,
    }
    await expect(resolveApiKey(sources)).resolves.toBe("file-key")
    expect(seen).toEqual([])
  })

  test("throwing onShadowDiagnostic sink still resolves the winning key", async () => {
    const sources: CredentialSources = {
      env: { MISTRAL_API_KEY: "env-key" },
      readFile: noFile,
      keyringLookup: keyringWith({ [KEYRING_SERVICE]: "keyring-key" }),
      onShadowDiagnostic: () => {
        throw new Error("sink unavailable")
      },
    }
    await expect(resolveApiKey(sources)).resolves.toBe("env-key")
  })

  test("a lookup throwing on the primary service abandons the probe: legacy is never queried and no diagnostic fires", async () => {
    const { seen, onShadowDiagnostic } = capture()
    const queried: string[] = []
    const sources: CredentialSources = {
      env: { MISTRAL_API_KEY: "env-key" },
      readFile: noFile,
      keyringLookup: async (service: string) => {
        queried.push(service)
        if (service === KEYRING_SERVICE) throw new Error("keyring unavailable")
        return "legacy-key"
      },
      onShadowDiagnostic,
    }
    await expect(resolveApiKey(sources)).resolves.toBe("env-key")
    expect(queried).toEqual([KEYRING_SERVICE])
    expect(seen).toEqual([])
  })

})

describe("vibeAuth - process cache and invalidate (#1900)", () => {
  const apply = (auth: ReturnType<typeof vibeAuth>) =>
    Effect.runPromise(
      auth.apply({
        request: {},
        method: "POST",
        url: "https://api.mistral.ai/v1/chat/completions",
        body: "{}",
        headers: Headers.fromInput({}),
      }),
    )

  test("no-source calls serve the cache until invalidate(), then re-resolve the rotated key", async () => {
    const original = process.env[API_KEY_ENV_VAR]
    invalidate()
    try {
      process.env[API_KEY_ENV_VAR] = "key-A"
      const first = await apply(vibeAuth({}))
      expect(first.authorization).toBe("Bearer " + "key-A")
      // Rotation alone does not take effect: the cache is process-global.
      process.env[API_KEY_ENV_VAR] = "key-B"
      const stale = await apply(vibeAuth({}))
      expect(stale.authorization).toBe("Bearer " + "key-A")
      // The trigger the transport fires on a 401: after invalidate() the
      // rotated key is resolved and the pre-rotation key is not sent again.
      invalidate()
      const recovered = await apply(vibeAuth({}))
      expect(recovered.authorization).toBe("Bearer " + "key-B")
    } finally {
      if (original === undefined) delete process.env[API_KEY_ENV_VAR]
      else process.env[API_KEY_ENV_VAR] = original
      invalidate()
    }
  })

  test("explicit-source calls bypass the process cache, as before", async () => {
    const env: Record<string, string | undefined> = { [API_KEY_ENV_VAR]: "source-A" }
    const sources: CredentialSources = { env, readFile: noFile, keyringLookup: async () => undefined }
    const first = await apply(vibeAuth({ sources }))
    expect(first.authorization).toBe("Bearer " + "source-A")
    env[API_KEY_ENV_VAR] = "source-B"
    const second = await apply(vibeAuth({ sources }))
    expect(second.authorization).toBe("Bearer " + "source-B")
  })
})
