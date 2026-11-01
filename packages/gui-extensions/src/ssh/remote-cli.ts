export * as RemoteCli from "./remote-cli"

import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

export class Failure extends Schema.TaggedError<Failure>()("RemoteCliFailure", {
  code: Schema.Literals(["platform", "version", "install"]),
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function requireVersion(version: string) {
  if (version !== "local" && !/^[0-9][a-zA-Z0-9.+-]*$/.test(version))
    throw new Failure({ code: "version", detail: version })

  return version
}

export function discoverScript(options: { fromPath?: boolean; cache?: { directory: string; prefix: string } } = {}) {
  return `cli=${options.fromPath ? "$(command -v opencode || true)" : '""'}
if [ -z "$cli" ] && [ -x "$HOME/.opencode/bin/opencode" ]; then cli="$HOME/.opencode/bin/opencode"; fi
${
  options.cache
    ? `if [ -z "$cli" ]; then
  for binary in "$HOME"/${quote(options.cache.directory)}/${quote(options.cache.prefix)}*/opencode; do
    if [ -x "$binary" ]; then cli="$binary"; fi
  done
fi
`
    : ""
}if [ -n "$cli" ]; then printf '\\n%s\\n' "$cli"; fi
`
}

// Adapters supply a quoted shell expression, including remote HOME or wslpath expansion.
export function versionScript(command: string) {
  return `if [ -x ${command} ]; then printf '\\nOPENCODE_CLI_VERSION_BEGIN\\n'; ${command} --version 2>/dev/null || true; printf '\\nOPENCODE_CLI_VERSION_END\\n'; fi\n`
}

export function parseVersion(output: string) {
  // The transport is a login shell (`sh -l -s`), so a banner, MOTD or profile echo can precede
  // the script's output, and a banner line can itself end in (or be) a version-shaped token.
  // No ordering rule can tell such a banner line from the CLI's own line when the script prints
  // nothing — the routine first-connect case (nothing staged yet) and the cannot-run case
  // (--version fails) — so versionScript frames its output with markers, like the
  // OPENCODE_SSH_REGISTRATION_BEGIN/END frame, and only framed lines are candidates. Within
  // the frame, the version line is the last line whose version candidate matches the shape
  // requireVersion accepts.
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

export const probeScript = `set -eu
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os" in linux|darwin) ;; *) exit 2 ;; esac
case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) exit 2 ;; esac
target="$os-$arch"
if [ "$arch" = x64 ]; then target="$target-baseline"; fi
if [ "$os" = linux ]; then
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then target="$target-musl"; fi
fi
printf '\\nOPENCODE_REMOTE_TARGET=%s\\n' "$target"
`

export function archiveUrl(target: string, version: string) {
  if (!/^(linux|darwin)-(x64-baseline|arm64)(-musl)?$/.test(target))
    throw new Failure({ code: "platform", detail: target })

  return `https://registry.npmjs.org/@opencode/cli-${target}/-/cli-${target}-${requireVersion(version)}.tgz`
}

type Source = { type: "download"; url: string } | { type: "archive" } | { type: "installer"; binary?: string }

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

export function installScript(input: { version: string; directory?: string; source: Source }) {
  const version = requireVersion(input.version)

  // The managed CLI installer also configures the user's shell PATH. Private
  // installations use archives so their destination and shell setup stay isolated.
  if (input.source.type === "installer")
    return `set -eu
curl -fsSL https://raw.githubusercontent.com/anomalyco/opencode/v2/install | bash -s -- ${input.source.binary ? `--binary ${input.source.binary}` : `--version ${quote(version)}`}
${verifyScript('"$HOME/.opencode/bin/opencode"', version)}
`

  return `set -eu
umask 077
destination="$HOME"/${quote(`${input.directory ?? ".opencode/bin"}/opencode`)}
mkdir -p "$(dirname "$destination")"
stage=$(mktemp -d "$(dirname "$destination")/.install-XXXXXX")
trap 'rm -rf "$stage"' EXIT
${stageBinary(input.source)}
chmod 755 "$stage/package/bin/opencode"
${verifyScript('"$stage/package/bin/opencode"', version)}
mv "$stage/package/bin/opencode" "$destination"
`
}

function stageBinary(source: Exclude<Source, { type: "installer" }>) {
  if (source.type === "archive") return 'cat > "$stage/archive.tgz"\ntar -xzf "$stage/archive.tgz" -C "$stage"'

  return `url=${quote(source.url)}
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --connect-timeout 15 --max-time 180 --max-filesize ${MAX_ARCHIVE_BYTES} "$url" -o "$stage/archive.tgz"
else
  wget -T 180 -O "$stage/archive.tgz" "$url"
fi
# Neither downloader bounds the staged file on every version: curl's
# --max-filesize is ignored when the response size is unknown (curl < 8.4) and
# wget has no portable maximum-file-size option, so check the completed file
# before extraction on both branches.
archive_size=$(wc -c < "$stage/archive.tgz" | tr -d '[:space:]')
if [ "$archive_size" -gt ${MAX_ARCHIVE_BYTES} ]; then
  printf 'archive exceeds ${MAX_ARCHIVE_BYTES} bytes\\n' >&2
  exit 1
fi
tar -xzf "$stage/archive.tgz" -C "$stage"`
}

function verifyScript(command: string, version: string) {
  return `test "$(${command} --version | awk '{print $NF}' | sed 's/^v//')" = ${quote(version)}`
}

const Beta = Schema.Struct({ version: Schema.String.check(Schema.isPattern(/^0\.0\.0-beta-\d+(?:\.\d+)?$/)) })

export const latestBeta = Effect.fn("RemoteCli.latestBeta")(function* () {
  const http = yield* HttpClient.HttpClient

  const metadata = yield* http.get("https://registry.npmjs.org/@opencode%2fcli/beta").pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Beta)),
    Effect.timeout("30 seconds"),
    Effect.mapError(() => new Failure({ code: "install", detail: "https://registry.npmjs.org/@opencode%2fcli/beta" })),
  )

  return metadata.version
})
