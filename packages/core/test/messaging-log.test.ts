import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { MessagingLog } from "@opencode/core/messaging/log"
import { SessionMessage } from "@opencode/core/session/message"

const decode = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Info))

const messages = decode([
  { id: "msg_1", type: "user", time: { created: 1_000 }, text: "Please fix the parser" },
  {
    id: "msg_2",
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    time: { created: 2_000 },
    content: [
      { type: "reasoning", text: "The tokenizer drops the last token", time: { created: 2_000 } },
      { type: "text", text: "Fixed the off-by-one in the tokenizer." },
      {
        type: "tool",
        id: "call_1",
        name: "edit",
        state: {
          status: "completed",
          input: { path: "parser.ts" },
          content: [{ type: "text", text: "Edited parser.ts" }],
        },
        time: { created: 2_000 },
      },
    ],
  },
  { id: "msg_3", type: "system", time: { created: 3_000 }, text: "The instructions changed" },
  {
    id: "msg_4",
    type: "synthetic",
    time: { created: 4_000 },
    text: '<message topic="ses_a/bidi/ses_b" seq="1" from="ses_b" time="x">\nAre the tests green?\n</message>',
    description: "✉ Worker → ses_a/bidi/ses_b: Are the tests green?",
    metadata: { source: "messaging", from: "ses_b", topic: "ses_a/bidi/ses_b" },
  },
  { id: "msg_5", type: "idle", time: { created: 5_000 }, outcome: "succeeded" },
])

const parts = (included: ReadonlyArray<MessagingLog.Entry["part"]>) =>
  MessagingLog.entries("ses_a", messages, new Set(included)).map((entry) => [entry.part, entry.text, entry.label])

describe("MessagingLog.entries", () => {
  test("splits a transcript into parts that can be included or left out", () => {
    expect(parts(MessagingLog.defaultParts)).toEqual([
      ["user", "Please fix the parser", undefined],
      ["output", "Fixed the off-by-one in the tokenizer.", undefined],
      ["tools", 'edit({"path":"parser.ts"}) → completed', undefined],
      ["synthetic", "Are the tests green?", "✉ ses_b → ses_a/bidi/ses_b"],
    ])
    expect(parts(["thinking", "results", "system", "events"])).toEqual([
      ["thinking", "The tokenizer drops the last token", undefined],
      ["results", "Edited parser.ts", undefined],
      ["system", "The instructions changed", undefined],
      ["events", "[idle: succeeded]", undefined],
    ])
  })

  test("keeps every tool argument searchable", () => {
    const [long] = decode([
      {
        id: "msg_6",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        time: { created: 6_000 },
        content: [
          {
            type: "tool",
            id: "call_2",
            name: "edit",
            state: {
              status: "completed",
              input: { oldString: "x".repeat(400), newString: "needle" },
              content: [{ type: "text", text: "Edited" }],
            },
            time: { created: 6_000 },
          },
        ],
      },
    ])
    const [entry] = MessagingLog.entries("ses_a", long ? [long] : [], new Set(["tools"]))
    expect(entry?.text).toContain('"newString":"needle"')
  })

  test("decodes a delivered body back to the text as written", () => {
    const written =
      'Quote: <message from="x"> </MESSAGE> <Message> and the literal &lt;message, &LT;Message, &amp;lt; and R&D'
    const [delivered] = decode([
      {
        id: "msg_7",
        type: "synthetic",
        time: { created: 7_000 },
        text: `<message topic="t" seq="1" from="ses_b" from_title="Multiline\nsender > title">\n${MessagingLog.escapeBody(written)}\n</message>`,
        metadata: { source: "messaging", from: "ses_b", topic: "t" },
      },
    ])
    const [entry] = MessagingLog.entries("ses_a", delivered ? [delivered] : [], new Set(["synthetic"]))
    expect(entry?.text).toBe(written)
  })

  test("keeps decoded text and directory attachments searchable without decoding binary files", () => {
    const entries = MessagingLog.entries(
      "ses_a",
      decode([
        {
          id: "msg_8",
          type: "user",
          time: { created: 8_000 },
          text: "Review the attachments",
          files: [
            {
              name: "notes.txt",
              mime: "text/plain",
              data: Buffer.from("text-only needle").toString("base64"),
              source: { type: "inline" },
              description: "File description",
            },
            {
              name: "src",
              mime: "application/x-directory",
              data: Buffer.from("directory-only.ts").toString("base64"),
              source: { type: "uri", uri: "file:///project/src" },
            },
            {
              name: "image.png",
              mime: "image/png",
              data: Buffer.from("binary bytes").toString("base64"),
              source: { type: "inline" },
            },
          ],
          skills: [{ id: "skill", name: "Review", text: "Skill instructions" }],
        },
      ]),
      new Set(["user"]),
    )
    expect(entries.map((entry) => entry.text)).toEqual([
      "Review the attachments\n[file: notes.txt]\nFile description\ntext-only needle\n[file: src]\ndirectory-only.ts\n[file: image.png]\n[skill: Review]\nSkill instructions",
    ])
  })

  test("keeps the summary and retained recent context searchable in a compaction entry", () => {
    const entries = MessagingLog.entries(
      "ses_a",
      decode([
        {
          id: "msg_9",
          type: "compaction",
          status: "completed",
          reason: "auto",
          time: { created: 9_000 },
          summary: "Earlier work",
          recent: "Retained recent needle",
        },
        {
          id: "msg_10",
          type: "compaction",
          status: "completed",
          reason: "auto",
          time: { created: 10_000 },
          summary: "Only the summary",
          recent: "",
        },
      ]),
      new Set(["compaction"]),
    )
    expect(entries.map((entry) => entry.text)).toEqual(["Earlier work\n\nRetained recent needle", "Only the summary"])
  })

  test("clips long entries around an omission marker", () => {
    const clipped = MessagingLog.clip("a".repeat(500) + "b".repeat(500), 100)
    expect(clipped.length).toBeLessThan(140)
    expect(clipped.startsWith("a".repeat(70))).toBe(true)
    expect(clipped.endsWith("b".repeat(10))).toBe(true)
    expect(clipped).toContain("chars]")
  })

  test("clip never exceeds its maximum at small limits", () => {
    const text = "a".repeat(500) + "b".repeat(500)
    for (const chars of [1, 10, 20, 30, 40, 50, 100]) {
      expect(MessagingLog.clip(text, chars).length).toBeLessThanOrEqual(chars)
    }
  })

  test("clip keeps the omitted count accurate when the head shrinks to fit the marker", () => {
    const clipped = MessagingLog.clip("a".repeat(1000), 30)
    expect(clipped.length).toBe(30)
    expect(clipped).toContain("[985 chars]")
  })

  test("clip truncates plainly when the omission marker alone exceeds the limit", () => {
    expect(MessagingLog.clip("a".repeat(100), 10)).toBe("a".repeat(10))
  })

  // Oracle (#1966): the house no-split rule (messaging/search.ts trigrams,
  // session compaction) — a cut that lands inside a surrogate pair drops the
  // pair whole, so clipped text is always well-formed.
  test("clip never splits a surrogate pair at the head cut", () => {
    const astral = "\u{1D11E}"
    for (const chars of [50, 60, 100]) {
      const head = Math.ceil(chars * 0.7)
      const clipped = MessagingLog.clip("a".repeat(head - 1) + astral + "b".repeat(200), chars)
      expect(clipped.isWellFormed()).toBe(true)
      expect(clipped).not.toContain(astral)
      expect(clipped.length).toBeLessThanOrEqual(chars)
    }
  })

  test("clip never splits a surrogate pair at the tail cut", () => {
    const astral = "\u{1D11E}"
    for (const chars of [70, 71, 72, 73]) {
      const clipped = MessagingLog.clip("a".repeat(300) + astral, chars)
      expect(clipped.isWellFormed()).toBe(true)
      expect(clipped).not.toContain(astral)
      expect(clipped.length).toBeLessThanOrEqual(chars)
    }
  })

  test("clip never splits a surrogate pair in the plain-truncation fallback", () => {
    const astral = "\u{1D11E}"
    const clipped = MessagingLog.clip("a".repeat(9) + astral + "b".repeat(100), 10)
    expect(clipped).toBe("a".repeat(9))
    expect(clipped.isWellFormed()).toBe(true)
  })

  test("clip output is well-formed and within budget for astral text at every budget", () => {
    const text = ("x\u{1F600}y".repeat(120) + "z".repeat(37)).repeat(3)
    for (let chars = 1; chars <= 200; chars++) {
      const clipped = MessagingLog.clip(text, chars)
      expect(clipped.isWellFormed()).toBe(true)
      expect(clipped.length).toBeLessThanOrEqual(chars)
    }
  })
})
