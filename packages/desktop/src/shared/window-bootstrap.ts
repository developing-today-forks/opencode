// What the main process already knows when it creates a window, handed to the renderer through the
// preload's argv so the shell can mount before the IPC port exists. Undefined means "ask over IPC".
export type WindowBootstrap = {
  id: string
  firstLaunchPending?: boolean
  /** The app runs packaged (`app.isPackaged`), as extensions' `Build.packaged` reports in both processes. */
  packaged?: boolean
}

const prefix = "--opencode-window="

export function windowBootstrapArgument(bootstrap: WindowBootstrap) {
  return prefix + encodeURIComponent(JSON.stringify(bootstrap))
}

// Every failure — argument absent, malformed percent-encoding, unparseable JSON, wrong shape —
// resolves to undefined ("ask over IPC") instead of throwing in the preload before the bridge
// exists.
export function windowBootstrapFromArguments(args: readonly string[]): WindowBootstrap | undefined {
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)

  if (!value) return undefined

  try {
    return parseWindowBootstrap(JSON.parse(decodeURIComponent(value)))
  } catch {
    return undefined
  }
}

// SAFETY: the value crossed a process boundary (argv or an IPC answer), so it is untrusted
// input; the checks in this function establish the complete WindowBootstrap shape contract (an
// object with a string `id`) before the cast. Every failure resolves to undefined instead of
// throwing.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- see SAFETY above */
export function parseWindowBootstrap(value: unknown): WindowBootstrap | undefined {
  if (typeof value !== "object" || value === null) return undefined

  if (typeof (value as { id?: unknown }).id !== "string") return undefined

  // SAFETY: the two checks above establish that the value is a non-null object with a string
  // `id`, which is the complete required shape of WindowBootstrap; its optional fields are
  // only ever read as their declared types.
  return value as WindowBootstrap
}
/* oxlint-enable anti-slop/no-runtime-typeof */
