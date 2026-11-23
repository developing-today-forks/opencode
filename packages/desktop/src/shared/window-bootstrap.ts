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

// SAFETY: argv crosses a process boundary, so the decoded value is untrusted input; the checks in
// this function establish the complete WindowBootstrap shape contract (an object with a string
// `id`) before the cast. Every failure — argument absent, malformed percent-encoding, unparseable
// JSON, wrong shape — resolves to undefined ("ask over IPC") instead of throwing in the preload
// before the bridge exists.
/* oxlint-disable anti-slop/no-runtime-typeof -- see SAFETY above */
export function windowBootstrapFromArguments(args: readonly string[]): WindowBootstrap | undefined {
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)

  if (!value) return undefined

  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value))

    if (typeof parsed !== "object" || parsed === null) return undefined

    if (typeof (parsed as { id?: unknown }).id !== "string") return undefined

    // SAFETY: the two checks above establish that `parsed` is a non-null object with a string
    // `id`, which is the complete required shape of WindowBootstrap; its optional fields are
    // only ever read as their declared types.
    return parsed as WindowBootstrap
  } catch {
    return undefined
  }
}
/* oxlint-enable anti-slop/no-runtime-typeof */
