/** Read a Secret Service entry in process, without invoking a desktop helper. */
export const lookupSecretService = async (service: string, username: string): Promise<string | undefined> => {
  if (process.platform !== "linux") return undefined

  // The binding discovers the session bus from DBUS_SESSION_BUS_ADDRESS,
  // falling back to $XDG_RUNTIME_DIR/bus (verified by probe: with XDG set
  // the read succeeds unaided). A process launched with neither (cron, a
  // non-user systemd unit, a detached or ssh spawn) finds no bus, and the
  // read below fails silently to undefined. The secret-tool readers this
  // helper replaced synthesized the canonical per-user address for exactly
  // that launch shape (#2313); restore it here. An address already present
  // — even a bogus one — is never overridden.
  if (!process.env.DBUS_SESSION_BUS_ADDRESS && typeof process.getuid === "function") {
    const address = `unix:path=/run/user/${process.getuid()}/bus`
    process.env.DBUS_SESSION_BUS_ADDRESS = address
    // Under Bun, process.env is a JS-level copy: native addons read the
    // libc environment, which the assignment above never reaches (verified
    // by probe — libc getenv stays unset and the binding still fails).
    // Write the libc environment too where Bun provides the FFI for it;
    // under Node/Electron the assignment already propagates, so this is
    // skipped there.
    if ((globalThis as { Bun?: unknown }).Bun !== undefined) {
      try {
        const { dlopen, FFIType } = await import("bun:ffi")
        const libc = dlopen("libc.so.6", {
          setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.int], returns: FFIType.int },
        })
        libc.symbols.setenv("DBUS_SESSION_BUS_ADDRESS", address, 0)
      } catch {
        // No FFI route to the libc environment: keep the JS-level value.
      }
    }
  }

  try {
    const { AsyncEntry } = await import("@napi-rs/keyring")
    const entry = new AsyncEntry(service, username, { linux: { store: "secret-service" } })
    const value = await entry.getPassword(AbortSignal.timeout(15_000))
    return value || undefined
  } catch {
    return undefined
  }
}
