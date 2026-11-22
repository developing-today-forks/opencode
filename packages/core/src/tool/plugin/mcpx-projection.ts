export * as McpxProjection from "./mcpx-projection.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import type { Editor } from "../../tool.js"
import { CodeModeRules } from "../../codemode/rules.js"
import { McpxSecrets } from "./mcpx-secrets.js"
import { McpxSubagent } from "./mcpx-subagent.js"

export type DaemonCall = McpxSecrets.DaemonCall

export interface ProjectedToolRecord {
  readonly id: string
  readonly namespace: string
  readonly toolName: string
  readonly originalTool: any
  /** What the tool registry receives: the native entry and the Code Mode entry. The stable transform re-adds both on every rebuild. */
  readonly definitions?: readonly Tool.Info[]
  ttlRemaining?: number // turns remaining before auto-retract
}

// Active projected tools by tool ID / name. The tool registry is rebuilt from this map, so it lives at module scope.
const projectedTools = new Map<string, ProjectedToolRecord>()

export const getProjectedTools = (): ReadonlyMap<string, ProjectedToolRecord> => projectedTools

export const isProjected = (name: string): boolean => projectedTools.has(name)

/** Definitions for the stable registry transform to add on every rebuild: a native and a Code Mode entry per tool. */
export const projectedToolDefinitions = (): Tool.Info[] =>
  [...projectedTools.values()].flatMap((record) => record.definitions ?? [])

/** Namespace descriptions for projected servers, so each Code Mode catalog line states the rule. */
export const projectedNamespaces = (): Tool.Namespace[] =>
  [...new Set([...projectedTools.values()].map((record) => record.namespace))].map((name) => ({
    name,
    description: `Tools from the mcpx server ${name}. ${CodeModeRules.canonical}`,
  }))

export const clearProjectedTools = (editor?: Editor): string[] => {
  const removed: string[] = []
  for (const [id] of projectedTools) {
    if (editor) {
      try {
        editor.remove(id)
      } catch {}
    }
    removed.push(id)
  }
  projectedTools.clear()
  return removed
}

export const retractTools = (namesOrNamespaces: readonly string[], editor?: Editor): string[] => {
  const removed: string[] = []
  const targets = new Set(namesOrNamespaces.map((s) => s.toLowerCase()))

  for (const [id, record] of projectedTools.entries()) {
    if (targets.has(id.toLowerCase()) || targets.has(record.namespace.toLowerCase()) || targets.has(record.toolName.toLowerCase())) {
      if (editor) {
        try {
          editor.remove(id)
        } catch {}
      }
      projectedTools.delete(id)
      removed.push(id)
    }
  }
  return removed
}

/**
 * Decrements TTL for all projected tools that have a finite turn limit,
 * automatically retracting any that have expired.
 */
export const stepTurnTtl = (editor?: Editor): string[] => {
  const expired: string[] = []
  for (const [id, record] of projectedTools.entries()) {
    if (typeof record.ttlRemaining === "number") {
      record.ttlRemaining -= 1
      if (record.ttlRemaining <= 0) {
        if (editor) {
          try {
            editor.remove(id)
          } catch {}
        }
        projectedTools.delete(id)
        expired.push(id)
      }
    }
  }
  return expired
}

/**
 * Parses script source for references to tools.<namespace>.<tool> and tools["namespace"]["tool"], the two forms the
 * daemon's preflight reads. Each distinct pair is returned once, in source order.
 */
export const extractToolsFromScript = (source: string): Array<{ namespace: string; tool: string }> => {
  const results: Array<{ namespace: string; tool: string }> = []
  const seen = new Set<string>()

  const regex = /\btools(?:\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)|\[["']([^"']+)["']\]\[["']([^"']+)["']\])/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(source)) !== null) {
    const namespace = match[1] ?? match[3]
    const tool = match[2] ?? match[4]
    if (namespace === undefined || tool === undefined) continue
    const key = JSON.stringify([namespace, tool])
    if (seen.has(key)) continue
    seen.add(key)
    results.push({ namespace, tool })
  }

  return results
}

/**
 * Automatically projects tools discovered in an executed script with a default TTL (default: 3 turns).
 */
export const autoProjectFromScript = async (options: {
  source: string
  callDaemon: DaemonCall
  editor?: Editor
  defaultTtl?: number
}): Promise<string[]> => {
  const extracted = extractToolsFromScript(options.source)
  if (extracted.length === 0) return []

  const toolNames = extracted.map((e) => e.tool)
  const namespaces = Array.from(new Set(extracted.map((e) => e.namespace)))

  const { added } = await projectTools({
    namespaces,
    tools: toolNames,
    callDaemon: options.callDaemon,
    editor: options.editor,
    ttl: options.defaultTtl ?? 3,
  })

  return added
}

/**
 * Converts a raw JSON Schema or property definition into an Effect Schema struct.
 */
function buildEffectSchema(inputSchema: any): Schema.Top {
  if (!inputSchema || typeof inputSchema !== "object") {
    return Schema.Unknown
  }

  const props = inputSchema.properties || {}
  const required = new Set<string>(Array.isArray(inputSchema.required) ? inputSchema.required : [])
  const fields: Record<string, Schema.Top> = {}

  for (const [key, propDef] of Object.entries<any>(props)) {
    let fieldSchema: Schema.Top = Schema.Unknown
    const type = propDef?.type

    if (type === "string") {
      fieldSchema = Schema.String
    } else if (type === "number" || type === "integer") {
      fieldSchema = Schema.Number
    } else if (type === "boolean") {
      fieldSchema = Schema.Boolean
    } else if (type === "array") {
      fieldSchema = Schema.Array(Schema.Unknown)
    } else if (type === "object") {
      fieldSchema = Schema.Record(Schema.String, Schema.Unknown)
    }

    if (propDef?.description) {
      fieldSchema = fieldSchema.annotate({ description: propDef.description })
    }

    if (!required.has(key)) {
      fieldSchema = Schema.optionalKey(fieldSchema)
    }

    fields[key] = fieldSchema
  }

  return Schema.Struct(fields as any)
}

/**
 * Projects tools from mcpx namespaces as top-level tools. The definitions are kept in this module, so they
 * survive registry rebuilds. Pass an editor to add them immediately; otherwise the caller reloads the registry.
 */
export const projectTools = async (
  options: {
    namespaces?: readonly string[]
    tools?: readonly string[]
    ttl?: number
    callDaemon: DaemonCall
    editor?: Editor
  },
): Promise<{ added: string[]; errors: string[] }> => {
  const added: string[] = []
  const errors: string[] = []

  const requestedNamespaces = options.namespaces ? new Set(options.namespaces.map((n) => n.toLowerCase())) : undefined
  const requestedToolNames = options.tools ? new Set(options.tools.map((t) => t.toLowerCase())) : undefined

  try {
    const rawTools: any[] = await options.callDaemon("/v1/tools")
    if (!Array.isArray(rawTools)) {
      errors.push("Invalid response from /v1/tools: expected an array")
      return { added, errors }
    }

    for (const item of rawTools) {
      const ns = String(item.namespace || item.server || "")
      const toolName = String(item.tool || "")
      const fullName = `${ns}_${toolName}`

      // Check filtering
      if (requestedNamespaces && !requestedNamespaces.has(ns.toLowerCase())) {
        continue
      }
      if (requestedToolNames && !requestedToolNames.has(toolName.toLowerCase()) && !requestedToolNames.has(fullName.toLowerCase())) {
        continue
      }

      // If already projected, refresh TTL if specified
      if (projectedTools.has(fullName)) {
        if (typeof options.ttl === "number") {
          const existing = projectedTools.get(fullName)
          if (existing) existing.ttlRemaining = options.ttl
        }
        continue
      }

      try {
        const inputSchema = buildEffectSchema(item.inputSchema)
        const outputSchema = Schema.Struct({
          output: Schema.Unknown,
        })

        const description = item.description ? `[mcpx:${ns}] ${item.description}` : `[mcpx:${ns}] ${toolName}`

        // One execute serves both faces, so a projected tool behaves the same native and in a script: the same
        // server gate, the same /v1/call body, and the same failures.
        const execute = (args: any, context?: any) =>
          Effect.gen(function* () {
            const lease = context?.sessionID ? McpxSubagent.getLease(context.sessionID) : undefined
            const sessionID = lease ? lease.childSessionID : context?.sessionID
            const headers: Record<string, string> = {}
            if (sessionID) headers["x-mcpx-session-id"] = sessionID
            if (lease?.parentSessionID) headers["x-mcpx-parent-session-id"] = lease.parentSessionID

            const body: any = {
              server: ns,
              tool: toolName,
              arguments: args || {},
            }
            if (sessionID) body.session = sessionID

            yield* McpxSecrets.ensureServerReady(options.callDaemon, ns, toolName).pipe(
              Effect.mapError((error) => McpxSecrets.failureOf(error, fullName)),
            )
            const res = yield* Effect.tryPromise({
              try: () => options.callDaemon("/v1/call", "POST", body, headers),
              catch: (error) => McpxSecrets.failureOf(error, fullName),
            })

            if (res?.error) {
              return yield* new ToolFailure({ message: String(res.error) })
            }

            return { output: { output: res.result ?? res } }
          })

        const nativeTool: Tool.Info = {
          name: fullName,
          options: { codemode: false },
          description,
          input: inputSchema as any,
          output: outputSchema as any,
          execute,
        }
        const codeModeTool: Tool.Info = {
          name: toolName,
          options: { namespace: ns, codemode: true },
          description,
          input: inputSchema as any,
          output: outputSchema as any,
          execute,
        }

        options.editor?.add(nativeTool)
        options.editor?.add(codeModeTool)
        projectedTools.set(fullName, {
          id: fullName,
          namespace: ns,
          toolName,
          originalTool: item,
          definitions: [nativeTool, codeModeTool],
          ttlRemaining: options.ttl,
        })
        added.push(fullName)
      } catch (addErr: any) {
        errors.push(`Failed to project ${fullName}: ${addErr?.message || String(addErr)}`)
      }
    }
  } catch (fetchErr: any) {
    errors.push(`Failed to fetch /v1/tools: ${fetchErr?.message || String(fetchErr)}`)
  }

  return { added, errors }
}
