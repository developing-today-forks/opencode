import crypto from "node:crypto"
import path from "path"
import { appendFile, chmod, mkdir, open, readFile, readlink, realpath, rename, rm, stat, writeFile } from "fs/promises"

export function readText(filePath: string) {
  return readFile(filePath, "utf8")
}

export async function readJson<T>(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as T
}

export async function writeText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

export async function appendText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, content)
}

const transientRenameCodes = new Set(["EPERM", "EACCES", "EBUSY"])
const renameRetryDelays = [10, 25, 50, 100]

function isTransientRenameError(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  if (!("code" in error)) return false
  return typeof error.code === "string" && transientRenameCodes.has(error.code)
}

export async function renameWithRetry(
  source: string,
  destination: string,
  renameFile: (source: string, destination: string) => Promise<void> = rename,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFile(source, destination)
      return
    } catch (error) {
      const delay = renameRetryDelays[attempt]
      if (delay === undefined || !isTransientRenameError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  renameFile: (source: string, destination: string) => Promise<void> = rename,
) {
  const absolute = path.resolve(filePath)
  await mkdir(path.dirname(absolute), { recursive: true })
  const target = await resolveAtomicTarget(absolute)
  await mkdir(path.dirname(target), { recursive: true })
  const mode = await fileMode(target)
  const temporary = path.join(path.dirname(target), `.tmp-${process.pid}-${crypto.randomUUID()}`)
  let created = false
  try {
    const handle = await open(temporary, "wx", 0o600)
    created = true
    try {
      await handle.writeFile(JSON.stringify(value))
    } finally {
      await handle.close()
    }
    await chmod(temporary, mode)
    await renameWithRetry(temporary, target, renameFile)
    created = false
  } catch (error) {
    if (created) await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function resolveAtomicTarget(file: string, remaining = 8): Promise<string> {
  try {
    return await realpath(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
  }

  let parent: string
  try {
    parent = await realpath(path.dirname(file))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
    parent = path.dirname(file)
  }

  const target = path.join(parent, path.basename(file))
  let link: string
  try {
    link = await readlink(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EINVAL") return target
    throw error
  }
  if (remaining === 0) throw new Error(`Too many levels of symbolic links: ${file}`)
  return resolveAtomicTarget(path.resolve(parent, link), remaining - 1)
}

async function fileMode(file: string) {
  // These stores use the contract's preserve policy: keep an existing mode, or use 0o600 for a new file.
  try {
    return (await stat(file)).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0o600
    throw error
  }
}
