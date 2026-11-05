#!/usr/bin/env bun

import { $ } from "bun"
import { mkdir, rm } from "fs/promises"
import path from "path"
import { Script } from "@opencode/script"
import { embed } from "@opencode/script/highlights"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { BunPlugin } from "bun"
import pkg from "../package.json"
import { discoverPluginRuntimeSpecifiers, pluginRuntimeLoaderCode } from "@opencode/plugin/runtime-modules"
import { buildAppArchive } from "./app-assets"
import { verifyArtifact, verifySimulationGraph } from "./verify-artifact"
import { resolveOpencodePty } from "./opencode-pty"
import { BUN_DOWNLOAD_TIMEOUT_MS, verifyAndExtractBunArchive } from "./bun-archive"
import { NativeArch } from "../../../script/native-arch"

const dir = path.resolve(import.meta.dirname, "..")
const binary = "opencode"
const outdir = path.resolve(
  dir,
  process.argv.find((arg) => arg.startsWith("--outdir="))?.slice("--outdir=".length) ?? "dist",
)
if (outdir === dir) throw new Error("--outdir must not be the package directory")
process.chdir(dir)

await rm(outdir, { recursive: true, force: true })

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const requestedTarget = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
const skipInstall = process.argv.includes("--skip-install")
const skipWebUi = process.argv.includes("--skip-web-ui")
const solidPlugin = createSolidTransformPlugin()
const highlights = Script.preview ? undefined : embed(process.env.OPENCODE_RELEASE_NOTES)
const releaseAssets = new Map<string, Promise<Map<string, string>>>()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

const targets =
  requestedTarget !== undefined
    ? allTargets.filter((item) => targetName(item) === requestedTarget)
    : singleFlag
      ? allTargets.filter((item) => {
          if (item.os !== process.platform || item.arch !== process.arch) return false
          if (item.avx2 === false) return baselineFlag
          return item.abi === undefined
        })
      : allTargets
if (!targets.length) throw new Error(`Unknown build target: ${requestedTarget}`)

if (!skipInstall)
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]} @opencode-ai/pty@${pkg.dependencies["@opencode-ai/pty"]}`
const appArchive = path.join(dir, ".cache", "bun-app-archive.bin")
await Bun.write(appArchive, await buildAppArchive(Script.channel, { skipBuild: skipWebUi }))
const appAssetsPlugin: BunPlugin = {
  name: "opencode-app-assets",
  setup(build) {
    build.onResolve({ filter: /^virtual:opencode-app-assets$/ }, () => ({
      path: "opencode-app-assets",
      namespace: "opencode",
    }))
    build.onLoad({ filter: /^opencode-app-assets$/, namespace: "opencode" }, () => ({
      loader: "js",
      // Embedded as a file, not a string: its bytes go into the executable once and unencoded.
      contents: `import { readFileSync } from "node:fs"
import archive from ${JSON.stringify(appArchive.replaceAll("\\", "/"))} with { type: "file" }
export default () => readFileSync(archive)`,
    }))
  },
}
const pluginRuntimeEntries = discoverPluginRuntimeSpecifiers()
const pluginRuntimeModulesSource = [
  "export const resolveHostPackageRoots = () => []",
  "const modules = {",
  ...[...pluginRuntimeEntries.keys()].map(
    (specifier) => `  ${JSON.stringify(specifier)}: ${pluginRuntimeLoaderCode(specifier, pluginRuntimeEntries)},`,
  ),
  "}",
  "export const loadRuntimeModules = () => modules",
].join("\n")
const pluginRuntimePlugin: BunPlugin = {
  name: "opencode-plugin-runtime",
  setup(build) {
    build.onLoad({ filter: /plugin[/\\]src[/\\]runtime-modules\.ts$/ }, () => ({
      contents: pluginRuntimeModulesSource,
      loader: "ts",
    }))
    build.onLoad({ filter: /[/\\]internal[/\\]httpApi(?:Scalar|Swagger)\.js$/ }, () => ({
      contents:
        'export const css = ""; export const javascript = \'document.body.textContent = "Scalar/Swagger UI assets are not bundled in OpenCode"\'',
      loader: "js",
    }))
  },
}

for (const item of targets) {
  const opencodePty = await resolveOpencodePty({
    platform: item.os,
    arch: item.arch,
    ...(item.os === "linux" ? { libc: item.abi ?? "glibc" } : {}),
  })
  const opencodePtyPlugin: BunPlugin = {
    name: "opencode-pty-binary",
    setup(build) {
      build.onLoad({ filter: /persistent-pty[/\\]pty-binding\.ts$/ }, () => ({
        loader: "js",
        contents: opencodePty
          ? `import file from ${JSON.stringify(opencodePty.source)} with { type: "file" }
export default { path: file, version: ${JSON.stringify(opencodePty.version)}, sha256: ${JSON.stringify(opencodePty.sha256)} }`
          : "export default undefined",
      }))
    },
  }
  const simulationInputs = new Set<string>()
  const simulationGraphPlugin: BunPlugin = {
    name: "opencode-simulation-graph",
    setup(build) {
      build.onLoad(
        { filter: /packages[/\\]simulation[/\\]src[/\\](frontend[/\\](simulation|server)|control-server)\.ts$/ },
        (args) => void simulationInputs.add(args.path),
      )
    },
  }
  // sharp is statically imported by @huggingface/transformers but only
  // CALLED for image inputs; its native binding cannot be located from
  // inside a compiled binary (it resolves its .node relative to its
  // package on disk), so loading the real package makes even TEXT
  // embeddings fail in the packaged binary (#1727). Rewrite the one
  // static import in transformers' dist bundle to a throwing stub, the
  // same shape the Node bundle uses (vite.node.config.ts, #1615): text
  // embeddings never reach it, and an image input throws this message
  // instead of sharp's misleading install advice. A resolve-level stub
  // is NOT equivalent here: it reshapes the split-chunk graph and
  // breaks transformers' runtime requireFromHere("onnxruntime-node")
  // (verified while fixing #1727). onnxruntime-node itself is NOT
  // stubbed — it is the native-onnx backend; its shared library is
  // shipped by the packaging (nix/opencode.nix) instead.
  const sharpStubPlugin: BunPlugin = {
    name: "sharp-stub",
    setup(build) {
      build.onLoad({ filter: /@huggingface[/\\]transformers[/\\]dist[/\\]transformers\.node\.mjs$/ }, async (args) => {
        const source = await Bun.file(args.path).text()
        const stub =
          'const sharp = () => { throw new Error("sharp is unavailable in the compiled OpenCode binary; image inputs are unsupported there — text embeddings do not use sharp (#1727)") };'
        // The dist bundle also loads onnxruntime-node through a runtime
        // createRequire (requireFromHere), which cannot resolve the
        // package from inside $bunfs and throws at module init. A plain
        // static require is visible to the bundler and resolves to the
        // same package embeddings-native imports. (The Node bundle
        // rewrites this same call to a stub; the Bun build needs the
        // real backend.)
        const transformed = source
          .replace('import sharp from "sharp";', stub)
          .replace('requireFromHere("onnxruntime-node")', 'require("onnxruntime-node")')
        if (transformed === source || transformed.includes('requireFromHere("onnxruntime-node")'))
          throw new Error("Failed to rewrite the transformers sharp/onnxruntime-node loaders")
        return { contents: transformed, loader: "js" }
      })
    },
  }
  const parcelWatcherPackage = `@parcel/watcher-${item.os}-${item.arch}${item.os === "linux" ? `-${item.abi ?? "glibc"}` : ""}`
  const parcelWatcherPlugin: BunPlugin = {
    name: "parcel-watcher-binding",
    setup(build) {
      build.onLoad({ filter: /filesystem[/\\]watcher-binding\.ts$/ }, () => ({
        contents: `export default () => require(${JSON.stringify(parcelWatcherPackage)})`,
        loader: "js",
      }))
    },
  }
  const target = targetName(item)
  const name = target.replace(binary, "cli")
  const executablePath = await compileExecutable(item)
  console.log(`building ${name}`)
  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    tsconfig: "./tsconfig.json",
    plugins: [
      appAssetsPlugin,
      solidPlugin,
      sharpStubPlugin,
      parcelWatcherPlugin,
      opencodePtyPlugin,
      pluginRuntimePlugin,
      simulationGraphPlugin,
    ],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    bytecode: true,
    sourcemap: Script.channel === "dev" || Script.channel === "local" ? "inline" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: target.replace(binary, "bun") as Bun.Build.CompileTarget,
      ...(executablePath ? { executablePath } : {}),
      outfile: path.join(outdir, name, "bin", binary),
      execArgv: [
        "--smol",
        `--user-agent=opencode/${Script.channel}/${Script.version}/cli`,
        "--use-system-ca",
        "--no-warnings",
        "--",
      ],
      windows: {},
    },
    define: {
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_CLI_NAME: "'opencode'",
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_ARTIFACT: `'cli'`,
      ...(highlights ? { OPENCODE_RELEASE_HIGHLIGHTS: JSON.stringify(highlights) } : {}),
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "undefined",
      // FFF_LIBC selects the fff native lib variant: "musl" or "gnu".
      FFF_LIBC: item.os === "linux" ? `'${item.abi ?? "gnu"}'` : "undefined",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  verifySimulationGraph(simulationInputs)
  await NativeArch.verify(path.join(outdir, name, "bin", item.os === "win32" ? `${binary}.exe` : binary), item.arch)

  await Bun.write(
    path.join(outdir, name, "package.json"),
    JSON.stringify(
      {
        name: `@opencode/${name}`,
        version: Script.version,
        license: "MIT",
        repository: { type: "git", url: "git+https://github.com/anomalyco/opencode.git" },
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
  await verifyArtifact(path.join(outdir, name))
}

async function compileExecutable(item: (typeof allTargets)[number]) {
  const release = process.env.BUN_COMPILE_RELEASE
  if (!release) return

  const platform = item.os === "win32" ? "windows" : item.os
  const name = [
    "bun",
    platform,
    item.arch === "arm64" ? "aarch64" : item.arch,
    item.abi,
    item.avx2 === false ? "baseline" : undefined,
  ]
    .filter(Boolean)
    .join("-")
  const cache = path.join(outdir, ".bun", release)
  const executable = path.join(cache, name, item.os === "win32" ? "bun.exe" : "bun")
  const verified = path.join(cache, name, ".verified")
  if ((await Bun.file(executable).exists()) && (await Bun.file(verified).exists())) return executable

  await mkdir(cache, { recursive: true })
  const archive = path.join(cache, `${name}.zip`)
  const assets = await compileReleaseAssets(release)
  const url = assets.get(`${name}.zip`)
  if (!url) throw new Error(`Bun release ${release} does not include ${name}.zip`)
  const checksumsUrl = assets.get("SHASUMS256.txt")
  if (!checksumsUrl) throw new Error(`Bun release ${release} does not include SHASUMS256.txt`)
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const headers = { Accept: "application/octet-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  const [checksumsResponse, response] = await Promise.all([
    fetch(checksumsUrl, { headers, signal: AbortSignal.timeout(BUN_DOWNLOAD_TIMEOUT_MS) }),
    fetch(url, { headers, signal: AbortSignal.timeout(BUN_DOWNLOAD_TIMEOUT_MS) }),
  ])
  if (!checksumsResponse.ok)
    throw new Error(`Failed to download Bun release checksums ${release}: ${checksumsResponse.status}`)
  if (!response.ok) throw new Error(`Failed to download ${name} from Bun release ${release}: ${response.status}`)
  const [data, checksums] = await Promise.all([response.arrayBuffer(), checksumsResponse.text()])
  const expected = await verifyAndExtractBunArchive(new Uint8Array(data), checksums, `${name}.zip`, async () => {
    await Bun.write(archive, data)
    await $`unzip -oq ${archive} -d ${cache}`
  })
  await rm(archive)
  await Bun.write(verified, `${expected}\n`)
  return executable
}

function compileReleaseAssets(release: string) {
  const existing = releaseAssets.get(release)
  if (existing) return existing
  const pending = fetch(`https://api.github.com/repos/oven-sh/bun/releases/tags/${release}?cache=${Date.now()}`, {
    signal: AbortSignal.timeout(BUN_DOWNLOAD_TIMEOUT_MS),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Failed to resolve Bun release ${release}: ${response.status}`)
      const data: unknown = await response.json()
      if (typeof data !== "object" || data === null || !("assets" in data) || !Array.isArray(data.assets)) {
        throw new Error(`Bun release ${release} returned invalid metadata`)
      }
      return new Map(
        data.assets
          .filter(
            (asset): asset is { name: string; url: string } =>
              typeof asset === "object" &&
              asset !== null &&
              "name" in asset &&
              typeof asset.name === "string" &&
              "url" in asset &&
              typeof asset.url === "string",
          )
          .map((asset) => [asset.name, asset.url]),
      )
    })
    .catch((error) => {
      releaseAssets.delete(release)
      throw error
    })
  releaseAssets.set(release, pending)
  return pending
}

function targetName(item: (typeof allTargets)[number]) {
  return [
    binary,
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi,
  ]
    .filter(Boolean)
    .join("-")
}
