import { describe, expect, test } from "bun:test"
import path from "path"
import { parse } from "../src/highlights"

describe("highlights", () => {
  test("parses the v2.0.27 release notes", async () => {
    const changelog = await Bun.file(path.resolve(import.meta.dir, "../../../CHANGELOG.md")).text()
    const notes = changelog.split(/^## v2\.0\.27 .*$/m)[1].split(/^## /m)[0]
    const result = parse(notes)

    expect(result.problems).toEqual([])
    expect(result.items.map((item) => item.title)).toEqual([
      "Built-In Worktree Tools",
      "Safer Remote Pairing",
      "Installable Web App",
      "Clear Session Failures",
      "Automatic Project Cleanup",
    ])
    expect(result.items[0].body).toBe(
      "Ask OpenCode to use `worktree_create`, `worktree_list`, and `worktree_remove` in Code Mode. You can create " +
        "isolated worktrees, move sessions into them, and remove them with normal edit approval.",
    )
    expect(result.items[2].body).toBe(
      "Use Chrome or Edge’s Install button to install the OpenCode web app, including when it runs behind an " +
        "authenticating proxy.",
    )
    expect(result.items.some((item) => item.body.includes("github.com") || item.body.includes("(["))).toBe(false)
  })

  test("joins wrapped lines and drops multiple trailing links", () => {
    const result = parse(
      [
        "### Highlights",
        "",
        "- **Reopen Closed Tabs:** Right-click the new-session button to bring back a session you closed by",
        "  mistake. ([#123](https://github.com/anomalyco/opencode/pull/123), [#124](https://github.com/anomalyco/opencode/pull/124))",
        "* **Faster [Search](https://example.com)**: Results now stream in.",
        "",
        "### Core",
        "",
        "- **Not a Highlight**: Ignored.",
      ].join("\n"),
    )

    expect(result).toEqual({
      items: [
        {
          title: "Reopen Closed Tabs",
          body: "Right-click the new-session button to bring back a session you closed by mistake.",
        },
        { title: "Faster Search", body: "Results now stream in." },
      ],
      problems: [],
    })
  })

  test("returns nothing without a Highlights section", () => {
    expect(parse("### Core\n\n- Fixed a bug.")).toEqual({ items: [], problems: [] })
  })

  test("reports malformed highlights instead of failing", () => {
    const result = parse("### Highlights\n\n- Plain bullet without a title.\n")
    expect(result.items).toEqual([])
    expect(result.problems).toHaveLength(2)
  })

  test("limits the number and length of highlights", () => {
    const result = parse(
      [
        "### Highlights",
        ...Array.from({ length: 7 }, (_, index) => `- **Item ${index}**: ${"word ".repeat(100)}`),
      ].join("\n"),
    )

    expect(result.items).toHaveLength(5)
    expect(result.items[0].body.length).toBeLessThanOrEqual(300)
    expect(result.items[0].body.endsWith("…")).toBe(true)
    expect(result.problems).toEqual(["Kept the first 5 of 7 highlights"])
  })
})

describe("highlights truncate surrogate pairs", () => {
  const notes = (title: string, body: string) => "### Highlights\n- **" + title + "**: " + body + "\n"

  test("drops a pair straddling the title limit whole", () => {
    const result = parse(notes("a".repeat(58) + "😀" + " extra words here to pass the limit", "short body"))
    expect(result.problems).toEqual([])
    expect(result.items[0].title).toBe("a".repeat(58) + "…")
    expect(result.items[0].title.isWellFormed()).toBe(true)
  })

  test("drops a pair straddling the body limit whole", () => {
    const result = parse(notes("short title", "b".repeat(298) + "😀" + " tail words to pass the body limit"))
    expect(result.problems).toEqual([])
    expect(result.items[0].body).toBe("b".repeat(298) + "…")
    expect(result.items[0].body.isWellFormed()).toBe(true)
  })

  test("keeps a pair that fits whole before the word-boundary cut", () => {
    const title = "a".repeat(40) + "😀" + " " + "b".repeat(16) + " more words follow here"
    const result = parse(notes(title, "short body"))
    expect(result.items[0].title).toBe("a".repeat(40) + "😀…")
    expect(result.items[0].title.isWellFormed()).toBe(true)
  })

  test("non-straddling truncation is unchanged", () => {
    const result = parse(notes("a".repeat(70), "short body"))
    expect(result.items[0].title).toBe("a".repeat(59) + "…")
    const words = parse(notes("word ".repeat(20).trim(), "short body"))
    expect(words.items[0].title).toBe("word ".repeat(11).trim() + "…")
    expect(words.items[0].title.isWellFormed()).toBe(true)
  })
})
