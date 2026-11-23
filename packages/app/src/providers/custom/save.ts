import { validateCustomProvider, type CustomProviderConfig, type FormState } from "./form"

// The save path for a custom OpenAI-compatible provider in V2, in the only
// order that keeps config and secrets consistent:
//
// 1. The provider definition (name, package, base URL, headers, models) is
//    persisted through the supported config API (`experimental.config.update`
//    with a `providers` patch). No key material is ever sent to config.
// 2. A plain API key is stored through the provider-scoped credential path:
//    configuring a provider makes the server expose an integration with the
//    provider's own ID and a key method, and the model resolver turns that
//    integration's active key credential into the provider's `apiKey` at
//    request time. A `{env:NAME}` reference skips this step — the config's
//    `env` list already names the variable.
// 3. The caller reloads the provider/integration catalogs, so the saved
//    provider is connectable/selectable immediately and after a reload (the
//    config document and the credential both persist server-side).
//
// Failures are reported by stage and never claim success: a config failure
// stores nothing else, and a credential failure says the config was saved so
// the UI can surface the partial state while keeping the entered form state
// for a retry.

export interface CustomProviderApi {
  updateConfig(input: { providers: Record<string, CustomProviderConfig> }): Promise<unknown>
  createCredential(input: { integrationID: string; value: { type: "key"; key: string } }): Promise<unknown>
  /** Reloads the catalogs after a successful save; best-effort by contract —
   * the persisted config and credential are the source of truth. */
  reload?(providerID: string): Promise<unknown> | unknown
}

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export type SaveCustomProviderResult =
  | { ok: true; providerID: string }
  | {
      ok: false
      stage: "validation"
      err: ReturnType<typeof validateCustomProvider>["err"]
      models: ReturnType<typeof validateCustomProvider>["models"]
      headers: ReturnType<typeof validateCustomProvider>["headers"]
    }
  | { ok: false; stage: "config"; providerID: string; error: unknown }
  | { ok: false; stage: "credential"; providerID: string; configSaved: true; error: unknown }

export async function saveCustomProvider(input: {
  form: FormState
  t: Translator
  existingProviderIDs: Set<string>
  disabledProviders?: string[]
  api: CustomProviderApi
}): Promise<SaveCustomProviderResult> {
  const validated = validateCustomProvider({
    form: input.form,
    t: input.t,
    disabledProviders: input.disabledProviders ?? [],
    existingProviderIDs: input.existingProviderIDs,
  })

  if (!validated.result)
    return { ok: false, stage: "validation", err: validated.err, models: validated.models, headers: validated.headers }

  const { providerID, key, config } = validated.result

  try {
    await input.api.updateConfig({ providers: { [providerID]: config } })
  } catch (error) {
    return { ok: false, stage: "config", providerID, error }
  }

  if (key) {
    try {
      await input.api.createCredential({ integrationID: providerID, value: { type: "key", key } })
    } catch (error) {
      return { ok: false, stage: "credential", providerID, configSaved: true, error }
    }
  }

  await Promise.resolve(input.api.reload?.(providerID)).catch(() => undefined)

  return { ok: true, providerID }
}
