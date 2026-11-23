import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { isServer, render } from "solid-js/web"
import { LineCommentEditor } from "./line-comment"

beforeAll(() => GlobalRegistrator.register())

afterAll(() => GlobalRegistrator.unregister())

// The name a control gets from aria-labelledby (accName): the referenced
// elements' text, in order, whitespace-normalized. Happy-DOM does not compute
// accessible names, so resolve the labeling relationship directly.
function accessibleName(el: HTMLElement): string {
  const labelledby = el.getAttribute("aria-labelledby")
  if (labelledby) {
    return labelledby
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
  }

  return el.getAttribute("aria-label") ?? ""
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim()
}

// Renders the editor the way line-comment-annotations mounts it: inline, with
// a controlled value and the selection being commented on. The draft flow
// starts from an empty value; the existing-comment edit flow starts from the
// saved comment text. Both mount this same editor.
function setup(props: { value: string; selection: string }) {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <LineCommentEditor
        inline
        value={props.value}
        selection={props.selection}
        onInput={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    ),
    root,
  )

  return {
    root,
    dispose: () => {
      dispose()
      root.remove()
    },
  }
}

function parts(root: HTMLElement) {
  return {
    textarea: root.querySelector<HTMLTextAreaElement>("textarea[data-slot='line-comment-textarea']"),
    label: root.querySelector<HTMLElement>("[data-slot='line-comment-editor-label']"),
  }
}

// Solid's server build cannot render, so this runs with `bun test --conditions=browser`
// (the same convention as the placement-reactivity tests in this package).
describe.skipIf(isServer)("LineCommentEditor accessible name", () => {
  test("names the draft editor's textarea with the visible selection context", () => {
    const { root, dispose } = setup({ value: "", selection: "L40" })
    const { textarea, label } = parts(root)

    expect(textarea).not.toBeNull()
    expect(label).not.toBeNull()
    expect(text(label)).toBe("Commenting on L40")
    expect(label?.id).not.toBe("")
    expect(textarea?.getAttribute("aria-labelledby")).toBe(label?.id)
    expect(accessibleName(textarea!)).toBe(text(label))
    expect(accessibleName(textarea!)).not.toBe(textarea?.getAttribute("placeholder"))
    dispose()
  })

  test("names the existing-comment edit editor's textarea the same way", () => {
    const { root, dispose } = setup({ value: "Consider guarding against empty arrays.", selection: "L12-L13" })
    const { textarea, label } = parts(root)

    expect(textarea).not.toBeNull()
    expect(textarea?.value).toBe("Consider guarding against empty arrays.")
    expect(text(label)).toBe("Commenting on L12-L13")
    expect(textarea?.getAttribute("aria-labelledby")).toBe(label?.id)
    expect(accessibleName(textarea!)).toBe(text(label))
    dispose()
  })

  test("gives each mounted editor its own label id", () => {
    const first = setup({ value: "", selection: "L40" })
    const second = setup({ value: "", selection: "L41" })
    const a = parts(first.root)
    const b = parts(second.root)

    expect(a.label?.id).not.toBe("")
    expect(b.label?.id).not.toBe("")
    expect(a.label?.id).not.toBe(b.label?.id)
    expect(accessibleName(a.textarea!)).toBe("Commenting on L40")
    expect(accessibleName(b.textarea!)).toBe("Commenting on L41")
    first.dispose()
    second.dispose()
  })
})
