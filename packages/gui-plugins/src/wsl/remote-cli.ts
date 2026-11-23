// The part of the SSH plugin's remote CLI scripts that WSL uses. Plugins share only contracts, so
// keep the two copies in step.

export function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function requireVersion(version: string) {
  if (version !== "local" && !/^[0-9][a-zA-Z0-9.+-]*$/.test(version)) throw new Error(version)

  return version
}

export function discoverScript() {
  return `cli=""
if [ -z "$cli" ] && [ -x "$HOME/.opencode/bin/opencode" ]; then cli="$HOME/.opencode/bin/opencode"; fi
if [ -n "$cli" ]; then printf '\\nOPENCODE_CLI_DISCOVERY_BEGIN\\n%s\\nOPENCODE_CLI_DISCOVERY_END\\n' "$cli"; fi
`
}

// Adapters supply a quoted shell expression, including remote HOME or wslpath expansion.
export function versionScript(command: string) {
  return `if [ -x ${command} ]; then printf '\\nOPENCODE_CLI_VERSION_BEGIN\\n'; ${command} --version 2>/dev/null || true; printf '\\nOPENCODE_CLI_VERSION_END\\n'; fi\n`
}

export function parseVersion(output: string) {
  // The transport is a login shell (`sh -lc`), so a banner, MOTD or profile echo can precede
  // the script's output, and a banner line can itself end in (or be) a version-shaped token.
  // No ordering rule can tell such a banner line from the CLI's own line when the script prints
  // nothing — the CLI is not staged yet, or --version fails — so versionScript frames its
  // output with markers and only framed lines are candidates. Within the frame, the version
  // line is the last line whose version candidate matches the shape requireVersion accepts
  // (the SSH copy's requireVersion).
  const lines = output.split(/\r?\n/).map((line) => line.trim())
  const begin = lines.lastIndexOf("OPENCODE_CLI_VERSION_BEGIN")
  const end = begin === -1 ? -1 : lines.indexOf("OPENCODE_CLI_VERSION_END", begin + 1)

  if (end === -1) return null

  const versions = lines
    .slice(begin + 1, end)
    .map((line) => {
      const marker = line.lastIndexOf(" v")

      return marker === -1 ? line : line.slice(marker + 2)
    })
    .filter((version) => version === "local" || /^[0-9][a-zA-Z0-9.+-]*$/.test(version))

  return versions.at(-1) ?? null
}

/** The managed CLI installer also configures the user's shell PATH. */
export function installScript(input: { version: string; binary?: string }) {
  const version = requireVersion(input.version)

  return `set -eu
curl -fsSL https://raw.githubusercontent.com/anomalyco/opencode/v2/install | bash -s -- ${input.binary ? `--binary ${input.binary}` : `--version ${quote(version)}`}
test "$("$HOME/.opencode/bin/opencode" --version | awk '{print $NF}' | sed 's/^v//')" = ${quote(version)}
`
}
