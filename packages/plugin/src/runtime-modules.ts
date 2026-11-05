import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export type RuntimeModuleLoader = () => Record<string, unknown> | Promise<Record<string, unknown>>

const runtimePackages = ["effect", "@opencode/plugin"] as const

export function resolveHostPackageRoots(from = import.meta.dir, packages: readonly string[] = runtimePackages) {
  return packages.flatMap((pkgName) => {
    const dir = path.dirname(Bun.resolveSync(`${pkgName}/package.json`, from))
    return [dir, findNodeModulesDir(pkgName, from, dir)]
  })
}

export function loadRuntimeModules(): Readonly<Record<string, RuntimeModuleLoader>> {
  const entries = discoverPluginRuntimeSpecifiers()
  const effectEntry = entries.get("effect")
  if (effectEntry) require(effectEntry)
  return Object.fromEntries(
    [...entries.entries()].map(([specifier, resolved]) => [specifier, createLoader(resolved)]),
  )
}

export function discoverPluginRuntimeSpecifiers(
  from = import.meta.dir,
  packages: readonly string[] = runtimePackages,
): ReadonlyMap<string, string> {
  const entries = new Map<string, string>()
  for (const pkgName of packages) {
    const realDir = path.dirname(Bun.resolveSync(`${pkgName}/package.json`, from))
    // Resolve workspace @opencode/plugin paths via node_modules so OpenTUI does not wrap host files in async rewrite loaders.
    const loadDir = findNodeModulesDir(pkgName, from, realDir)
    const toLoadPath = (resolved: string) =>
      loadDir === realDir ? resolved : path.join(loadDir, path.relative(realDir, resolved))
    const rootEntry = Bun.resolveSync(pkgName, from)
    const relParts = path.relative(realDir, rootEntry).replaceAll("\\", "/").split("/")
    const scanDir = relParts.length > 1 ? path.join(realDir, relParts[0]) : realDir
    const ext = path.extname(rootEntry) || ".js"
    entries.set(pkgName, toLoadPath(rootEntry))
    for (const file of new Bun.Glob(`**/*${ext}`).scanSync({ cwd: scanDir })) {
      const normalized = file.replaceAll("\\", "/")
      if (
        normalized.startsWith("internal/") ||
        normalized.includes("/internal/") ||
        normalized.startsWith("source.") ||
        normalized.startsWith("runtime")
      ) {
        continue
      }
      const base = normalized.slice(0, -ext.length)
      if (base === "index") continue
      const candidates = base.endsWith("/index")
        ? [`${pkgName}/${base.slice(0, -"/index".length)}`, `${pkgName}/${base}`]
        : [`${pkgName}/${base}`]
      for (const specifier of candidates) {
        if (entries.has(specifier)) continue
        try {
          entries.set(specifier, toLoadPath(Bun.resolveSync(specifier, from)))
        } catch {}
      }
    }
  }
  // v1 custom tools import `tool()` from "@opencode-ai/plugin" (#1703). Alias
  // that legacy specifier to the host's compatibility helper so existing
  // `.opencode/tool/*.ts` files load unchanged, with no per-project install.
  // This must live in discovery: the CLI build replaces loadRuntimeModules
  // with a generated map keyed by exactly these specifiers.
  const helper = entries.get("@opencode/plugin/tool-helper")
  if (helper) entries.set("@opencode-ai/plugin", helper)
  return entries
}

export function pluginRuntimeLoaderCode(specifier: string, entries: ReadonlyMap<string, string>) {
  // The legacy alias loads through its canonical specifier (see discovery).
  if (specifier === "@opencode-ai/plugin") return pluginRuntimeLoaderCode("@opencode/plugin/tool-helper", entries)
  if (specifier.startsWith("effect/")) {
    const slash = specifier.lastIndexOf("/")
    const parent = specifier.slice(0, slash)
    const member = specifier.slice(slash + 1)
    const parentResolved = entries.get(parent)
    const resolved = entries.get(specifier)
    if (
      member !== "index" &&
      parentResolved &&
      resolved &&
      (require(parentResolved) as Record<string, unknown>)[member] === require(resolved)
    ) {
      return `() => require(${JSON.stringify(parent)})[${JSON.stringify(member)}]`
    }
  }
  return `() => require(${JSON.stringify(specifier)})`
}

export function createLoader(resolved: string): RuntimeModuleLoader {
  let cached: Record<string, unknown> | undefined
  let pending: Promise<Record<string, unknown>> | undefined
  return () => {
    if (cached) return cached
    if (pending) return pending
    try {
      return (cached = require(resolved) as Record<string, unknown>)
    } catch {
      return (pending = import(pathToFileURL(resolved).href).then(
        (mod: Record<string, unknown>) => (cached = mod),
        (error) => {
          pending = undefined
          throw error
        },
      ))
    }
  }
}

function findNodeModulesDir(pkgName: string, from: string, realDir: string) {
  if (/[/\\]node_modules[/\\]/.test(realDir)) return realDir
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", pkgName)
    if (existsSync(candidate) && realpathSync(candidate) === realDir) return candidate
    if (path.dirname(dir) === dir) return realDir
  }
}
