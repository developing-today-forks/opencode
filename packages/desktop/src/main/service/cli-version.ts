export function parseCliVersion(output: string) {
  // The bundled binary is spawned directly (no login shell), so its own version line is the
  // first version-shaped line; later lines are diagnostics whose ` v...` tokens are not versions.
  // A candidate counts only when it has the shape the remote CLI parsers accept (`local` or
  // starting with a digit), so unparseable output is rejected instead of cached as a version.
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()

    if (!line) continue
    const marker = line.lastIndexOf(" v")
    const version = marker === -1 ? line : line.slice(marker + 2)

    if (version === "local" || /^[0-9][a-zA-Z0-9.+-]*$/.test(version)) return version
  }

  throw new Error("V2 CLI did not provide a version")
}

export function serviceVersion(input: {
  readonly channel: "local" | "dev" | "beta" | "prod"
  readonly isolated?: boolean
  readonly mode: "initial" | "reconnect"
  readonly version: string
}) {
  if (input.mode === "reconnect") return undefined

  if (input.channel === "beta" && !input.isolated) return undefined

  return input.version
}

// Retrying on timeout can also replace a server stuck in a migration longer than 120 s, which is accepted.
export function shouldRetryEnsure(version: string | undefined, message: string) {
  if (version !== undefined) return false

  return (
    message === "Background service failed to start" ||
    message === "Timed out waiting for the background service to start"
  )
}

export function stageName(version: string, arch = process.arch) {
  return `${version}-${arch}`.replace(/[^a-zA-Z0-9._-]/g, "-")
}

export function keptStages(bundledVersion: string, runningVersion?: string, arch = process.arch) {
  const stages = [stageName(bundledVersion, arch)]

  if (runningVersion && runningVersion !== bundledVersion) stages.push(stageName(runningVersion, arch))

  return stages
}
