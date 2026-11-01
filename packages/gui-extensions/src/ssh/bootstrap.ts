import { Duration, Effect, Option, Schema, Stream } from "effect"
import { HttpClient, type HttpClientResponse } from "effect/http"
import { parseTarget, quote, runSsh, sshArgs, SshFailure } from "./command"
import { RemoteCli } from "./remote-cli"

// Use commands supported by released V2 CLIs. The registration is the service's
// complete private discovery contract; no remote Python/Node runtime is needed.
const registrationScript = `status=$("$cli" service status) || exit 0
if [ "$status" = stopped ]; then exit 0; fi
printf '\\nOPENCODE_SSH_STATUS=%s\\n' "$status"
for file in "\${XDG_STATE_HOME:-$HOME/.local/state}"/opencode/service*.json; do
  if [ ! -f "$file" ]; then continue; fi
  printf 'OPENCODE_SSH_REGISTRATION_BEGIN\\n'
  cat "$file"
  printf '\\nOPENCODE_SSH_REGISTRATION_END\\n'
done
`

export const discoverScript = `set -eu
${RemoteCli.discoverScript({ fromPath: true, cache: { directory: ".opencode/desktop-ssh", prefix: "0.0.0-beta-" } })}
if [ -z "$cli" ]; then exit 0; fi
${registrationScript}`

export function startScript(version: string, replace = false) {
  return `set -eu
cli="${binaryPath(version)}"
"$cli" service ${replace ? "restart" : "start"}
${registrationScript}`
}

const Registration = Schema.fromJsonString(
  Schema.Struct({
    url: Schema.String,
    password: Schema.String,
    version: Schema.String,
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
)

export function parseRegistration(output: string) {
  const status = output
    .split(/\r?\n/)
    .findLast((line) => line.startsWith("OPENCODE_SSH_STATUS="))
    ?.slice("OPENCODE_SSH_STATUS=".length)

  if (!status) return undefined

  for (const match of output.matchAll(
    /OPENCODE_SSH_REGISTRATION_BEGIN\r?\n([\s\S]*?)\r?\nOPENCODE_SSH_REGISTRATION_END/g,
  )) {
    const result = Schema.decodeUnknownOption(Registration)(match[1])

    if (Option.isSome(result) && result.value.url === status) return result.value
  }

  return undefined
}

// Legitimate CLI archives are tens of megabytes, so this generous ceiling
// costs a normal install nothing; it stops a buggy or hostile mirror from
// making the desktop process buffer an archive without limit. The primary
// remote path (remote-cli.ts stageBinary) uses the same size ceiling.
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

// One overall deadline for the whole fallback download (request + body),
// comparable to the primary path's curl --max-time 180 total-transfer bound.
export const ARCHIVE_DOWNLOAD_TIMEOUT = "180 seconds"

/**
 * Bounded archive read for the fallback download. A declared content-length
 * above the cap fails before the body is read; a streamed/chunked body
 * without one is bounded in flight as its chunks arrive, failing with
 * SshFailure("install", ...) instead of buffering past the cap.
 */
export function collectArchive(response: HttpClientResponse.HttpClientResponse) {
  return Effect.gen(function* () {
    const tooLarge = () => new SshFailure("install", `archive exceeds ${MAX_ARCHIVE_BYTES} bytes`)
    const contentLength = response.headers["content-length"]
    const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : undefined

    const declaredSize =
      parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined

    if (declaredSize !== undefined && declaredSize > MAX_ARCHIVE_BYTES) return yield* Effect.fail(tooLarge())
    const chunks: Array<Uint8Array> = []
    let size = 0
    yield* Stream.runForEach(response.stream, (chunk) => {
      if (chunk.byteLength === 0) return Effect.void

      if (size + chunk.byteLength > MAX_ARCHIVE_BYTES) return Effect.fail(tooLarge())
      chunks.push(chunk)
      size += chunk.byteLength

      return Effect.void
    })
    const archive = new Uint8Array(size)
    let offset = 0

    for (const chunk of chunks) {
      archive.set(chunk, offset)
      offset += chunk.byteLength
    }

    return archive
  })
}

/**
 * Fallback archive download under ONE overall deadline: the request phase
 * and the body phase share `timeout`, so a slow response cannot earn the
 * body a second full budget (the previous per-phase timeouts composed to
 * roughly 2x the stated bound). A non-2xx status fails before the body is
 * read: 404 means the requested version was never published.
 */
export function downloadArchive(input: {
  url: string
  version: string
  target: string | undefined
  timeout?: Duration.Input
}) {
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* http.get(input.url)

    if (response.status < 200 || response.status >= 300)
      return yield* Effect.fail(
        new SshFailure(
          response.status === 404 ? "unpublished" : "install",
          JSON.stringify({ version: input.version, target: input.target, url: input.url, status: response.status }),
        ),
      )

    return yield* collectArchive(response)
  }).pipe(Effect.timeout(input.timeout ?? ARCHIVE_DOWNLOAD_TIMEOUT), Effect.mapError(SshFailure.from))
}

export function binaryPath(version: string) {
  return `$HOME/.opencode/desktop-ssh/${RemoteCli.requireVersion(version)}/opencode`
}

function connectionAddress(address: string, password: string) {
  const url = new URL(address)

  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "0.0.0.0", "[::]", "[::1]"].includes(url.hostname))
    throw new SshFailure("service")

  return {
    host: url.hostname === "[::1]" ? "[::1]" : "127.0.0.1",
    port: Number(url.port || 80),
    password,
  }
}

export const bootstrap = Effect.fn("Ssh.bootstrap")(function* (input: {
  target: ReturnType<typeof parseTarget>
  version: string
  development?: boolean
  env: NodeJS.ProcessEnv
  replace?: boolean
  stage: (stage: "checking" | "downloading" | "uploading" | "starting") => Effect.Effect<void>
}) {
  const run = (script: string) =>
    runSsh({
      args: [...sshArgs(input.target), input.target.host, "sh -l -s"],
      env: input.env,
      stdin: script,
    })

  yield* input.stage("checking")
  const registered = parseRegistration(yield* run(discoverScript))

  if (registered && (input.development || registered.version === input.version)) {
    yield* input.stage("starting")

    return yield* Effect.try({
      try: () => connectionAddress(registered.url, registered.password),
      catch: SshFailure.from,
    })
  }

  if (registered && !input.replace) return yield* Effect.fail(new SshFailure("version", registered.version))
  const destination = yield* Effect.try({ try: () => binaryPath(input.version), catch: SshFailure.from })
  const existing = yield* run(RemoteCli.versionScript(`"${destination}"`))
  const staged = RemoteCli.parseVersion(existing) === input.version

  // Source worktree versions are unpublished. Use the installer's beta channel
  // while retaining support for explicitly staged, matching development builds.
  const version =
    input.development && !staged ? yield* RemoteCli.latestBeta().pipe(Effect.mapError(SshFailure.from)) : input.version

  const setup = { version, directory: `.opencode/desktop-ssh/${version}` }

  if (!staged) {
    const output = yield* run(RemoteCli.probeScript).pipe(Effect.mapError(() => new SshFailure("platform")))

    const target = output
      .split(/\r?\n/)
      .findLast((line) => line.startsWith("OPENCODE_REMOTE_TARGET="))
      ?.split("=")[1]

    const url = yield* Effect.try({ try: () => RemoteCli.archiveUrl(target ?? "", version), catch: SshFailure.from })
    yield* input.stage("downloading")
    yield* run(RemoteCli.installScript({ ...setup, source: { type: "download", url } })).pipe(
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          yield* input.stage("uploading")
          const archive = yield* downloadArchive({ url, version, target })

          // The upload uses stdin; the script itself must be the remote command.
          return yield* runSsh({
            args: [
              ...sshArgs(input.target),
              input.target.host,
              `sh -c ${quote(RemoteCli.installScript({ ...setup, source: { type: "archive" } }))}`,
            ],
            env: input.env,
            stdin: archive,
          }).pipe(Effect.mapError(() => new SshFailure("install", error.message)))
        }),
      ),
    )
  }

  yield* input.stage("starting")
  const registration = parseRegistration(yield* run(startScript(version, input.replace)))

  if (!registration) return yield* Effect.fail(new SshFailure("service"))

  if (!input.development && registration.version !== input.version)
    return yield* Effect.fail(new SshFailure("version", registration.version))

  return yield* Effect.try({
    try: () => connectionAddress(registration.url, registration.password),
    catch: SshFailure.from,
  })
})
