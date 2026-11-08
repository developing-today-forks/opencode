// Test preload: compile Solid JSX with babel-plugin-jsx-dom-expressions
// (via babel-preset-solid) instead of Bun's automatic JSX runtime.
//
// Bun >= 1.4.3 transpiles JSX in .tsx/.jsx files to jsxDEV/jsx imports from
// "solid-js/jsx-dev-runtime" / "solid-js/jsx-runtime", but no solid-js dist
// build exports those functions — Solid JSX is meant to be compiled, not
// interpreted by a runtime. Without this preload every test file that
// imports a component fails to load with
// "Export named 'jsxDEV' not found in module '.../solid-js/dist/solid.js'"
// (see issue #1698). The production build never hits this because
// vite-plugin-solid compiles the same way this preload does.
//
// Compiled JSX imports DOM primitives from "solid-js/web". Under Bun's
// default (and the "solid") export conditions that specifier resolves to
// solid-js/web's server build, whose DOM functions throw "Client-only API
// called on the server side" at module scope. These tests run against a
// DOM (happy-dom), so compiled output is rewritten to the browser build of
// the very same solid-js copy. Every other specifier keeps its original
// resolution — in particular "solid-js" and "solid-js/store" stay on the
// builds the suites were written against, whose non-proxied stores keep
// Bun's expect matchers working.
//
// Transform results are cached on disk (content-addressed) so that
// `bun test --isolate`, which re-imports the component graph in a fresh
// process per test file, does not re-run Babel for every file.
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const CACHE_VERSION = "solid-jsx-preload-v2-webpin"

const cacheDir = join(import.meta.dir, "..", "..", "node_modules", ".cache", "solid-jsx-preload")

const webClientPath = (() => {
  try {
    const req = createRequire(import.meta.url)

    return join(dirname(req.resolve("solid-js/package.json")), "web", "dist", "web.js")
  } catch {
    return undefined
  }
})()

function pinWeb(code: string) {
  if (!webClientPath) return code

  return code.replace(/(["'])solid-js\/web\1/g, JSON.stringify(webClientPath))
}

function cachePath(source: string) {
  const hash = createHash("sha256").update(CACHE_VERSION).update("\0").update(source).digest("hex")

  return join(cacheDir, hash + ".js")
}

plugin({
  name: "solid-jsx-preload",
  setup(build) {
    build.onLoad({ filter: /\.(tsx|jsx)$/ }, async (args) => {
      // Skip type-only and declaration files; everything else with a JSX
      // extension is source in this repo (workspace packages export raw
      // .tsx, and the "solid" export condition resolves dependencies such
      // as @kobalte/core to their untranspiled .jsx source).
      if (args.path.endsWith(".d.tsx") || args.path.endsWith(".d.jsx")) return
      const source = await Bun.file(args.path).text()
      const cached = cachePath(source)

      if (existsSync(cached)) {
        return { contents: readFileSync(cached, "utf8"), loader: "js" }
      }

      const result = await transformAsync(source, {
        filename: args.path,
        presets: [
          ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
          ["babel-preset-solid", { generate: "dom", hydratable: false }],
        ],
        sourceMaps: "inline",
        configFile: false,
        babelrc: false,
      })

      if (!result?.code) return
      const code = pinWeb(result.code)

      try {
        mkdirSync(cacheDir, { recursive: true })
        const tmp = cached + ".tmp-" + process.pid
        writeFileSync(tmp, code)
        renameSync(tmp, cached)
      } catch {
        // Cache is best-effort; a failed write only costs a re-transform.
      }

      return { contents: code, loader: "js" }
    })
  },
})
