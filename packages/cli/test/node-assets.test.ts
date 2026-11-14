import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { collectNodeAssets } from "../script/node-assets"
import { nodeTarget, shellParserWasmAssets } from "../src/node/target"

test("collects each SEA asset key once", async () => {
  const assets = await collectNodeAssets(nodeTarget(process.platform, process.arch))
  const keys = assets.map((asset) => asset.key)

  expect(new Set(keys).size).toBe(keys.length)
  if (process.platform !== "win32") expect(keys.filter((key) => key === "opencode-pty/opencode-pty")).toHaveLength(1)
  expect(assets.filter((asset) => asset.key === shellParserWasmAssets.runtime)).toEqual([
    {
      key: shellParserWasmAssets.runtime,
      source: fileURLToPath(import.meta.resolve(shellParserWasmAssets.runtime)),
    },
  ])
})

test("every Node target resolves its platform keyring addon asset", () => {
  // #2413: the keyring adapter must not be Linux-only — each target
  // names the @napi-rs/keyring platform package and the .node asset
  // the SEA build stages and the banner points OPENCODE_NODE_KEYRING_PATH at.
  const expected: Record<string, { asset: string; pkg: string }> = {
    "darwin-arm64": { asset: "keyring/keyring.darwin-arm64.node", pkg: "@napi-rs/keyring-darwin-arm64" },
    "darwin-x64": { asset: "keyring/keyring.darwin-x64.node", pkg: "@napi-rs/keyring-darwin-x64" },
    "linux-arm64": { asset: "keyring/keyring.linux-arm64-gnu.node", pkg: "@napi-rs/keyring-linux-arm64-gnu" },
    "linux-x64": { asset: "keyring/keyring.linux-x64-gnu.node", pkg: "@napi-rs/keyring-linux-x64-gnu" },
    "win32-arm64": { asset: "keyring/keyring.win32-arm64-msvc.node", pkg: "@napi-rs/keyring-win32-arm64-msvc" },
    "win32-x64": { asset: "keyring/keyring.win32-x64-msvc.node", pkg: "@napi-rs/keyring-win32-x64-msvc" },
  }
  for (const platform of ["darwin", "linux", "win32"] as const) {
    for (const arch of ["arm64", "x64"] as const) {
      const target = nodeTarget(platform, arch)
      const want = expected[`${platform}-${arch}`]
      expect(target.keyringAsset).toBe(want.asset)
      expect(target.keyringPackage).toBe(want.pkg)
    }
  }
})

test("collects the host target's keyring addon asset", async () => {
  const target = nodeTarget(process.platform, process.arch)
  const assets = await collectNodeAssets(target)
  const keyring = assets.filter((asset) => asset.key === target.keyringAsset)
  expect(keyring).toHaveLength(1)
  expect(keyring[0]?.source).toContain("keyring")
})
