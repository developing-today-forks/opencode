export * as ConfigAgentDocuments from "./agent-documents.js"

import { Document, Info, type Entry } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { ConfigMarkdown } from "./markdown.js"
import { FSUtil } from "@opencode/util/fs-util"
import { ConfigAgentV1 } from "../v1/config/agent.js"
import { ConfigMigrateV1 } from "../v1/config/migrate.js"
import { AbsolutePath } from "../schema.js"

const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
// Keep in sync with the legacySources patterns and the name-strip regex in decode.
export const sourceDirectories = ["agent", "agents", "mode", "modes"] as const
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const decodeLegacyAgent = Schema.decodeUnknownOption(ConfigAgentV1.Info)
const decodeConfig = Schema.decodeUnknownOption(Info)
const agentKeys = new Set(["variant", ...Object.keys(ConfigAgent.Info.fields)])

/**
 * The Documents a config entry carries for the agent definition layer: a
 * document entry carries itself; a directory entry expands to the agent and
 * mode Markdown files discovered under it, decoded exactly the way the config
 * agent plugin decodes them for the agent editor. Any other entry carries
 * nothing. Shared by the config agent plugin and by governance
 * (ModelGovernance / SubagentDepth via GovernanceConfig), so an agent defined
 * only in Markdown is governed by the same fields the editor applies (#1107).
 */
export function expandEntry(fs: FSUtil.Interface, entry: Entry): Effect.Effect<Document[]> {
  if (entry.type === "document") return Effect.succeed([entry])
  if (entry.type !== "directory") return Effect.succeed([])
  return discover(fs, entry.path).pipe(
    Effect.flatMap((files) =>
      Effect.forEach(files, (file) =>
        fs.readFileStringSafe(file.filepath).pipe(
          Effect.map((content) => (content ? decode(file, content) : undefined)),
          Effect.orElseSucceed(() => undefined),
        ),
      ),
    ),
    Effect.map((documents) => documents.filter((document): document is Document => document !== undefined)),
  )
}

/**
 * Entries with every directory entry replaced, in place, by the Documents it
 * expands to. Entry order is preserved, so definition merging (later entries
 * override earlier fields) matches the config agent plugin's load order.
 */
export function expandEntries(fs: FSUtil.Interface, entries: readonly Entry[]): Effect.Effect<Entry[]> {
  return Effect.forEach(entries, (entry) =>
    entry.type === "directory" ? expandEntry(fs, entry) : Effect.succeed([entry] as Entry[]),
  ).pipe(Effect.map((expanded) => expanded.flat()))
}

function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(legacySources, (source) =>
    fs
      .scan(source.pattern, { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(
        Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
      ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.orElseSucceed(() => []),
  )
}

function decode(file: { directory: string; filepath: string; primary: boolean }, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const name = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "")
  const body = markdown.content.trim()
  const legacy = Object.keys(markdown.data).some((key) => !agentKeys.has(key))
  // Join legacy model + variant without sending native request/permissions through migration.
  // Embedded and structured native selections, and a variant without a model, stay unchanged.
  const data =
    typeof markdown.data.model === "string" &&
    !markdown.data.model.includes("#") &&
    typeof markdown.data.variant === "string" &&
    /^[^#]+$/.test(markdown.data.variant)
      ? { ...markdown.data, model: `${markdown.data.model}#${markdown.data.variant}` }
      : markdown.data
  const agent = legacy
    ? Option.getOrUndefined(
        Option.map(
          decodeLegacyAgent({ name, ...markdown.data, prompt: body }, { errors: "all" }),
          ConfigMigrateV1.migrateAgent,
        ),
      )
    : Option.getOrUndefined(decodeAgent({ ...data, system: body }, { errors: "all" }))
  if (!agent) return
  const info = Option.getOrUndefined(
    decodeConfig({
      agents: { [name]: file.primary ? { ...agent, mode: "primary" } : agent },
    }),
  )
  if (!info) return
  return new Document({ type: "document", path: AbsolutePath.make(file.filepath), info })
}
