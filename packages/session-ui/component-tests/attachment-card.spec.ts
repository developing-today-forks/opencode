import { expect, sourceURL, story } from "../../stories/playwright/story"

const fixture = sourceURL(new URL("./attachment-card.fixture.tsx", import.meta.url))

// Pins the PR #2489 fix on the surface file and comment attachments share, which had no role assertion.
story("exposes a clickable attachment card as a button and keeps the static card a div", async ({ mount, page }) => {
  await mount("components-markdown--compact-result")
  await page.evaluate(async (fixture) => {
    const { mountAttachmentCard } = await import(fixture)
    mountAttachmentCard()
  }, fixture)

  const root = page.getByTestId("attachment-card-fixture")
  const clickable = root.getByRole("button", { name: "Clickable card File", exact: true })
  await expect(clickable).toBeVisible()
  await expect(clickable).toHaveAccessibleName("Clickable card File")
  await expect(clickable).toHaveAttribute("type", "button")
  await expect(clickable).toHaveAttribute("data-clickable", "true")
  // The element itself must be a real <button>: the role attribute alone would
  // also match a div carrying role="button", which is what PR #2489 replaced.
  expect(await clickable.evaluate((element) => element.tagName)).toBe("BUTTON")

  // The fix was about keyboard access, so a div with a click handler must not satisfy this.
  await clickable.focus()
  await expect(clickable).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(root.getByTestId("attachment-card-clicks")).toHaveText("1")

  const staticCard = root.locator('[data-component="attachment-card"]').filter({ hasText: "Static card" })
  await expect(staticCard).toHaveCount(1)
  expect(await staticCard.evaluate((element) => element.tagName)).toBe("DIV")
  await expect(staticCard).not.toHaveAttribute("data-clickable")
  await expect(root.getByRole("button", { name: "Static card File", exact: true })).toHaveCount(0)
})
