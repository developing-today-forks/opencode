import nodePath from "path"
import { customType } from "drizzle-orm/sqlite-core"
import { Option, Schema } from "effect"
import { AbsolutePath } from "../schema.js"

function storagePath(input: string) {
  if (process.platform !== "win32") return input
  return input.replaceAll("\\", "/")
}

function isWindowsStoragePath(input: string) {
  return /^[A-Za-z]:\//.test(input) || input.startsWith("//")
}

export function storedAbsolutePath(input: string) {
  const result = storagePath(input)
  // Persisted projects and sessions can move between operating systems during migration.
  if (nodePath.posix.isAbsolute(result) || isWindowsStoragePath(result)) return result
}

function absolute(input: string) {
  const result = storedAbsolutePath(input)
  if (result === undefined) throw new Error(`Path is not absolute: ${input}`)
  return result
}

function toPlatform(input: string) {
  if (process.platform !== "win32" || !isWindowsStoragePath(input)) return input
  return input.replaceAll("/", "\\")
}

export const absoluteColumn = customType<{
  data: AbsolutePath
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return absolute(input)
  },
  fromDriver(input) {
    return AbsolutePath.make(toPlatform(absolute(input)))
  },
})

// Legacy sessions may persist an empty directory. Keep that existing value
// readable while normalizing and validating every real directory.
export const directoryColumn = customType<{
  data: string
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return input ? absolute(input) : input
  },
  fromDriver(input) {
    return input ? toPlatform(absolute(input)) : input
  },
})

export const pathColumn = customType<{
  data: string
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return storagePath(input)
  },
  fromDriver(input) {
    return storagePath(input)
  },
})

const decodeAbsoluteArray = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))
const decodeAbsoluteArrayOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

// Non-throwing counterparts of the column decoders below, for readers that must
// tolerate a persisted cell which no longer decodes (schema skew, a verbatim
// migration copy of an already-corrupt cell) instead of dying on it.
export function decodeStoredAbsolutePath(input: string): AbsolutePath | undefined {
  const result = storedAbsolutePath(input)
  return result === undefined ? undefined : AbsolutePath.make(toPlatform(result))
}

export function decodeStoredAbsoluteArray(input: string): AbsolutePath[] | undefined {
  const decoded = decodeAbsoluteArrayOption(input)
  if (Option.isNone(decoded)) return undefined
  const result: AbsolutePath[] = []
  for (const item of decoded.value) {
    const decodedItem = decodeStoredAbsolutePath(item)
    if (decodedItem === undefined) return undefined
    result.push(decodedItem)
  }
  return result
}

export const absoluteArrayColumn = customType<{
  data: AbsolutePath[]
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return JSON.stringify(input.map(absolute))
  },
  fromDriver(input) {
    return decodeAbsoluteArray(input).map((item) => AbsolutePath.make(toPlatform(absolute(item))))
  },
})
