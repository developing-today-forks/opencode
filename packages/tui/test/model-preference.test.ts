import { expect, test } from "bun:test"
import path from "node:path"
import { createModelPreferenceRepository, decodeModelPreference } from "../src/model-preference"
import { tmpdir } from "./fixture/fixture"

test("repairs known model preferences and preserves unrelated fields", () => {
  expect(
    decodeModelPreference({
      unrelated: { keep: true },
      recent: [{ providerID: "openai", modelID: "gpt-5", ignored: true }, null],
      favorite: "malformed",
      variant: { "openai/gpt-5": "high", default: "default", invalid: 42 },
    }),
  ).toEqual({
    unrelated: { keep: true },
    recent: [{ providerID: "openai", modelID: "gpt-5" }],
    favorite: [],
    variant: { "openai/gpt-5": "high", default: "default" },
  })
})

test("refuses to overwrite an unparseable model.json", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  const corrupt = `{"recent":[{"providerID":"openai","modelID":"gpt-4"}],"favorite":[{"providerID":"openai","modelID":"gpt-4o"}]`
  await Bun.write(file, corrupt)
  const repository = createModelPreferenceRepository(file)
  // The tolerant read keeps the TUI running on the empty default ...
  expect((await repository.load()).recent).toEqual([])
  // ... but no write may build on it: both entry points refuse with an error ...
  await expect(repository.addRecent({ providerID: "anthropic", modelID: "claude" })).rejects.toThrow(
    /is not valid JSON/,
  )
  await expect(repository.saveVariant({ providerID: "anthropic", modelID: "claude" }, "high")).rejects.toThrow(
    /is not valid JSON/,
  )
  // ... and the original bytes are preserved, not silently overwritten.
  expect(await Bun.file(file).text()).toBe(corrupt)
})

test("starts from the default with no warning when model.json is missing", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  const repository = createModelPreferenceRepository(file)
  expect(await repository.load()).toEqual({ recent: [], favorite: [], variant: {} })
  await repository.addRecent({ providerID: "anthropic", modelID: "claude" })
  expect(await Bun.file(file).json()).toEqual({
    recent: [{ providerID: "anthropic", modelID: "claude" }],
    favorite: [],
    variant: {},
  })
})

test("atomically serializes model preference updates", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  await Bun.write(file, JSON.stringify({ unrelated: "keep", favorite: [], variant: {} }))
  const repository = createModelPreferenceRepository(file)
  const openai = { providerID: "openai", modelID: "org/gpt-5" }
  const anthropic = { providerID: "anthropic", modelID: "claude/sonnet" }

  await Promise.all([
    repository.addRecent(openai),
    repository.saveVariant(openai, "high"),
    repository.saveVariant(anthropic, "low"),
  ])
  expect(await Bun.file(file).json()).toEqual({
    unrelated: "keep",
    recent: [openai],
    favorite: [],
    variant: { "openai/org/gpt-5": "high", "anthropic/claude/sonnet": "low" },
  })

  await repository.saveVariant(openai, "default")
  expect(await repository.resolveVariant(openai)).toBeUndefined()
  expect((await Bun.file(file).json()).variant).toEqual({
    "openai/org/gpt-5": "default",
    "anthropic/claude/sonnet": "low",
  })
})
