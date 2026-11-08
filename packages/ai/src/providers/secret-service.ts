/** Read a Secret Service entry in process, without invoking a desktop helper. */
export const lookupSecretService = async (service: string, username: string): Promise<string | undefined> => {
  if (process.platform !== "linux") return undefined

  try {
    const { AsyncEntry } = await import("@napi-rs/keyring")
    const entry = new AsyncEntry(service, username, { linux: { store: "secret-service" } })
    const value = await entry.getPassword(AbortSignal.timeout(15_000))
    return value || undefined
  } catch {
    return undefined
  }
}
