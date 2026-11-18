import { existsSync, readFileSync, renameSync } from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import electron from "electron"

import { writeFileSyncAtomic } from "../atomic-write"
import { SETTINGS_STORE } from "./keys"

/** The file: one JSON object, each key a setting whose reader decodes its value. */
const SettingsFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

const cache = new Map<string, SettingsStore>()

export type SettingsStore = ReturnType<typeof createSettingsStore>

// Main-process settings only (onboarding, default server, window list, appearance, plugin storage).
// These are read synchronously before the storage layer exists and written on user action, so a
// synchronous whole-file write is acceptable here. Renderer state goes through DesktopStorage.
//
// The file is the tab-indented JSON object electron-store used to write, so existing profiles
// (and older builds) read the same data.
//
// We cannot instantiate the store at module load time because module import hoisting causes this
// to run before app.setPath("userData", ...) has executed, which would result in files being
// written to the default directory (e.g. bad: %APPDATA%\@opencode\desktop\opencode.settings vs
// good: %APPDATA%\ai.opencode.desktop.dev\opencode.settings).
export function getStore(name = SETTINGS_STORE) {
  const cached = cache.get(name)

  if (cached) return cached
  const next = createSettingsStore(path.join(electron.app.getPath("userData"), name))
  cache.set(name, next)

  return next
}

export function createSettingsStore(file: string) {
  let data = read(file)

  const write = () => {
    writeFileSyncAtomic(file, JSON.stringify(data, null, "\t"))
  }

  return {
    path: file,
<<<<<<< HEAD
    // SAFETY: settings values are opaque JSON chosen by each caller; the store round-trips them uninterpreted.
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- see SAFETY above
    get: (key: string): unknown => data[key],
    // SAFETY: see the get note above — any JSON value a caller sets is stored verbatim.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- see SAFETY above
    set: (key: string, value: unknown) => {
=======
    get: (key: string): Schema.Json | undefined => data[key],
    set: (key: string, value: Schema.Json) => {
>>>>>>> upstream-anomalyco/dev
      if (value === undefined) throw new TypeError(`Use \`delete()\` to clear values: ${key}`)
      data = { ...data, [key]: value }
      write()
    },
    delete: (key: string) => {
      data = Object.fromEntries(Object.entries(data).filter(([item]) => item !== key))
      write()
    },
  }
}

<<<<<<< HEAD
// A missing file is an empty store. An unreadable one is set aside instead of blocking startup.
// SAFETY: the on-disk settings file is a JSON object whose values are opaque to this module (see above).
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see SAFETY above
function read(file: string): Record<string, unknown> {
=======
// A missing file is an empty store. One that is not a JSON object is set aside instead of blocking startup.
function read(file: string): typeof SettingsFile.Type {
>>>>>>> upstream-anomalyco/dev
  if (!existsSync(file)) return {}

  const parsed = Schema.decodeUnknownOption(SettingsFile)(readFileSync(file, "utf8"))

<<<<<<< HEAD
    // SAFETY: JSON.parse output is narrowed to a non-array object before the cast; anything else reads as empty.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- see SAFETY above
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    renameSync(file, `${file}.corrupt`)
=======
  if (Option.isSome(parsed)) return parsed.value
  renameSync(file, `${file}.corrupt`)
>>>>>>> upstream-anomalyco/dev

  return {}
}
