export * as MessagingLog from "./log.js"

import { DateTime } from "effect"
import type { Messaging } from "@opencode/schema/messaging"
import type { SessionMessage } from "../session/message.js"

/** Parts shown when a log request does not choose: what a reader of the conversation would see. */
export const defaultParts: ReadonlyArray<Messaging.LogPart> = ["user", "output", "tools", "synthetic"]

export interface Entry {
  readonly session: string
  readonly message: string
  readonly index: number
  readonly part: Messaging.LogPart
  readonly time: number
  /** The searchable content. */
  readonly text: string
  /** Display prefix kept out of search, such as the sender of a delivered message. */
  readonly label?: string
  readonly tool?: string
}

const millis = (time: DateTime.Utc) => DateTime.toEpochMillis(time)

/** Flattens one session's messages into ordered log entries for the requested parts. */
export function entries(
  session: string,
  messages: ReadonlyArray<SessionMessage.Info>,
  parts: ReadonlySet<Messaging.LogPart>,
): Entry[] {
  return messages.flatMap((message) => {
    const time = millis(message.time.created)
    const entry = (index: number, part: Messaging.LogPart, text: string, tool?: string, label?: string): Entry[] =>
      parts.has(part) && text.trim() !== ""
        ? [
            {
              session,
              message: message.id,
              index,
              part,
              time,
              text,
              ...(tool ? { tool } : {}),
              ...(label ? { label } : {}),
            },
          ]
        : []
    switch (message.type) {
      case "user":
        return entry(
          0,
          "user",
          [
            message.text,
            ...(message.files ?? []).flatMap((file) => [
              `[file: ${file.name ?? (file.source.type === "uri" ? file.source.uri : "attachment")}]`,
              file.description,
              ...(file.mime === "text/plain" || file.mime === "application/x-directory"
                ? [Buffer.from(file.data, "base64").toString("utf8")]
                : []),
            ]),
            ...(message.agents ?? []).map((agent) => `[agent: ${agent.name}]`),
            ...(message.skills ?? []).flatMap((skill) => [`[skill: ${skill.name}]`, skill.text]),
          ]
            .filter(Boolean)
            .join("\n"),
        )
      case "synthetic": {
        const notice = synthetic(message)
        return entry(0, "synthetic", notice.text, undefined, notice.label)
      }
      case "system":
        return entry(0, "system", message.text)
      case "skill":
        return entry(0, "system", `[skill ${message.name}]\n${message.text}`)
      case "shell":
        return entry(0, "shell", `$ ${message.command}\n${message.output?.output ?? ""}`.trimEnd())
      case "compaction":
        return entry(
          0,
          "compaction",
          message.status === "failed"
            ? `[compaction failed: ${message.error.message}]`
            : [message.summary, message.recent].filter(Boolean).join("\n\n"),
        )
      case "agent-switched":
        return entry(0, "events", `[agent ${message.previous ? `${message.previous} → ` : ""}${message.agent}]`)
      case "model-switched":
        return entry(0, "events", `[model ${message.model.providerID}/${message.model.id}]`)
      case "location-switched":
        return entry(0, "events", `[moved to ${message.location.directory}]`)
      case "idle":
        return entry(0, "events", `[idle: ${message.outcome}${message.error ? ` (${message.error.message})` : ""}]`)
      case "assistant":
        return message.content.flatMap((item, index) => {
          if (item.type === "text") return entry(index, "output", item.text)
          if (item.type === "reasoning") return entry(index, "thinking", item.text)
          const call = entry(
            index,
            "tools",
            `${item.name}(${serialize(item.state.input)}) → ${item.state.status}`,
            item.name,
          )
          const result =
            item.state.status === "completed"
              ? contentText(item.state.content)
              : item.state.status === "error"
                ? `error: ${item.state.error.message}${item.state.content ? `\n${contentText(item.state.content)}` : ""}`
                : ""
          return [...call, ...entry(index, "results", result, item.name)]
        })
    }
  })
}

function contentText(
  content: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly name?: string }>,
) {
  return content
    .map((item) => (item.type === "text" ? (item.text ?? "") : `[${item.type}${item.name ? `: ${item.name}` : ""}]`))
    .join("\n")
}

/**
 * Delivered messages wrap their body in `<message …>` attributes for the model; the log shows the sender, topic
 * and body instead, so text and semantic search match the message rather than its envelope.
 */
function synthetic(message: SessionMessage.Synthetic) {
  const metadata = message.metadata
  const envelope = /^<message\b(?:[^>"]|"[^"]*")*>\n([\s\S]*?)\n<\/message>\s*$/.exec(message.text)?.[1]
  const body = envelope === undefined ? undefined : unescapeBody(envelope)
  if (metadata?.source === "messaging" && body !== undefined) {
    const from = typeof metadata.from === "string" ? metadata.from : "unknown"
    const topic = typeof metadata.topic === "string" ? ` → ${metadata.topic}` : ""
    return { text: body, label: `✉ ${from}${topic}` }
  }
  return { text: message.description ? `${message.description}\n${message.text}` : message.text }
}

/** The complete tool input, so grep and search see every argument; entries are clipped only when returned. */
function serialize(input: unknown) {
  return typeof input === "string" ? input : JSON.stringify(input)
}

/**
 * Keeps a delivered body from closing its envelope or opening a forged one, reversibly: message tags become
 * `&lt;message`, and an ampersand that already starts `&lt;` or `&amp;` is escaped first, so `unescapeBody` restores
 * the exact text. Other ampersands stay as written.
 */
export function escapeBody(value: string) {
  return value.replace(/&(?=(?:amp|lt);)/g, "&amp;").replace(/<(\/?message\b)/gi, "&lt;$1")
}

/**
 * The text `escapeBody` encoded. The tag keeps the case it was written in; the entities are matched exactly as the
 * encoder writes them, so a writer's own `&LT;message` stays as written.
 */
export function unescapeBody(value: string) {
  return value
    .replace(/&lt;(\/?message\b)/gi, (match, tag: string) => (match.startsWith("&lt;") ? `<${tag}` : match))
    .replace(/&amp;(?=(?:amp|lt);)/g, "&")
}

/**
 * A cut at `index` splits a surrogate pair when the code unit before it is a
 * high surrogate and the one at it is that pair's low half: keeping either
 * side alone leaves ill-formed text that re-encodes as U+FFFD (#1966). The
 * house rule is to never split a pair (messaging/search.ts, session
 * compaction), so a straddling pair is dropped whole instead.
 */
const splitsPair = (text: string, index: number) =>
  index > 0 &&
  index < text.length &&
  text.charCodeAt(index - 1) >= 0xd800 &&
  text.charCodeAt(index - 1) <= 0xdbff &&
  text.charCodeAt(index) >= 0xdc00 &&
  text.charCodeAt(index) <= 0xdfff

/** Shortens long entries to a head and tail around an omission marker. */
export function clip(text: string, chars: number) {
  if (text.length <= chars) return text
  let head = Math.ceil(chars * 0.7)
  let tail = Math.max(0, chars - head - 20)
  // Drop a pair straddling the tail cut whole: the kept tail starts one
  // code unit later, and the marker below counts it as omitted.
  if (tail > 0 && splitsPair(text, text.length - tail)) tail -= 1
  // The 20-char reserve above only shrinks the tail: when the tail has
  // already clamped to 0 the marker itself can push the result past
  // `chars`, so shrink the head by the overflow instead. If the marker
  // alone exceeds the budget, fall back to a plain truncation.
  let marker = ` …[${text.length - head - tail} chars]… `
  while (head > 0 && head + marker.length + tail > chars) {
    head -= 1
    marker = ` …[${text.length - head - tail} chars]… `
  }
  // The shrink loop can land the head cut inside a pair (or start there):
  // drop the pair whole and recount the omission. The result only shrinks,
  // so the budget still holds.
  if (splitsPair(text, head)) {
    head -= 1
    marker = ` …[${text.length - head - tail} chars]… `
  }
  if (head + marker.length + tail > chars) return text.slice(0, splitsPair(text, chars) ? chars - 1 : chars)
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`
}
