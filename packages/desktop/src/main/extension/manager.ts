import { randomUUID } from "node:crypto"
import { and, eq, isNotNull } from "drizzle-orm"
import { Option, Predicate } from "effect"
import type { Definition } from "@opencode/gui-extensions/sdk/main"
import { extensionEnabled } from "@opencode/gui-extensions/sdk/bridge"
import type { Database } from "../storage/database"
import { extension, extensionFile } from "../storage/schema"
import { ExtensionError } from "./error"
import { decodeManifest } from "./manifest"
import { readEnableState } from "./enable-state"

/**
 * Enable state and installed archives, committed together in the desktop database. Archive installs are groundwork for
 * `.ocdx` extensions: an installed archive runs its main entry only, the renderer loads built-ins until that format
 * ships renderer bundles, and packaged builds refuse the manager until installs have a trust model.
 */
export function createManager(
  db: Database,
  reserved: (id: string) => boolean,
  definitions: readonly Definition[],
  downloadOptions: ExtensionDownloadOptions = {},
) {
  return {
    /** Every installed archive. A manifest that no longer decodes is reported, not dropped. */
    installed() {
      return db
        .select()
        .from(extension)
        .where(isNotNull(extension.manifest))
        .all()
        .map((item) => ({
          id: item.id,
          enabled: item.enabled,
          revision: item.revision ?? undefined,
          manifest: Option.getOrUndefined(decodeManifest(item.manifest)),
        }))
    },
    /** The current id wins, then declared legacy ids newest first; no setting means enabled. */
    enabled(id: string) {
      return extensionEnabled(
        definitions.find((definition) => definition.id === id) ?? { id },
        readEnableState(db.$client),
      )
    },
    setEnabled(id: string, enabled: boolean) {
      db.insert(extension).values({ id, enabled }).onConflictDoUpdate({ target: extension.id, set: { enabled } }).run()
    },
    /** A new revision tells renderers to reload the extension's code and assets. */
    bump(id: string) {
      db.update(extension).set({ revision: randomUUID() }).where(eq(extension.id, id)).run()
    },
    file(id: string, path: string) {
      return db
        .select({ data: extensionFile.data })
        .from(extensionFile)
        .where(and(eq(extensionFile.extension_id, id), eq(extensionFile.path, path)))
        .get()?.data
    },
    async install(source: Uint8Array | string) {
      const { readArchive } = await import("./archive")
      const archive = await readArchive(Predicate.isString(source) ? await download(source, downloadOptions) : source)
      const id = archive.manifest.id

      if (reserved(id)) throw new ExtensionError("reserved")

      const values = { enabled: true, manifest: JSON.stringify(archive.manifest), revision: randomUUID() }
      db.transaction((tx) => {
        tx.delete(extensionFile).where(eq(extensionFile.extension_id, id)).run()
        tx.insert(extension)
          .values({ id, ...values })
          .onConflictDoUpdate({ target: extension.id, set: values })
          .run()
        archive.files.forEach((file) =>
          tx.insert(extensionFile).values({ extension_id: id, path: file.path, data: file.data }).run(),
        )
      })

      return archive.manifest
    },
    remove(id: string) {
      db.transaction((tx) => {
        tx.delete(extensionFile).where(eq(extensionFile.extension_id, id)).run()
        tx.delete(extension).where(eq(extension.id, id)).run()
      })
    },
  }
}

/**
 * The fetch an archive download runs through: Electron's `net.fetch` in the app, a test double in
 * tests (the desktop unit suite runs under Bun, where `electron` has no `net`). The `signal` is the
 * download deadline's — a fetch that honors it is cancelled when the deadline fires.
 */
export type ExtensionFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>

export interface ExtensionDownloadOptions {
  readonly fetch?: ExtensionFetch
  readonly deadlineMs?: number
}

/**
 * The overall deadline for one archive download (#1091): it covers the fetch and the chunk pump
 * together, so a response that never arrives, a body that stalls, and a body that slow-drips all
 * settle as the same download failure instead of hanging the install. Sized for the 100 MiB archive
 * cap on a slow-but-honest connection: 100 MiB at ~350 KiB/s (~2.8 Mbps) takes about 300 s.
 */
export const EXTENSION_DOWNLOAD_DEADLINE_MS = 300_000

const electronFetch: ExtensionFetch = async (url, init) => {
  const { net } = await import("electron")

  return net.fetch(url, init)
}

export async function downloadArchive(
  url: string,
  options: ExtensionDownloadOptions = {},
): Promise<Buffer> {
  const { archiveLimit } = await import("./archive")

  if (!URL.canParse(url) || !["http:", "https:"].includes(new URL(url).protocol)) throw new ExtensionError("url")

  const deadlineMs = options.deadlineMs ?? EXTENSION_DOWNLOAD_DEADLINE_MS
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timedOut = false

  // The deadline is a race, not only the abort signal: a fetch (or a body) that ignores the signal
  // still loses the race and the install fails instead of hanging. The abort and the reader cancel
  // are the cleanup for implementations that do honor them.
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reader?.cancel().catch(() => {})
      reject(new Error(`extension download deadline of ${deadlineMs} ms elapsed`))
    }, deadlineMs)
  })

  const work = (async () => {
    const response = await (options.fetch ?? electronFetch)(url, { signal: controller.signal }).catch((error) => {
      throw new ExtensionError("download", { cause: error })
    })

    if (!response.ok || !response.body) throw new ExtensionError("download", { message: String(response.status) })

    if (Number(response.headers.get("content-length")) > archiveLimit) {
      await response.body.cancel()

      throw new ExtensionError("tooLarge")
    }

    reader = response.body.getReader()
    const chunks: Uint8Array[] = []

    const pump = async (size: number): Promise<number> => {
      const next = await reader!.read()

      if (next.done) return size

      if (size + next.value.byteLength > archiveLimit) {
        await reader!.cancel()

        throw new ExtensionError("tooLarge")
      }

      chunks.push(next.value)

      return pump(size + next.value.byteLength)
    }

    await pump(0)

    return Buffer.concat(chunks)
  })()

  try {
    return await Promise.race([work, deadline])
  } catch (error) {
    if (timedOut)
      throw new ExtensionError("download", {
        message: `download timed out after ${deadlineMs} ms`,
        cause: error,
      })
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function download(url: string, options: ExtensionDownloadOptions = {}) {
  return downloadArchive(url, options)
}
