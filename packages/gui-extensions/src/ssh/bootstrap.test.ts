import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { binaryPath, collectArchive, MAX_ARCHIVE_BYTES, parseRegistration, startScript } from "./bootstrap"
import { RemoteCli } from "./remote-cli"

test("ignores stopped services and registrations that do not match the healthy endpoint", () => {
  const registration = { url: "http://127.0.0.1:1234", password: "secret", version: "2.0.0", pid: 42 }
  const frame = `OPENCODE_SSH_REGISTRATION_BEGIN\n${JSON.stringify(registration)}\nOPENCODE_SSH_REGISTRATION_END\n`
  expect(parseRegistration(`OPENCODE_SSH_STATUS=stopped\n${frame}`)).toBeUndefined()
  expect(parseRegistration(`OPENCODE_SSH_STATUS=http://127.0.0.1:9999\n${frame}`)).toBeUndefined()
  expect(
    parseRegistration(
      `OPENCODE_SSH_STATUS=${registration.url}\nOPENCODE_SSH_REGISTRATION_BEGIN\ninvalid\nOPENCODE_SSH_REGISTRATION_END\n`,
    ),
  ).toBeUndefined()
})

// Runs the real startScript through `sh` against a fake staged CLI whose
// `service start` prints `startPrint` (a shell printf format string, so a test
// controls the trailing newline) and whose registration file matches its
// `service status` URL. The registrationScript startScript ends with is the
// same one discoverScript runs, so this covers both status reads.
function runStartScript(startPrint: string) {
  const home = mkdtempSync(path.join(tmpdir(), "ssh-bootstrap-"))

  try {
    const directory = path.join(home, ".opencode/desktop-ssh/2.0.0")

    mkdirSync(directory, { recursive: true })

    const cli = path.join(directory, "opencode")

    writeFileSync(
      cli,
      `#!/bin/sh\nif [ "$2" = start ]; then printf '${startPrint}'; fi\nif [ "$2" = status ]; then printf 'http://127.0.0.1:1234\\n'; fi\n`,
    )
    chmodSync(cli, 0o755)

    const state = path.join(home, ".local/state/opencode")

    mkdirSync(state, { recursive: true })
    writeFileSync(
      path.join(state, "service.json"),
      JSON.stringify({ url: "http://127.0.0.1:1234", password: "secret", version: "2.0.0", pid: 42 }),
    )

    const result = spawnSync("sh", ["-s"], {
      input: startScript("2.0.0"),
      encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, ".local/state") },
    })

    if (result.status !== 0) throw new Error(`startScript exited ${result.status}: ${result.stderr}`)

    return result.stdout
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test("startScript prints the registration status with a leading newline", () => {
  expect(startScript("2.0.0")).toContain(`printf '\\nOPENCODE_SSH_STATUS=%s\\n' "$status"`)
})

test.skipIf(process.platform === "win32")(
  "reads the registration when `service start` output has no trailing newline, through the real startScript",
  () => {
    const registration = { url: "http://127.0.0.1:1234", password: "secret", version: "2.0.0", pid: 42 }

    expect(parseRegistration(runStartScript("starting service"))).toEqual(registration)
    expect(parseRegistration(runStartScript("starting service\\n"))).toEqual(registration)
    expect(parseRegistration(runStartScript(""))).toEqual(registration)
  },
)

function archiveResponse(body: ReadableStream<Uint8Array> | string, headers?: Record<string, string>) {
  return HttpClientResponse.fromWeb(
    HttpClientRequest.get("https://example.test/archive.tgz"),
    new Response(body, { headers }),
  )
}

function streamOf(...chunks: Array<Uint8Array>) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

test("collectArchive returns a body under the cap", async () => {
  const archive = await Effect.runPromise(collectArchive(archiveResponse(streamOf(new Uint8Array([97, 98, 99])))))
  expect(Array.from(archive)).toEqual([97, 98, 99])
})

test("collectArchive rejects a declared content-length above the cap before reading the body", async () => {
  const response = archiveResponse(streamOf(new Uint8Array([97])), {
    "content-length": String(MAX_ARCHIVE_BYTES + 1),
  })

  await expect(Effect.runPromise(collectArchive(response))).rejects.toThrow(
    `archive exceeds ${MAX_ARCHIVE_BYTES} bytes`,
  )
})

test("collectArchive bounds a streamed body in flight when no content-length is declared", async () => {
  // One shared chunk enqueued repeatedly: the logical body exceeds the cap
  // without allocating a second copy of it.
  const chunk = new Uint8Array(8 * 1024 * 1024)
  const repeats = MAX_ARCHIVE_BYTES / chunk.byteLength + 1
  const response = archiveResponse(streamOf(...Array.from({ length: repeats }, () => chunk)))
  await expect(Effect.runPromise(collectArchive(response))).rejects.toThrow(
    `archive exceeds ${MAX_ARCHIVE_BYTES} bytes`,
  )
})

test("rejects unsafe versions and platforms in remote installation paths", () => {
  expect(() => binaryPath('2.0.0"; whoami')).toThrow()
  expect(RemoteCli.archiveUrl("linux-x64-baseline-musl", "2.0.0-beta.1")).toBe(
    "https://registry.npmjs.org/@opencode/cli-linux-x64-baseline-musl/-/cli-linux-x64-baseline-musl-2.0.0-beta.1.tgz",
  )
  expect(() => RemoteCli.installScript({ version: '2.0.0"; whoami', source: { type: "installer" } })).toThrow()
  expect(() => RemoteCli.archiveUrl("linux-x64;whoami", "2.0.0")).toThrow()
})
