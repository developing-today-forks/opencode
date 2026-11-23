/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { TuiPathsProvider } from "../../src/context/runtime"
import { parsePromptHistory, PromptHistoryProvider, usePromptHistory } from "../../src/prompt/history"
import { parsePromptStash, PromptStashProvider, usePromptStash } from "../../src/prompt/stash"
import { tmpdir } from "../fixture/fixture"

// The prompt history, stash, and frecency JSONL stores live in the machine-
// global state directory, so two TUI processes hold independent in-memory
// snapshots of the same file. These tests mount two providers against one
// state directory (two snapshots, one filesystem) and drive the real mutate
// paths, asserting no writer's entries are dropped by another's rewrite.

function entry(text: string) {
  return { text, files: [], agents: [], pasted: [] }
}

async function waitForFile(file: string, predicate: (text: string) => boolean) {
  let text = ""
  for (const _ of Array.from({ length: 500 })) {
    text = await readFile(file, "utf8").catch(() => "")
    if (predicate(text)) return text
    await Bun.sleep(10)
  }
  return text
}

test("two history writers keep each other's appends", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  const file = path.join(state, "prompt-history.jsonl")

  let a!: ReturnType<typeof usePromptHistory>
  let b!: ReturnType<typeof usePromptHistory>
  function ConsumerA() {
    a = usePromptHistory()
    return <box />
  }
  function ConsumerB() {
    b = usePromptHistory()
    return <box />
  }
  const app = await testRender(() => (
    <TuiPathsProvider value={{ cwd: tmp.path, home: tmp.path, state, worktree: tmp.path }}>
      <box>
        <PromptHistoryProvider>
          <ConsumerA />
        </PromptHistoryProvider>
        <PromptHistoryProvider>
          <ConsumerB />
        </PromptHistoryProvider>
      </box>
    </TuiPathsProvider>
  ))
  await app.renderOnce()
  try {
    a.append(entry("from-a"))
    await waitForFile(file, (text) => text.includes("from-a"))

    b.append(entry("from-b"))
    await waitForFile(file, (text) => text.includes("from-b"))

    // A's in-memory snapshot predates from-b; its append must not drop it.
    a.append(entry("from-a-2"))
    const text = await waitForFile(file, (value) => value.includes("from-a-2"))
    expect(parsePromptHistory(text).map((item) => item.text)).toEqual(["from-a", "from-b", "from-a-2"])
  } finally {
    app.renderer.destroy()
  }
})

test("history trim keeps the other writer's append", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  const file = path.join(state, "prompt-history.jsonl")
  const seeded = Array.from({ length: 50 }, (_, index) => JSON.stringify(entry(`seed-${index}`)))
  await Bun.write(file, seeded.join("\n") + "\n")

  let a!: ReturnType<typeof usePromptHistory>
  let b!: ReturnType<typeof usePromptHistory>
  function ConsumerA() {
    a = usePromptHistory()
    return <box />
  }
  function ConsumerB() {
    b = usePromptHistory()
    return <box />
  }
  const app = await testRender(() => (
    <TuiPathsProvider value={{ cwd: tmp.path, home: tmp.path, state, worktree: tmp.path }}>
      <box>
        <PromptHistoryProvider>
          <ConsumerA />
        </PromptHistoryProvider>
        <PromptHistoryProvider>
          <ConsumerB />
        </PromptHistoryProvider>
      </box>
    </TuiPathsProvider>
  ))
  await app.renderOnce()
  try {
    b.append(entry("from-b"))
    await waitForFile(file, (text) => text.includes("from-b"))

    // A's snapshot is the seeded file; its trim rewrite must keep from-b.
    a.append(entry("from-a"))
    const text = await waitForFile(file, (value) => value.includes("from-a"))
    const texts = parsePromptHistory(text).map((item) => item.text)
    expect(texts).toHaveLength(50)
    expect(texts).toContain("from-b")
    expect(texts).toContain("from-a")
    expect(texts).not.toContain("seed-0")
    expect(texts).not.toContain("seed-1")
  } finally {
    app.renderer.destroy()
  }
})

test("stash pop keeps the other writer's push", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  const file = path.join(state, "prompt-stash.jsonl")

  let a!: ReturnType<typeof usePromptStash>
  let b!: ReturnType<typeof usePromptStash>
  function ConsumerA() {
    a = usePromptStash()
    return <box />
  }
  function ConsumerB() {
    b = usePromptStash()
    return <box />
  }
  const app = await testRender(() => (
    <TuiPathsProvider value={{ cwd: tmp.path, home: tmp.path, state, worktree: tmp.path }}>
      <box>
        <PromptStashProvider>
          <ConsumerA />
        </PromptStashProvider>
        <PromptStashProvider>
          <ConsumerB />
        </PromptStashProvider>
      </box>
    </TuiPathsProvider>
  ))
  await app.renderOnce()
  try {
    a.push({ prompt: entry("a-entry") })
    await waitForFile(file, (text) => text.includes("a-entry"))

    b.push({ prompt: entry("b-entry") })
    const both = await waitForFile(file, (text) => text.includes("b-entry"))
    expect(parsePromptStash(both).map((item) => item.prompt.text)).toEqual(["a-entry", "b-entry"])

    // A's snapshot only holds a-entry; popping it must not drop b-entry.
    expect(a.pop()?.prompt.text).toBe("a-entry")
    const text = await waitForFile(file, (value) => !value.includes("a-entry"))
    expect(parsePromptStash(text).map((item) => item.prompt.text)).toEqual(["b-entry"])
  } finally {
    app.renderer.destroy()
  }
})
