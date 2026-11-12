#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { build } from "vite"
import { Script } from "@opencode/script"
import { embed } from "@opencode/script/highlights"
import pkg from "../package.json"
import { collectNodeAssets, copyNodeAssets, hashNodeAssets, seaAssetMap } from "./node-assets"
import { appArchiveAsset, mainConfig } from "../vite.node.config"
import { nodeExecArgv, nodeTarget, type NodeTarget } from "../src/node/target"
import { buildAppArchive } from "./app-assets"
import { verifyArtifact } from "./verify-artifact"
import { NativeArch } from "../../../script/native-arch"

const NODE_VERSION = "26.4.0"
/** Deadline for each Node download leg (archive and SHASUMS256.txt). The archive is ~59 MiB:
 * 10 minutes sustains ~100 KiB/s, the slowest link worth waiting on, while a stalled or
 * slow-dripping nodejs.org fails with a TimeoutError instead of hanging the build until the
 * CI job timeout kills it (#1276). The signal stays attached during the body reads, so it
 * bounds headers and body alike. */
const NODE_DOWNLOAD_TIMEOUT_MS = 600_000
const dir = path.resolve(import.meta.dirname, "..")
const outdir = path.resolve(
  dir,
  process.argv.find((arg) => arg.startsWith("--outdir="))?.slice("--outdir=".length) ?? "dist",
)
if (outdir === dir) throw new Error("--outdir must not be the package directory")
if (outdir === path.join(dir, "dist-node")) {
  throw new Error("--outdir must not be dist-node because it contains temporary files")
}
const bundleOnly = process.argv.includes("--bundle-only")
const single = process.argv.includes("--single")
const skipInstall = process.argv.includes("--skip-install")
const appArchiveOnly = process.argv.includes("--app-archive-only")
const highlights = Script.preview ? undefined : embed(process.env.OPENCODE_RELEASE_NOTES)
const requestedArchive = process.argv.find((arg) => arg.startsWith("--app-archive="))?.slice("--app-archive=".length)
const archivePath = requestedArchive ? path.resolve(dir, requestedArchive) : undefined
const requested = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
const allTargets = [
  nodeTarget("linux", "arm64"),
  nodeTarget("linux", "x64"),
  nodeTarget("darwin", "arm64"),
  nodeTarget("win32", "arm64"),
  nodeTarget("win32", "x64"),
]
const targets = requested
  ? allTargets.filter((target) => targetName(target) === requested)
  : single || bundleOnly
    ? [nodeTarget(process.platform, process.arch)]
    : allTargets

process.chdir(dir)
if (!skipInstall) run(process.execPath, ["install", "--os=*", "--cpu=*"])
// The Node bundle is a production artifact. With NODE_ENV=test, which bun test sets for the process that spawns this
// script, Vite stubs the uninstalled optional peer utf-8-validate with a throw, so the bundle fails at startup.
process.env.NODE_ENV = "production"
if (appArchiveOnly) {
  if (!archivePath) throw new Error("--app-archive-only requires --app-archive=<path>")
  await mkdir(path.dirname(archivePath), { recursive: true })
  await writeFile(archivePath, await buildAppArchive(Script.channel))
  process.exit(0)
}
if (targets.length === 0) {
  if (requested === "darwin-x64") throw new Error("Node 26.4 SEA does not support macOS x64")
  throw new Error(`Unknown Node target: ${requested}`)
}
if (!bundleOnly && targets.some((target) => target.platform === "darwin" && target.arch === "x64")) {
  throw new Error("Node 26.4 SEA does not support macOS x64")
}
const appArchive = archivePath ? await Bun.file(archivePath).bytes() : await buildAppArchive(Script.channel)
// Directory removals that can race a just-executed binary on Windows retry
// instead of throwing EBUSY on the first attempt (#100); they stay fatal,
// because the build writes into these directories next.
if (!bundleOnly) await rm(outdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
const builder =
  !bundleOnly || targets.some((target) => target.platform === process.platform && target.arch === process.arch)
    ? await resolveHostNode()
    : undefined

// Vite silently rewrites text imports of known asset types (.txt) to asset
// URL strings when the raw-text plugin doesn't intercept them first — the
// bundle still builds and `--help` still runs, so only content assertions
// catch it. Guards the models.dev snapshot and the prompt/tool description
// text that ships inside the bundle.
async function assertTextImportsInlined(bundlePath: string) {
  const bundle = await readFile(bundlePath, "utf8")
  const markers = [
    { marker: '"zhipuai"', source: "models-dev snapshot" },
    { marker: "/assets/snapshot", source: "models-dev snapshot inlined as asset URL", forbidden: true },
    { marker: '="/assets/', source: "text import inlined as asset URL", forbidden: true },
  ]
  for (const { marker, source, forbidden } of markers) {
    const present = bundle.includes(marker)
    if (forbidden ? present : !present)
      throw new Error(`${bundlePath}: ${source} — text imports are not inlined as content (marker ${marker})`)
  }
}

for (const target of targets) {
  console.log(`building cli-node-${targetName(target)}`)
  const assets = await collectNodeAssets(target)
  await rm("dist-node", { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  const assetHash = await hashNodeAssets(assets)
  const input = {
    version: Script.version,
    channel: Script.channel,
    highlights,
    assetHash,
    target,
  }
  await copyNodeAssets(assets)
  await writeFile(path.join("dist-node", "assets", appArchiveAsset), appArchive)
  await build(mainConfig(input))
  await assertTextImportsInlined("dist-node/opencode.mjs")
  if (bundleOnly) await verifyArtifact("dist-node/opencode.mjs")

  const host = target.platform === process.platform && target.arch === process.arch
  if (host) {
    if (!builder) throw new Error("Node SEA builder is unavailable")
    run(builder, [...nodeExecArgv, "dist-node/opencode.mjs", "--version"])
    run(builder, [...nodeExecArgv, "dist-node/opencode.mjs", "--help"])
    if (target.keyringAsset) {
      const addon = path.join(dir, "dist-node", "assets", target.keyringAsset)
      const source = `const binding = require(${JSON.stringify(addon)}); if (typeof binding.AsyncEntry !== "function") throw new Error("Node keyring addon is missing AsyncEntry")`
      run(builder, [...nodeExecArgv, "-e", source])
    }
  }
  if (bundleOnly) continue

  const name = `cli-node-${targetName(target)}`
  const binary = target.platform === "win32" ? "opencode2-node.exe" : "opencode2-node"
  const output = path.join(outdir, name, "bin", binary)
  if (!builder) throw new Error("Node SEA builder is unavailable")
  await mkdir(path.dirname(output), { recursive: true })
  const config = {
    main: "dist-node/opencode.mjs",
    mainFormat: "module",
    executable: await resolveTargetNode(target, builder),
    output: path.relative(dir, output),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgv: nodeExecArgv,
    execArgvExtension: "none",
    assets: await seaAssetMap(),
  }
  await writeFile("dist-node/sea.json", `${JSON.stringify(config, null, 2)}\n`)
  run(builder, ["--build-sea", "dist-node/sea.json"])
  if (target.platform !== "win32") await chmod(output, 0o755)
  await NativeArch.verify(output, target.arch)
  if (target.platform === "darwin" && process.platform === "darwin") run("codesign", ["--sign", "-", output])
  if (target.platform === "darwin" && process.platform !== "darwin") {
    console.warn(`${output} must be signed on macOS before it can run`)
  }
  await writeFile(
    path.join(outdir, name, "package.json"),
    `${JSON.stringify(
      {
        name: `@opencode/${name}`,
        version: Script.version,
        license: pkg.license,
        repository: { type: "git", url: "git+https://github.com/anomalyco/opencode.git" },
        os: [target.platform],
        cpu: [target.arch],
      },
      null,
      2,
    )}\n`,
  )
  await verifyArtifact(path.join(outdir, name))
  if (host) await smoke(output)
}

async function resolveHostNode() {
  const candidates = [process.env.NODE_BIN, "node"].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    const result = spawnSync(
      candidate,
      ["-p", "JSON.stringify({version:process.versions.node,path:process.execPath})"],
      {
        encoding: "utf8",
      },
    )
    if (result.status !== 0) continue
    const info = JSON.parse(result.stdout) as { version: string; path: string }
    if (info.version === NODE_VERSION) return realpath(info.path)
  }
  return resolveTargetNode(nodeTarget(process.platform, process.arch))
}

async function resolveTargetNode(target: NodeTarget, host?: string) {
  if (host && target.platform === process.platform && target.arch === process.arch) return host
  const cache = path.resolve(dir, ".cache", "node")
  const platform = target.platform === "win32" ? "win" : target.platform
  const archiveName = `node-v${NODE_VERSION}-${platform}-${target.arch}`
  const targetDirectory = path.join(cache, archiveName)
  const executable = path.join(targetDirectory, target.platform === "win32" ? "node.exe" : "bin/node")
  if (
    (await stat(executable).then(
      () => true,
      () => false,
    )) &&
    (await stat(path.join(targetDirectory, ".verified")).then(
      () => true,
      () => false,
    ))
  )
    return realpath(executable)
  await mkdir(cache, { recursive: true })
  const extension = target.platform === "win32" ? "zip" : "tar.gz"
  const filename = `${archiveName}.${extension}`
  const archive = path.join(cache, filename)
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`
  const [response, sums] = await Promise.all([
    fetch(`${base}/${filename}`, { signal: AbortSignal.timeout(NODE_DOWNLOAD_TIMEOUT_MS) }),
    fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(NODE_DOWNLOAD_TIMEOUT_MS) }),
  ])
  if (!response.ok) throw new Error(`Failed to download Node ${NODE_VERSION}: ${response.status}`)
  if (!sums.ok) throw new Error(`Failed to download Node ${NODE_VERSION} checksums: ${sums.status}`)
  const data = new Uint8Array(await response.arrayBuffer())
  const expected = (await sums.text())
    .split("\n")
    .find((line) => line.endsWith(`  ${filename}`))
    ?.split(/\s+/)[0]
  if (!expected) throw new Error(`Missing checksum for ${filename}`)
  if (createHash("sha256").update(data).digest("hex") !== expected) throw new Error(`Checksum mismatch for ${filename}`)
  await writeFile(archive, data)
  const temporary = path.join(cache, `${archiveName}.${process.pid}.tmp`)
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary)
  if (target.platform !== "win32") run("tar", ["-xzf", archive, "-C", temporary])
  if (target.platform === "win32" && process.platform === "win32") {
    run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "-C", temporary])
  }
  if (target.platform === "win32" && process.platform !== "win32") run("unzip", ["-q", archive, "-d", temporary])
  await rm(targetDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  await rename(path.join(temporary, archiveName), targetDirectory)
  await writeFile(path.join(targetDirectory, ".verified"), `${expected}\n`)
  await rm(temporary, { recursive: true, force: true })
  await rm(archive, { force: true })
  return realpath(executable)
}

async function smoke(output: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-node-smoke-"))
  const executable = path.join(root, path.basename(output))
  await copyFile(output, executable)
  if (process.platform !== "win32") await chmod(executable, 0o755)
  run(executable, ["--version"], root)
  run(executable, ["--help"], root)
  // Windows can retain the executable's directory briefly after it exits, so
  // removing it can throw EBUSY even though the smoke test passed (#100).
  // The directory is under os.tmpdir() and the OS reaps leftovers, so a
  // removal that still fails after retries warns instead of failing a build
  // the executable already verified (service-smoke.ts does the same).
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch((error: unknown) => {
    console.warn(
      `Failed to remove Node smoke directory ${root}: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

function targetName(target: NodeTarget) {
  return `${target.platform === "win32" ? "windows" : target.platform}-${target.arch}`
}

function run(command: string, args: readonly string[], cwd = dir) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`)
}
