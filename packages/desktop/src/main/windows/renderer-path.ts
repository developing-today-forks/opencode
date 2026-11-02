import path from "node:path"

type RendererPathResolution =
  | { kind: "resolved"; file: string }
  | { kind: "rejected"; file: string; response: Response }
  | { kind: "malformed"; error: unknown; response: Response }

export function resolveRendererPath(rendererRoot: string, pathname: string): RendererPathResolution {
  try {
    const file = path.resolve(rendererRoot, `.${decodeURIComponent(pathname)}`)
    const relative = path.relative(rendererRoot, file)

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { kind: "rejected", file, response: new Response("Not found", { status: 404 }) }
    }

    return { kind: "resolved", file }
  } catch (error) {
    return { kind: "malformed", error, response: new Response("Not found", { status: 404 }) }
  }
}
