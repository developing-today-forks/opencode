import { z } from "zod"

/**
 * Compatibility surface for v1 custom tools (`.opencode/tool/*.ts`).
 *
 * v1 tool files import `{ tool }` from `@opencode-ai/plugin`; the host
 * provides that specifier as an alias of this module (see
 * `runtime-modules.ts`), so existing tool files keep working unchanged in
 * v2. `tool()` is intentionally a thin marker: it validates the definition
 * shape and returns it, and the core custom-tool loader
 * (`@opencode/core/config/plugin/tool`) converts the definition into a
 * native v2 tool registration. `tool.schema` is Zod, exactly as in v1.
 */
export interface ToolDefinition {
  readonly description: string
  readonly args?: Record<string, z.ZodType>
  readonly execute: (args: any, context: any) => Promise<any>
}

export function tool(definition: ToolDefinition): ToolDefinition {
  if (!definition || typeof definition !== "object")
    throw new Error("tool() requires a definition object with a description, args, and execute function.")
  if (typeof definition.description !== "string" || definition.description.length === 0)
    throw new Error("tool() definition requires a non-empty description.")
  if (typeof definition.execute !== "function") throw new Error("tool() definition requires an execute function.")
  return definition
}

tool.schema = z
