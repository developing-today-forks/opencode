import { describe, expect, test } from "bun:test"
import { CUSTOM_PROVIDER_PACKAGE, emptyCustomProviderForm, validateCustomProvider, type FormState } from "./form"

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

const validate = (input: FormState, existing: string[] = []) =>
  validateCustomProvider({ form: input, t, disabledProviders: [], existingProviderIDs: new Set(existing) })

describe("validateCustomProvider", () => {
  test("builds the V2 config for a valid form and keeps the key out of it", () => {
    const result = validate(
      form({
        headers: [{ row: "h1", key: "X-Team", value: "blue", err: {} }],
      }),
    )

    expect(result.result).toEqual({
      providerID: "acme",
      name: "Acme",
      key: "sk-test",
      config: {
        name: "Acme",
        package: CUSTOM_PROVIDER_PACKAGE,
        settings: { baseURL: "https://api.acme.example/v1" },
        headers: { "X-Team": "blue" },
        models: { "acme-1": { name: "Acme 1" } },
      },
    })
    expect(JSON.stringify(result.result?.config)).not.toContain("sk-test")
  })

  test("an env reference becomes the provider env list and no key", () => {
    const result = validate(form({ apiKey: "{env:ACME_API_KEY}" }))

    expect(result.result?.key).toBeUndefined()
    expect(result.result?.config.env).toEqual(["ACME_API_KEY"])
  })

  test("requires provider ID, name, and an HTTP(S) base URL", () => {
    const result = validate(form({ providerID: "Bad ID!", name: " ", baseURL: "api.acme.example/v1" }))

    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBe("provider.custom.error.providerID.format")
    expect(result.err.name).toBe("provider.custom.error.name.required")
    expect(result.err.baseURL).toBe("provider.custom.error.baseURL.format")
  })

  test("rejects a provider ID that already exists unless it is disabled", () => {
    expect(validate(form(), ["acme"]).err.providerID).toBe("provider.custom.error.providerID.exists")

    const disabled = validateCustomProvider({
      form: form(),
      t,
      disabledProviders: ["acme"],
      existingProviderIDs: new Set(["acme"]),
    })

    expect(disabled.result?.providerID).toBe("acme")
  })

  test("rejects duplicate model IDs and case-insensitive duplicate headers", () => {
    const result = validate(
      form({
        models: [
          { row: "m1", id: "acme-1", name: "One", err: {} },
          { row: "m2", id: "acme-1", name: "Two", err: {} },
        ],
        headers: [
          { row: "h1", key: "X-Team", value: "blue", err: {} },
          { row: "h2", key: "x-team", value: "red", err: {} },
        ],
      }),
    )

    expect(result.result).toBeUndefined()
    expect(result.models[1].id).toBe("provider.custom.error.duplicate")
    expect(result.headers[1].key).toBe("provider.custom.error.duplicate")
  })
})
