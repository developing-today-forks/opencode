import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { MainContext } from "../sdk/main"
import { createWslRuntime } from "./runtime"
import { spawnWslSidecar } from "./sidecar"

// The sidecar starts `wsl` by name, so these tests put a stand-in named `wsl` first on PATH. The stand-in is a POSIX
// shell script, so the tests run only where that works. The real wsl.exe is never started.
const posix = process.platform !== "win32"

const t: MainContext["t"] = (key, params) => `${key} ${JSON.stringify(params)}`

// Runs `run` with PATH set to a directory holding only the stand-in `wsl` (when `script` is given).
async function withWslOnPath(script: string | undefined, run: () => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "wsl-sidecar-"))
  const original = process.env.PATH

  try {
    if (script !== undefined) {
      await writeFile(path.join(dir, "wsl"), script)
      await chmod(path.join(dir, "wsl"), 0o755)
    }

    process.env.PATH = dir
    await run()
  } finally {
    if (original === undefined) delete process.env.PATH
    else process.env.PATH = original
    await rm(dir, { recursive: true, force: true })
  }
}

function startSidecar() {
  const runtime = createWslRuntime(t)

  return spawnWslSidecar("Debian", {
    // Resolving the CLI would itself run wsl; these tests start from a known CLI path.
    runtime: { ...runtime, resolveCli: async () => "/usr/local/bin/opencode" },
    t,
    packaged: false,
    signal: new AbortController().signal,
    healthTimeoutMs: 5_000,
  })
}

test.skipIf(!posix)(
  "a wsl that exits before reading its script rejects with its exit status and no unhandled stdin error",
  async () => {
    await withWslOnPath("#!/bin/sh\nexit 3\n", async () => {
      await expect(startSidecar()).rejects.toThrow('"code":3')
      // An unhandled stream error surfaces on a later tick, so stay in the test until it could have.
      await Bun.sleep(100)
    })
  },
)

test.skipIf(!posix)("a wsl that cannot be started still rejects startup with its spawn error", async () => {
  await withWslOnPath(undefined, async () => {
    await expect(startSidecar()).rejects.toMatchObject({ code: "ENOENT" })
  })
})
