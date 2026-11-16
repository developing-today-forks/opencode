// Side-effect CSS entry points re-exported by @opencode/ui. They resolve to
// .css files through the package's exports map, so the "*.css" declarations
// from vite/client do not match the bare subpath specifiers. bun check treats
// the missing declarations as an error while vite serves them at runtime.
declare module "@opencode/ui/styles"
declare module "@opencode/ui/styles/tokens"
