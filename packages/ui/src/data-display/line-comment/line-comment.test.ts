import { describe, expect, test } from "bun:test"
import {
  createLineCommentEditorState,
  mentionListbox,
  parseMentionToken,
  transitionLineCommentEditor,
  viewLineCommentEditor,
  type LineCommentEditorConfig,
  type LineCommentEditorEvent,
  type LineCommentEditorKey,
  type LineCommentEditorState,
} from "./machine"

// These tests pin the rendered semantics of the mention popup in both line-comment
// editors. The editors render their textarea, listbox and options straight from
// `mentionListbox(viewLineCommentEditor(state, config), id)`, so driving the real
// machine and reading that derivation asserts what ends up in the DOM: the listbox
// role and id, the option ids, aria-selected, and the textarea's aria-expanded,
// aria-controls and aria-activedescendant.

const config = (patch: Partial<LineCommentEditorConfig> = {}): LineCommentEditorConfig => ({
  value: "",
  allowEmpty: false,
  variant: "compact",
  alternateSubmit: null,
  submitting: false,
  ...patch,
})

// The token the driver reads from the textarea with the caret at the end of `value`.
const typed = (value: string): LineCommentEditorEvent => ({
  type: "mention.synced",
  token: parseMentionToken(value, value.length, value.length),
})

const key = (
  name: string,
  settings: LineCommentEditorConfig,
  patch: Partial<Omit<LineCommentEditorKey, "key">> = {},
): LineCommentEditorEvent => ({
  type: "key.down",
  target: "textarea",
  key: name,
  ctrl: false,
  meta: false,
  alt: false,
  shift: false,
  repeat: false,
  ...patch,
  config: settings,
})

function run(state: LineCommentEditorState, ...events: LineCommentEditorEvent[]) {
  return events.reduce((current, event) => transitionLineCommentEditor(current, event).state, state)
}

// What the editors render for `state`: the listbox derivation plus the view behind it.
const rendered = (state: LineCommentEditorState, settings: LineCommentEditorConfig) => {
  const view = viewLineCommentEditor(state, settings)
  return { view, listbox: mentionListbox(view, "editor") }
}

const opened = (items: string[]) => {
  const settings = config({ value: "@src" })
  const state = run(createLineCommentEditorState(), typed("@src"), {
    type: "mention.loaded",
    attempt: 1,
    items,
  })
  return { settings, state }
}

describe("line comment mention listbox", () => {
  test("closed while editing: not expanded, no active option", () => {
    const { view, listbox } = rendered(createLineCommentEditorState(), config())

    expect(view.mentionItems).toEqual([])
    expect(listbox.open).toBe(false)
    expect(listbox.activeOptionId).toBeUndefined()
    expect(listbox.selected("src/a.ts")).toBe(false)
  })

  test("open: the listbox and its options carry stable ids and the first option is active", () => {
    const { settings, state } = opened(["src/a.ts", "src/b.ts", "src/c.ts"])
    const { view, listbox } = rendered(state, settings)

    expect(view.mentionItems).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
    expect(listbox.open).toBe(true)
    expect(listbox.listboxId).toBe("editor-mention-listbox")
    expect(listbox.optionId(0)).toBe("editor-mention-listbox-option-0")
    expect(listbox.optionId(2)).toBe("editor-mention-listbox-option-2")

    // The textarea announces the open listbox and its active option.
    expect(listbox.activeOptionId).toBe(listbox.optionId(0))
    expect(listbox.selected("src/a.ts")).toBe(true)
    expect(listbox.selected("src/b.ts")).toBe(false)
    expect(listbox.selected("src/c.ts")).toBe(false)
  })

  test("arrow navigation moves the announced active option and aria-selected with it", () => {
    const { settings, state } = opened(["src/a.ts", "src/b.ts", "src/c.ts"])

    const down = run(state, key("ArrowDown", settings))
    const afterDown = rendered(down, settings)
    expect(afterDown.view.activeMentionPath).toBe("src/b.ts")
    expect(afterDown.listbox.activeOptionId).toBe(afterDown.listbox.optionId(1))
    expect(afterDown.listbox.selected("src/b.ts")).toBe(true)
    expect(afterDown.listbox.selected("src/a.ts")).toBe(false)

    // Ctrl+n is the other forward-navigation key the machine accepts.
    const ctrlN = run(down, key("n", settings, { ctrl: true }))
    const afterCtrlN = rendered(ctrlN, settings)
    expect(afterCtrlN.listbox.activeOptionId).toBe(afterCtrlN.listbox.optionId(2))
    expect(afterCtrlN.listbox.selected("src/c.ts")).toBe(true)

    // Navigation wraps: past the last option the announcement returns to the first.
    const wrapped = run(ctrlN, key("ArrowDown", settings))
    const afterWrap = rendered(wrapped, settings)
    expect(afterWrap.listbox.activeOptionId).toBe(afterWrap.listbox.optionId(0))
    expect(afterWrap.listbox.selected("src/a.ts")).toBe(true)
  })

  test("the previous list stays announced while a refined query loads", () => {
    const { settings, state } = opened(["src/a.ts", "src/b.ts"])
    const refining = run(state, typed("@src/b"))
    const { view, listbox } = rendered(refining, settings)

    expect(refining.status).toBe("mention-loading")
    expect(view.mentionItems).toEqual(["src/a.ts", "src/b.ts"])
    expect(listbox.open).toBe(true)
    expect(listbox.activeOptionId).toBe(listbox.optionId(0))
  })

  test("escape closes the listbox: nothing expanded, nothing announced", () => {
    const { settings, state } = opened(["src/a.ts", "src/b.ts"])
    const closed = run(state, key("Escape", settings))
    const { view, listbox } = rendered(closed, settings)

    expect(view.mentionItems).toEqual([])
    expect(listbox.open).toBe(false)
    expect(listbox.activeOptionId).toBeUndefined()
  })

  test("hovering an option makes it the announced one", () => {
    const { settings, state } = opened(["src/a.ts", "src/b.ts", "src/c.ts"])
    const hovered = run(state, { type: "mention.hovered", index: 2 })
    const { listbox } = rendered(hovered, settings)

    expect(listbox.activeOptionId).toBe(listbox.optionId(2))
    expect(listbox.selected("src/c.ts")).toBe(true)
    expect(listbox.selected("src/a.ts")).toBe(false)
  })
})
