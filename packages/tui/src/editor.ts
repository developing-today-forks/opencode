import type { CliRenderer } from "@opentui/core"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { open, readFile, rm } from "node:fs/promises"
import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import type { Stream } from "node:stream"
import { resolveZedDbPath, resolveZedSelection } from "./editor-zed"

export { normalizePromptContent } from "./prompt/content"

type EditorStdio = "inherit" | "pipe" | "ignore" | number | Stream

// Stage the prompt buffer in a file only this process can know about or open:
// an unguessable name, created exclusively ("wx") with mode 0o600, retrying
// with a fresh name on EEXIST so a pre-planted file or symlink at a candidate
// path is never followed. Mirrors writeTextAtomic in ./util/persistence.
export async function createEditorStagingFile(
  value: string,
  directory: string = os.tmpdir(),
  name: () => string = () => `opencode-editor-${crypto.randomUUID()}.md`,
): Promise<string> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const file = path.join(directory, name())
    const handle = await open(file, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return undefined
      throw error
    })
    if (!handle) continue
    try {
      await handle.writeFile(value)
      return file
    } catch (error) {
      await rm(file, { force: true }).catch(() => undefined)
      throw error
    } finally {
      await handle.close()
    }
  }
  throw new Error("Unable to create a unique staging file for the external editor")
}

export async function openEditor(input: { value: string; renderer: CliRenderer; cwd?: string; stdin?: EditorStdio }) {
  const editor = process.env.VISUAL || process.env.EDITOR
  if (!editor) throw new Error("Set $VISUAL or $EDITOR to open an external editor")
  const file = await createEditorStagingFile(input.value)
  await input.renderer.suspend()
  try {
    await new Promise<void>((resolve, reject) => {
      const parts = editor.split(" ")
      const child = spawn(parts[0]!, [...parts.slice(1), file], {
        cwd: input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd(),
        stdio: [input.stdin ?? "inherit", "inherit", "inherit"],
        shell: process.platform === "win32",
      })
      child.on("error", reject)
      child.on("exit", (code, signal) => {
        if (code === 0) return resolve()
        reject(new Error(`Editor exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
      })
    })
    return (await readFile(file, "utf8")) || undefined
  } finally {
    await rm(file, { force: true }).catch(() => {})
    await input.renderer.resume()
  }
}

export function parseEditorPort(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const port = Number(value)
  return port > 0 && port <= 65535 ? port : undefined
}

export function discoverEditorConnection(directory: string) {
  const root = path.join(os.homedir(), ".claude", "ide")
  const contains = (parent: string) => {
    const resolved = path.resolve(parent)
    const relative = path.relative(resolved, path.resolve(directory))
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved.length : 0
  }
  try {
    return readdirSync(root)
      .filter((entry) => entry.endsWith(".lock"))
      .flatMap((entry) => {
        const file = path.join(root, entry)
        const port = parseEditorPort(path.basename(file, ".lock"))
        if (!port) return []
        try {
          const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
          if (value.transport !== undefined && value.transport !== "ws") return []
          const folders = Array.isArray(value.workspaceFolders)
            ? value.workspaceFolders.filter((item): item is string => typeof item === "string")
            : []
          const score = Math.max(0, ...folders.map(contains))
          if (!score) return []
          return [
            {
              url: `ws://127.0.0.1:${port}`,
              authToken: typeof value.authToken === "string" ? value.authToken : undefined,
              source: `lock:${port}`,
              score,
              mtime: statSync(file).mtimeMs,
            },
          ]
        } catch {
          return []
        }
      })
      .sort((left, right) => right.score - left.score || right.mtime - left.mtime)
      .map(({ url, authToken, source }) => ({ url, authToken, source }))[0]
  } catch {
    return undefined
  }
}

export const editorIntegration = {
  connection: discoverEditorConnection,
  selection: (directory: string) => resolveZedSelection(resolveZedDbPath() ?? "", directory),
}
