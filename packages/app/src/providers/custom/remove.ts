// The remove path for a saved custom OpenAI-compatible provider in V2, in
// the only order that keeps config and secrets consistent:
//
// 1. The provider definition is deleted from the global config document
//    through the supported config API (`experimental.config.update` with a
//    `providers: { <id>: null }` patch, which the core config writer maps to
//    deleting the key). If this fails, nothing else is touched, so the
//    provider is still fully intact.
// 2. The provider's stored credentials are removed through the credential
//    API, so no orphaned key material survives the provider it belonged to.
//    The caller supplies the credential IDs from the provider's integration
//    (the same enumeration the Settings disconnect flow uses).
// 3. The caller reloads the provider/integration catalogs, so the provider
//    disappears from the catalog immediately and stays gone after a reload
//    (the config document and the credential store are the source of truth).
//
// Failures are reported by stage and never claim success: a credential
// failure says the config entry was already removed, so the UI can surface
// the partial state instead of pretending the provider still exists.

export interface RemoveCustomProviderApi {
  updateConfig(input: { providers: Record<string, null> }): Promise<unknown>
  removeCredential(input: { credentialID: string }): Promise<unknown>
  /** Reloads the catalogs after a successful removal; best-effort by
   * contract — the persisted config and credential store are the source of
   * truth. */
  reload?(providerID: string): Promise<unknown> | unknown
}

export type RemoveCustomProviderResult =
  | { ok: true; providerID: string }
  | { ok: false; stage: "config"; providerID: string; error: unknown }
  | { ok: false; stage: "credential"; providerID: string; configRemoved: true; error: unknown }

export async function removeCustomProvider(input: {
  providerID: string
  credentialIDs: string[]
  api: RemoveCustomProviderApi
}): Promise<RemoveCustomProviderResult> {
  const { providerID } = input

  try {
    await input.api.updateConfig({ providers: { [providerID]: null } })
  } catch (error) {
    return { ok: false, stage: "config", providerID, error }
  }

  try {
    for (const credentialID of input.credentialIDs) {
      await input.api.removeCredential({ credentialID })
    }
  } catch (error) {
    return { ok: false, stage: "credential", providerID, configRemoved: true, error }
  }

  await Promise.resolve(input.api.reload?.(providerID)).catch(() => undefined)

  return { ok: true, providerID }
}
