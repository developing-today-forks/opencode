import { createHash } from "node:crypto"
import { join } from "node:path"
import { readdirSync, readFileSync } from "node:fs"
import * as proto from "./script/check-proto-reads"
import * as numeric from "./script/check-numeric-boundaries"
import * as bounded from "./script/check-bounded-http"

const root = import.meta.dir
function numericCollect(dir: string, hits: any[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a: any, b: any) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) numericCollect(path, hits)
    else if ((numeric as any).isScannedFile(entry.name))
      hits.push(...(numeric as any).scanSource(path.slice(root.length + 1), readFileSync(path, "utf8")))
  }
}
function dump(name: string, gate: any) {
  const hits: any[] = []
  for (const scanRoot of gate.SCAN_ROOTS) {
    if (name === "numeric-boundaries" && typeof gate.collect !== "function") numericCollect(join(root, scanRoot), hits)
    else gate.collect(root, join(root, scanRoot), hits)
  }
  const keys = hits.map((h: any) => gate.hitKey(h.file, h.text)).sort()
  const hash = createHash("sha256").update(keys.join("\n")).digest("hex")
  console.log(`${name}: hits=${hits.length} keys=${keys.length} sha256=${hash}`)
  return keys
}
const p = dump("proto-reads", proto)
const n = dump("numeric-boundaries", numeric)
const b = dump("bounded-http", bounded)
await Bun.write(join(root, "hits-proto.txt"), p.join("\n") + "\n")
await Bun.write(join(root, "hits-numeric.txt"), n.join("\n") + "\n")
await Bun.write(join(root, "hits-bounded.txt"), b.join("\n") + "\n")
