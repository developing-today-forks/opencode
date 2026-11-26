// Validation and config shaping for the custom (OpenAI-compatible) provider
// form in the V2 connect flow. Restored from the V1 credentials form's
// validation contract (required fields, provider ID format, HTTP(S) base URL,
// duplicate model IDs, case-insensitive duplicate headers), reshaped onto the
// V2 config document: the provider persists under `providers.<id>` with the
// OpenAI-compatible package, its base URL in provider settings, and its models
// and headers alongside. The API key never enters the config shape: a plain
// key is returned separately so the caller can store it through the
// provider-scoped credential path, and a `{env:NAME}` reference is carried as
// the provider's `env` list instead.

export const CUSTOM_PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export type ModelErr = {
  id?: string
  name?: string
}

export type HeaderErr = {
  key?: string
  value?: string
}

export type ModelRow = {
  row: string
  id: string
  name: string
  err: ModelErr
}

export type HeaderRow = {
  row: string
  key: string
  value: string
  err: HeaderErr
}

export type FormState = {
  providerID: string
  name: string
  baseURL: string
  apiKey: string
  models: ModelRow[]
  headers: HeaderRow[]
  err: {
    providerID?: string
    name?: string
    baseURL?: string
  }
}

/** The V2 config entry persisted for one custom provider. Deliberately has no
 * API-key field: key material lives in the credential store, not in config. */
export type CustomProviderConfig = {
  name: string
  package: string
  env?: string[]
  settings: { baseURL: string }
  headers?: Record<string, string>
  models: Record<string, { name: string }>
}

export type CustomProviderDraft = {
  providerID: string
  name: string
  /** Plain API key to store as a provider-scoped credential; absent when the
   * form named an environment variable instead. */
  key?: string
  config: CustomProviderConfig
}

type ValidateArgs = {
  form: FormState
  t: Translator
  disabledProviders: string[]
  existingProviderIDs: Set<string>
  /** The provider being edited, if any: its own ID is exempt from the
   * duplicate-ID check, since saving an edit patches the same provider. */
  editingProviderID?: string
}

export function validateCustomProvider(input: ValidateArgs) {
  const providerID = input.form.providerID.trim()
  const name = input.form.name.trim()
  const baseURL = input.form.baseURL.trim()
  const apiKey = input.form.apiKey.trim()

  const env = apiKey.match(/^\{env:([^}]+)\}$/)?.[1]?.trim()
  const key = apiKey && !env ? apiKey : undefined

  const idError = !providerID
    ? input.t("provider.custom.error.providerID.required")
    : !PROVIDER_ID.test(providerID)
      ? input.t("provider.custom.error.providerID.format")
      : undefined

  const nameError = !name ? input.t("provider.custom.error.name.required") : undefined

  const urlError = !baseURL
    ? input.t("provider.custom.error.baseURL.required")
    : !/^https?:\/\//.test(baseURL)
      ? input.t("provider.custom.error.baseURL.format")
      : undefined

  const disabled = input.disabledProviders.includes(providerID)

  const existsError = idError
    ? undefined
    : input.existingProviderIDs.has(providerID) && providerID !== input.editingProviderID && !disabled
      ? input.t("provider.custom.error.providerID.exists")
      : undefined

  const seenModels = new Set<string>()

  const models = input.form.models.map((m) => {
    const id = m.id.trim()

    const idError = !id
      ? input.t("provider.custom.error.required")
      : seenModels.has(id)
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenModels.add(id)

            return undefined
          })()

    const nameError = !m.name.trim() ? input.t("provider.custom.error.required") : undefined

    return { id: idError, name: nameError }
  })

  const modelsValid = models.every((m) => !m.id && !m.name)
  const modelConfig = Object.fromEntries(input.form.models.map((m) => [m.id.trim(), { name: m.name.trim() }]))

  const seenHeaders = new Set<string>()

  const headers = input.form.headers.map((h) => {
    const key = h.key.trim()
    const value = h.value.trim()

    if (!key && !value) return {}

    const keyError = !key
      ? input.t("provider.custom.error.required")
      : seenHeaders.has(key.toLowerCase())
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenHeaders.add(key.toLowerCase())

            return undefined
          })()

    const valueError = !value ? input.t("provider.custom.error.required") : undefined

    return { key: keyError, value: valueError }
  })

  const headersValid = headers.every((h) => !h.key && !h.value)

  const headerConfig = Object.fromEntries(
    input.form.headers
      .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
      .filter((h) => !!h.key && !!h.value)
      .map((h) => [h.key, h.value]),
  )

  const err = {
    providerID: idError ?? existsError,
    name: nameError,
    baseURL: urlError,
  }

  const ok = !idError && !existsError && !nameError && !urlError && modelsValid && headersValid

  if (!ok) return { err, models, headers }

  return {
    err,
    models,
    headers,
    result: {
      providerID,
      name,
      key,
      config: {
        name,
        package: CUSTOM_PROVIDER_PACKAGE,
        ...(env ? { env: [env] } : {}),
        settings: { baseURL },
        ...(Object.keys(headerConfig).length ? { headers: headerConfig } : {}),
        models: modelConfig,
      },
    } satisfies CustomProviderDraft,
  }
}

let row = 0

const nextRow = () => `row-${row++}`

export const modelRow = (): ModelRow => ({ row: nextRow(), id: "", name: "", err: {} })

export const headerRow = (): HeaderRow => ({ row: nextRow(), key: "", value: "", err: {} })

export const emptyCustomProviderForm = (): FormState => ({
  providerID: "",
  name: "",
  baseURL: "",
  apiKey: "",
  models: [modelRow()],
  headers: [headerRow()],
  err: {},
})

/** The subset of a persisted provider config entry the edit form can
 * prefill, as read back from the config documents (`config.get`). Loosely
 * typed on purpose: the config schema carries settings as JSON values, so
 * the base URL is only taken when it really is a string. */
export type CustomProviderConfigSource = {
  name: string
  env?: readonly string[]
  settings?: { baseURL?: unknown }
  headers?: Record<string, string>
  models?: Record<string, { name?: string }>
}

/**
 * The edit form for a saved custom provider, prefilled from its persisted
 * config entry. The API key itself is never in config: an `{env:NAME}`
 * reference is restored from the entry's `env` list, and a plain key stays
 * in the credential store — the field starts empty, which the save path
 * treats as "keep the stored key" (a new key replaces it, and the dialog's
 * clear action removes it).
 */
export const customProviderFormFromConfig = (providerID: string, config: CustomProviderConfigSource): FormState => {
  const models = Object.entries(config.models ?? {}).map(([id, model]) => ({
    row: nextRow(),
    id,
    name: model.name ?? "",
    err: {},
  }))

  const headers = Object.entries(config.headers ?? {}).map(([key, value]) => ({
    row: nextRow(),
    key,
    value,
    err: {},
  }))

  return {
    providerID,
    name: config.name,
    baseURL: typeof config.settings?.baseURL === "string" ? config.settings.baseURL : "",
    apiKey: config.env?.[0] ? `{env:${config.env[0]}}` : "",
    models: models.length ? models : [modelRow()],
    headers: headers.length ? headers : [headerRow()],
    err: {},
  }
}
