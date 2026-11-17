import { Uint8ArrayReader, Writer, ZipReader } from "@zip.js/zip.js"
import { ExtensionError } from "./error"
import { archivePath, decodeManifest } from "./manifest"
import { mainImportAllowed } from "./module"

export const archiveLimit = 104_857_600

const entryLimit = 4_096

const manifestLimit = 65_536

/**
 * Collects an entry's decompressed bytes while counting them (#2487): the
 * central directory's declared sizes are attacker-controlled, so the caps
 * must bind the actual bytes as they stream out of the inflater, not a
 * total computed after everything is materialised. Throws the moment the
 * running count passes the entry's declared size (the archive misdeclared
 * itself) or the remaining shared budget, which aborts decompression at
 * that chunk instead of at the end of the archive.
 */
class BoundedWriter extends Writer<Uint8Array> {
  private chunks: Uint8Array[] = []
  private size = 0

  constructor(
    private readonly declared: number,
    private readonly budget: number,
  ) {
    super()
  }

  async writeUint8Array(array: Uint8Array) {
    this.size += array.byteLength
    if (this.size > this.declared) throw new ExtensionError("invalidArchive")
    if (this.size > this.budget) throw new ExtensionError("tooLarge")
    this.chunks.push(array)
  }

  async getData() {
    const data = new Uint8Array(this.size)
    let offset = 0
    for (const chunk of this.chunks) {
      data.set(chunk, offset)
      offset += chunk.byteLength
    }
    return data
  }
}

/** Reads and validates an extension archive before anything replaces a working installation. */
export async function readArchive(data: Uint8Array) {
  if (data.byteLength > archiveLimit) throw new ExtensionError("tooLarge")

  if (data[0] !== 0x50 || data[1] !== 0x4b) throw new ExtensionError("invalidArchive")

  // zip.js expects slice() to copy; Node Buffer.slice() returns a view instead.
  const reader = new ZipReader(new Uint8ArrayReader(Buffer.isBuffer(data) ? new Uint8Array(data) : data), {
    useWebWorkers: false,
  })

  return read(reader)
    .catch((error: unknown) => {
      if (error instanceof ExtensionError) throw error
      throw new ExtensionError("invalidArchive", { cause: error })
    })
    .finally(() => reader.close())
}

async function read(reader: ZipReader<Uint8Array>) {
  const entries = await reader.getEntries()

  if (entries.length > entryLimit || entries.reduce((total, entry) => total + entry.uncompressedSize, 0) > archiveLimit)
    throw new ExtensionError("tooLarge")

  const paths = entries.map((entry) =>
    archivePath(entry.directory ? entry.filename.replace(/\/$/, "") : entry.filename),
  )

  if (new Set(paths).size !== paths.length) throw new ExtensionError("invalidPath")
  const metadata = entries.find((entry) => entry.filename === "manifest.json" && !entry.directory)

  if (!metadata?.getData || metadata.uncompressedSize > manifestLimit) throw new ExtensionError("invalidManifest")
  // The 65 KiB manifest cap binds actual decompressed bytes, not the
  // declared size alone: a size-patched manifest is refused by the writer.
  const decoded = decodeManifest(
    new TextDecoder().decode(await metadata.getData(new BoundedWriter(metadata.uncompressedSize, manifestLimit))),
  )

  if (decoded._tag === "None") throw new ExtensionError("invalidManifest")
  const manifest = decoded.value
  const entrypoints = [manifest.renderer, manifest.main, manifest.style].filter((path) => path !== undefined)
  entrypoints.forEach(archivePath)

  if (!(manifest.imports.main ?? []).every(mainImportAllowed)) throw new ExtensionError("invalidModule")

  // Extract sequentially against one shared budget of actual bytes: the
  // declared-size sum above is only a pre-check, and materialising every
  // entry concurrently (Promise.all over unbounded writers) is what let a
  // 65 KB archive decompress 64 MiB before any cap applied (#2487).
  const files: { path: string; data: Buffer }[] = []
  let total = 0
  for (const entry of entries) {
    if (entry.directory) continue
    if (!entry.getData) throw new ExtensionError("invalidArchive")

    const data = await entry.getData(new BoundedWriter(entry.uncompressedSize, archiveLimit - total))
    total += data.byteLength
    files.push({ path: entry.filename, data: Buffer.from(data) })
  }

  if (!entrypoints.every((path) => files.some((file) => file.path === path)))
    throw new ExtensionError("invalidManifest")

  // Reject syntax errors before replacing a working installation; evaluation happens in the hosts.
  const broken = [manifest.renderer, manifest.main]
    .flatMap((path) => files.filter((file) => file.path === path))
    .find((file) => !compiles(file.data.toString("utf8")))

  if (broken) throw new ExtensionError("invalidModule", { message: broken.path })

  return { manifest, files }
}

function compiles(source: string) {
  // Compiling is the only syntax check the runtime offers, and it reports failure by throwing.
  try {
    new Function("require", "module", "exports", source)

    return true
  } catch {
    return false
  }
}
