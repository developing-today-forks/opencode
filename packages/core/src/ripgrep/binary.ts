import path from "path"
import { createHash } from "node:crypto"
import { Context, Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { which } from "../util/which.js"
import { collectBoundedResponseBody } from "../tool/http-body.js"

export namespace RipgrepBinary {
  const VERSION = "15.1.0"
  // Cap on the downloaded release archive: published ripgrep archives are a few MiB, so 32 MiB leaves
  // generous headroom across platforms and versions while keeping a wrong/oversized body from being
  // buffered whole and handed to the extractor.
  const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
  // sha256 pins are the upstream 15.1.0 release's own per-asset .sha256
  // digests (https://github.com/BurntSushi/ripgrep/releases/tag/15.1.0);
  // a version bump must update them in the same change.
  export const PLATFORM = {
    "arm64-darwin": {
      platform: "aarch64-apple-darwin",
      extension: "tar.gz",
      sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
    },
    "arm64-linux": {
      platform: "aarch64-unknown-linux-gnu",
      extension: "tar.gz",
      sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
    },
    "x64-darwin": {
      platform: "x86_64-apple-darwin",
      extension: "tar.gz",
      sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
    },
    "x64-linux": {
      platform: "x86_64-unknown-linux-musl",
      extension: "tar.gz",
      sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
    },
    "arm64-win32": {
      platform: "aarch64-pc-windows-msvc",
      extension: "zip",
      sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
    },
    "ia32-win32": {
      platform: "i686-pc-windows-msvc",
      extension: "zip",
      sha256: "725be85a1e8f92878a548f40ee4f6df64bc93b809586462b3c6d884e1de1e83a",
    },
    "x64-win32": {
      platform: "x86_64-pc-windows-msvc",
      extension: "zip",
      sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
    },
  } as const

  /** sha256 hex digest of `bytes` (the archive integrity primitive). */
  export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

  /** True when `bytes` hashes to the pinned digest — pure, so the
   * integrity gate is testable without network or an installed rg. */
  export const verifyArchive = (bytes: Uint8Array, expectedSha256: string): boolean =>
    sha256Hex(bytes) === expectedSha256

  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/RipgrepBinary") {}

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const spawner = yield* ChildProcessSpawner
      const global = yield* Global.Service
      const findExecutable = (name: string) => which(name, undefined, global.bin)

      const run = Effect.fnUntraced(function* (command: string, args: string[], cwd: string) {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd, extendEnv: true, stdin: "ignore" }))
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        )
        return { stdout, stderr, code }
      }, Effect.scoped)

      const extract = Effect.fnUntraced(function* (
        archive: string,
        config: (typeof PLATFORM)[keyof typeof PLATFORM],
        target: string,
      ) {
        const dir = yield* fs.makeTempDirectoryScoped({ directory: global.bin, prefix: "ripgrep-" })

        // Windows zips go through the bsdtar in System32 (Windows 10 1803+), not PowerShell, which policy can block.
        // Git's GNU tar can come first on PATH and cannot read zip, so the system copy is called by path. bsdtar
        // decodes its arguments in the ANSI code page, so it runs inside the temp dir and only sees the ASCII
        // archive name: a profile path such as C:\Users\用户 would otherwise reach it as C:\Users\??.
        const result = yield* config.extension === "zip"
          ? run(
              path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
              ["-xf", path.relative(dir, archive)],
              dir,
            )
          : run("tar", ["-xzf", archive, "-C", dir], dir)
        if (result.code !== 0)
          throw new Error(
            result.stderr.trim() || result.stdout.trim() || `ripgrep extraction failed with code ${result.code}`,
          )

        const extracted = path.join(
          dir,
          `ripgrep-${VERSION}-${config.platform}`,
          process.platform === "win32" ? "rg.exe" : "rg",
        )
        if (!(yield* fs.isFile(extracted))) throw new Error(`ripgrep archive did not contain executable: ${extracted}`)

        yield* fs.copyFile(extracted, target)
        if (process.platform !== "win32") yield* fs.chmod(target, 0o755)
      }, Effect.scoped)

      return Service.of({
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            const system = yield* Effect.sync(() => findExecutable(process.platform === "win32" ? "rg.exe" : "rg"))
            if (system && (yield* fs.isFile(system).pipe(Effect.orDie))) return system

            const target = path.join(global.bin, `rg${process.platform === "win32" ? ".exe" : ""}`)
            if (yield* fs.isFile(target).pipe(Effect.orDie)) return target

            const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
            const config = PLATFORM[platformKey]
            if (!config) throw new Error(`unsupported platform for ripgrep: ${platformKey}`)

            const filename = `ripgrep-${VERSION}-${config.platform}.${config.extension}`
            const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${filename}`
            const archive = path.join(global.bin, filename)

            yield* Effect.logInfo("downloading ripgrep", { url })
            yield* fs.ensureDir(global.bin).pipe(Effect.orDie)
            const bytes = yield* HttpClientRequest.get(url).pipe(
              HttpClient.withScope(http).execute,
              Effect.flatMap((response) =>
                collectBoundedResponseBody(
                  response,
                  MAX_ARCHIVE_BYTES,
                  () => new Error(`ripgrep archive too large (exceeds ${MAX_ARCHIVE_BYTES} byte limit): ${url}`),
                ),
              ),
              Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
              // Scoped (withScope above): a declared over-cap rejection aborts the
              // response instead of leaving the download running until GC.
              Effect.scoped,
            )
            if (bytes.byteLength === 0) throw new Error(`failed to download ripgrep from ${url}`)
            // Integrity gate: the archive is extracted and executed, so a
            // substituted or corrupted body must never reach the disk.
            if (!verifyArchive(new Uint8Array(bytes), config.sha256))
              throw new Error(`ripgrep archive integrity check failed (sha256 mismatch): ${url}`)

            yield* fs.writeWithDirs(archive, new Uint8Array(bytes))
            yield* extract(archive, config, target)
            yield* fs.remove(archive, { force: true }).pipe(Effect.ignore)
            return target
          }),
        ),
      })
    }),
  )

  export const node = makeGlobalNode({
    service: Service,
    layer: layer,
    deps: [FSUtil.node, Global.node, httpClient, CrossSpawnSpawner.node],
  })
}
