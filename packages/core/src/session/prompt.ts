export * as SessionPrompt from "./prompt.js"

import { Base64, FileAttachment, Prompt } from "@opencode/schema/prompt"
import { PromptInput } from "@opencode/schema/prompt-input"
import { SessionInbox } from "@opencode/schema/session-inbox"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { Image } from "../image.js"
import { Instance } from "../instance/service.js"
import { Mime } from "../mime.js"
import { Plugin } from "../plugin/service.js"
import { PluginHooks } from "../plugin/hooks.js"
import { Skill } from "../skill.js"
import { AttachmentError, SkillNotFoundError } from "./error.js"

export type Input = {
  text: string
  files?: PromptInput.Prompt["files"]
  agents?: PromptInput.Prompt["agents"]
  skills?: PromptInput.Prompt["skills"]
  metadata?: Record<string, unknown>
  delivery?: SessionInbox.Delivery
}

export const prepare = Effect.fn("SessionPrompt.prepare")(function* (request: {
  session: Session.Info
  messageID: SessionMessage.ID
  input: Input
  /** Renders template variables for skills whose frontmatter opts in with `vars`. */
  render?: (text: string) => Effect.Effect<string>
}) {
  const fs = yield* FSUtil.Service
  const instances = yield* Instance.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const hooks = yield* PluginHooks.Service
    const event = yield* hooks.trigger("session", "prompt", {
      sessionID: request.session.id,
      messageID: request.messageID,
      prompt: structuredClone({
        text: request.input.text,
        files: request.input.files?.slice(),
        agents: request.input.agents?.slice(),
        skills: request.input.skills?.slice(),
      }),
      metadata: structuredClone(request.input.metadata),
      delivery: request.input.delivery ?? "steer",
    })
    const input = event.prompt
    const files = input.files
      ? yield* Effect.forEach(input.files, materializeAttachment, { concurrency: 8 })
      : undefined
    const requested = input.skills
    const selected = yield* Effect.gen(function* () {
      if (!requested?.length) return undefined
      const skillService = yield* Skill.Service
      const prepared = new Map<Skill.ID, Skill.Name>()
      return yield* Effect.forEach(requested, (attachment) =>
        Effect.gen(function* () {
          const name = prepared.get(attachment.id)
          if (name !== undefined) return { id: attachment.id, name, mention: attachment.mention }
          const skill = yield* skillService.get(attachment.id)
          if (!skill) return yield* new SkillNotFoundError({ skill: attachment.id })
          prepared.set(skill.id, skill.name)
          const content = skill.vars && request.render ? yield* request.render(skill.content) : skill.content
          return {
            id: skill.id,
            name: skill.name,
            text: (yield* Skill.prepare(fs, { ...skill, content }).pipe(Effect.orDie)).output,
            mention: attachment.mention,
          }
        }),
      )
    })
    return {
      type: "user",
      payload: SessionInbox.UserPayload.make({
        ...Prompt.make({
          text: input.text,
          agents: input.agents,
          files,
          skills: selected?.length ? selected : undefined,
        }),
        metadata: event.metadata,
      }),
      delivery: SessionInbox.Delivery.make(event.delivery),
    } satisfies SessionInbox.Item
  }).pipe(instances.provide(request.session))
})

const materializeAttachment = Effect.fn("SessionPrompt.materializeAttachment")(function* (
  input: PromptInput.FileAttachment,
) {
  const label = attachmentLabel(input)
  const resolved = input.uri.startsWith("data:")
    ? {
        bytes: yield* decodeDataURL(input.uri, label),
        source: { type: "inline" as const },
        start: undefined,
        end: undefined,
        name: undefined,
        mime: undefined,
      }
    : yield* readFileAttachment(input.uri)
  if (resolved.bytes.byteLength > MAX_ATTACHMENT_BYTES)
    return yield* new AttachmentError({
      uri: label,
      message: `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${label}`,
    })

  const mime = resolved.mime ?? Mime.detect(resolved.bytes)
  const content =
    mime === "text/plain" && resolved.start !== undefined
      ? Buffer.from(
          Buffer.from(resolved.bytes)
            .toString("utf8")
            .split("\n")
            .slice(resolved.start - 1, resolved.end)
            .join("\n"),
        )
      : resolved.bytes
  const normalized = yield* normalizeImageAttachment(input, Buffer.from(content).toString("base64"), mime)
  return FileAttachment.create({
    data: normalized.data,
    mime: normalized.mime,
    source: resolved.source,
    name: input.name ?? resolved.name,
    description: input.description,
    mention: input.mention,
  })
})

const normalizeImageAttachment = Effect.fn("SessionPrompt.normalizeImageAttachment")(function* (
  input: PromptInput.FileAttachment,
  data: string,
  mime: string,
) {
  if (!mime.startsWith("image/")) return { data: Base64.make(data), mime }
  const image = yield* Image.Service
  const label = attachmentLabel(input)
  const content = { uri: label, content: data, encoding: "base64" as const, mime }
  const normalized = yield* image.normalize(label, content).pipe(
    Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)),
    Effect.mapError((error) => new AttachmentError({ uri: label, message: error.message })),
  )
  return { data: Base64.make(normalized.content), mime: normalized.mime }
})

const readFileAttachment = Effect.fn("SessionPrompt.readFileAttachment")(function* (uri: string) {
  const fs = yield* FSUtil.Service
  const url = yield* Effect.try({
    try: () => new URL(uri),
    catch: () => new AttachmentError({ uri, message: `Invalid attachment URI: ${uri}` }),
  })
  if (url.protocol !== "file:")
    return yield* new AttachmentError({ uri, message: `Unsupported attachment URI: ${uri}` })
  const start = positiveInt(url.searchParams.get("start"))
  const end = positiveInt(url.searchParams.get("end"))
  const target = yield* Effect.try({
    try: () => {
      url.search = ""
      url.hash = ""
      return fileURLToPath(url)
    },
    catch: () => new AttachmentError({ uri, message: `Invalid file URI: ${uri}` }),
  })
  const info = yield* fs
    .stat(target)
    .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
  if (info.type === "Directory") {
    const entries = yield* fs
      .readDirectoryEntries(target)
      .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
    return {
      bytes: Buffer.from(
        entries
          .filter((entry) => entry.type === "file" || entry.type === "directory")
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
          .map((entry) => entry.name + (entry.type === "directory" ? path.sep : ""))
          .join("\n"),
      ),
      source: { type: "uri" as const, uri },
      start: undefined,
      end: undefined,
      name: path.basename(target),
      mime: "application/x-directory",
    }
  }
  if (info.type !== "File") return yield* new AttachmentError({ uri, message: `Attachment is not a file: ${uri}` })
  if (Number(info.size) > MAX_ATTACHMENT_BYTES)
    return yield* new AttachmentError({
      uri,
      message: `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${uri}`,
    })
  const bytes = yield* fs
    .readFile(target)
    .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
  return { bytes, source: { type: "uri" as const, uri }, start, end, name: path.basename(target), mime: undefined }
})

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

// A data URL is the whole file; errors and logs must name the attachment, not echo its bytes.
function attachmentLabel(input: PromptInput.FileAttachment) {
  return input.name ?? (input.uri.startsWith("data:") ? "inline attachment" : input.uri)
}

function decodeDataURL(uri: string, label: string) {
  return Effect.try({
    try: () => {
      const comma = uri.indexOf(",")
      if (comma === -1) throw new Error("Invalid data URL")
      const metadata = uri.slice(5, comma)
      const payload = uri.slice(comma + 1)
      if (!metadata.split(";").some((part) => part.toLowerCase() === "base64")) return decodePercentPayload(payload)
      const bytes = Buffer.from(payload, "base64")
      if (bytes.toString("base64") !== payload) throw new Error("Non-canonical base64")
      return bytes
    },
    catch: () => new AttachmentError({ uri: label, message: `Invalid attachment data URL: ${label}` }),
  })
}

// Decode as bytes, not as a URI string: decodeURIComponent decodes percent
// escapes as UTF-8 and throws on valid binary octets such as %FF, which made
// decodeDataURL reject the whole prompt for a valid binary attachment
// (#1539). Each %HH escape becomes exactly one byte; unescaped literal text
// is encoded as UTF-8; a malformed escape is invalid. This mirrors
// decodeFilePayload in v1-migration.bun.ts, which fixed the same bug for
// the migration path (#1529); that module is a Bun entry point, so the
// algorithm is mirrored here rather than imported.
function decodePercentPayload(payload: string) {
  const bytes: number[] = []
  let literal = ""
  const flush = () => {
    if (!literal) return
    for (const byte of new TextEncoder().encode(literal)) bytes.push(byte)
    literal = ""
  }
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] !== "%") {
      literal += payload[i]
      continue
    }
    const hex = payload.slice(i + 1, i + 3)
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error("Invalid data URL")
    flush()
    bytes.push(parseInt(hex, 16))
    i += 2
  }
  flush()
  return Buffer.from(bytes)
}

function positiveInt(value: string | null) {
  // Only plain unsigned decimal spellings are line numbers; anything else
  // (hex, exponent, signed, fractional, whitespace-padded) is treated as absent
  // rather than reinterpreted by Number().
  if (value === null || !/^\d+$/.test(value)) return
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
