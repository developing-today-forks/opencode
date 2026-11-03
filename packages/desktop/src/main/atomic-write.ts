import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const transientRenameCodes = new Set(["EPERM", "EACCES", "EBUSY"])

const renameRetryDelays = [10, 25, 50, 100]

const renameWait = new Int32Array(new SharedArrayBuffer(4))

// Sync writers follow the atomic-replace contract in design #1345.
export function renameSyncWithRetry(source: string, destination: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, destination)

      return
    } catch (error) {
      const delay = renameRetryDelays[attempt]

      // SAFETY: a failed fs rename throws a NodeJS.ErrnoException whose code names the failure;
      // a thrown value without one is not a rename failure and is rethrown as non-transient below.
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined

      if (delay === undefined || code === undefined || !transientRenameCodes.has(code)) throw error
      Atomics.wait(renameWait, 0, 0, delay)
    }
  }
}

// Writes content to a temp file beside the destination, then renames it
// over the destination. On failure the temp file is removed and the
// original error propagates.
export function writeFileSyncAtomic(file: string, content: string) {
  const absolute = path.resolve(file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const target = resolveAtomicTarget(absolute)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const mode = fileMode(target)
  const temporary = path.join(path.dirname(target), `.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`)
  let created = false

  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600)
    created = true
    try {
      fs.writeFileSync(descriptor, content)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.chmodSync(temporary, mode)
    renameSyncWithRetry(temporary, target)
    created = false
  } catch (error) {
    if (created) {
      try {
        fs.rmSync(temporary, { force: true })
      } catch {}
    }
    throw error
  }
}

// Async writers follow the same atomic-replace contract as the sync
// writers above (design #1345), for call sites that must not block —
// e.g. DesktopFiles.saveFile in the Electron main process.
export async function renameWithRetry(source: string, destination: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(source, destination)

      return
    } catch (error) {
      const delay = renameRetryDelays[attempt]

      // SAFETY: a failed fs rename throws a NodeJS.ErrnoException whose code names the failure;
      // a thrown value without one is not a rename failure and is rethrown as non-transient below.
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined

      if (delay === undefined || code === undefined || !transientRenameCodes.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

function existingMode(file: string) {
  try {
    return fs.statSync(file).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

// Writes content to a temp file beside the destination, then renames it
// over the destination. On failure the temp file is removed and the
// original error propagates, so a failed or interrupted write leaves a
// pre-existing destination byte-identical. Mode policy: an existing
// file's mode is preserved across the rename; a file that does not
// exist yet is a user-chosen save target, so it keeps the platform
// default creation mode (0o666 before umask) rather than the stores'
// owner-only 0o600.
export async function writeFileAtomic(file: string, content: string) {
  const absolute = path.resolve(file)
  await fs.promises.mkdir(path.dirname(absolute), { recursive: true })
  const target = resolveAtomicTarget(absolute)
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  const mode = existingMode(target)
  const temporary = path.join(path.dirname(target), `.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`)
  let attempted = false

  try {
    attempted = true
    await fs.promises.writeFile(temporary, content, { flag: "wx", mode: 0o666 })
    if (mode !== undefined) await fs.promises.chmod(temporary, mode)
    await renameWithRetry(temporary, target)
    attempted = false
  } catch (error) {
    if (attempted) {
      try {
        await fs.promises.rm(temporary, { force: true })
      } catch {}
    }
    throw error
  }
}

function resolveAtomicTarget(file: string, remaining = 8): string {
  try {
    return fs.realpathSync(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
  }

  let parent: string
  try {
    parent = fs.realpathSync(path.dirname(file))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
    parent = path.dirname(file)
  }

  const target = path.join(parent, path.basename(file))
  let link: string
  try {
    link = fs.readlinkSync(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EINVAL") return target
    throw error
  }
  if (remaining === 0) throw new Error(`Too many levels of symbolic links: ${file}`)
  return resolveAtomicTarget(path.resolve(parent, link), remaining - 1)
}

function fileMode(file: string) {
  // These stores use the contract's preserve policy: keep an existing mode, or use 0o600 for a new file.
  try {
    return fs.statSync(file).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0o600
    throw error
  }
}
