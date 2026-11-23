import { plugin } from "bun"

// Bun transpiles TSX against the tsconfig `jsxImportSource`, but `solid-js/jsx-runtime` has no runtime
// exports because Solid's compiler normally replaces JSX. Tests run without that compiler, so compile
// JSX against Solid's hyperscript runtime instead.
const transpiler = new Bun.Transpiler({
  loader: "tsx",
  trimUnusedImports: true,
  tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "solid-js/h" } },
})

// The transpiler emits automatic-runtime calls under hashed local names (`jsx_w77yafs4`,
// `jsxs_eh6c78nj`, `Fragment_8vg9x3sq`) and never emits the runtime import: in a bundle the
// linker resolves those names, but test modules run unbundled, so every module containing JSX
// throws `ReferenceError: jsx_… is not defined`. Bind the emitted names to the real runtime
// with an explicit import prepended to the transformed output.
const runtime = "solid-js/h/jsx-runtime"
const emitted = /\b(jsx|jsxs|jsxDEV|Fragment)_([a-z0-9]+)\b/g

export function bindRuntime(contents: string): string {
  const names = new Map<string, string>()
  for (const match of contents.matchAll(emitted)) names.set(match[0], match[1])
  if (names.size === 0) return contents
  const bindings = [...names].map(([local, base]) => `${base} as ${local}`).join(", ")
  return `import { ${bindings} } from "${runtime}";\n${contents}`
}

plugin({
  name: "solid-jsx-runtime",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => ({
      contents: bindRuntime(transpiler.transformSync(await Bun.file(args.path).text())),
      loader: "js",
    }))
  },
})
