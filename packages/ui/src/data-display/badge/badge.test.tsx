import { describe, expect, test } from "bun:test"
import { isServer, render } from "solid-js/web"
import { Badge } from "./badge"

// Solid's server build cannot render, so this runs with `bun test --conditions=browser`
// (the same convention as session-ui's placement-reactivity tests).
describe.skipIf(isServer)("Badge", () => {
  test("renders children with default appearance and variant", () => {
    const root = document.createElement("div")
    const dispose = render(() => <Badge>hello</Badge>, root)

    const el = root.querySelector("[data-component='tag']")
    expect(el).not.toBeNull()
    expect(el?.tagName).toBe("SPAN")
    expect(el?.getAttribute("data-appearance")).toBe("compact")
    expect(el?.getAttribute("data-variant")).toBe("neutral")
    expect(el?.textContent).toBe("hello")
    dispose()
  })

  test("renders the requested appearance and variant", () => {
    const root = document.createElement("div")
    const dispose = render(
      () => (
        <Badge appearance="standard" variant="danger">
          alert
        </Badge>
      ),
      root,
    )

    const el = root.querySelector("[data-component='tag']")
    expect(el?.getAttribute("data-appearance")).toBe("standard")
    expect(el?.getAttribute("data-variant")).toBe("danger")
    expect(el?.textContent).toBe("alert")
    dispose()
  })
})
