import { expect, test } from "bun:test"
import path from "node:path"
import { renderLocal } from "../fixture/local"

// Oracle: the on-disk session.json bytes. A pin change may only replace them
// when the previous content was read successfully (or the file was absent).
async function waitForSessionReady(ready: () => boolean | Promise<boolean>) {
  const started = Date.now()
  while (!(await ready())) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for session pin store to load")
    await Bun.sleep(10)
  }
}

test("refuses to overwrite a truncated session.json on pin change", async () => {
  const corrupt = `{"pinned":["ses_11111111111111111111111111","ses_22222222222222222222222222"]`
  await using fixture = await renderLocal({ sessionJson: corrupt })
  await waitForSessionReady(() => fixture.local.session.ready)

  expect(() => fixture.local.session.togglePin("ses_33333333333333333333333333")).toThrow(
    /Refusing to overwrite unreadable session pin store .*session\.json/,
  )
  expect(await Bun.file(path.join(fixture.state, "session.json")).text()).toBe(corrupt)
})

test("starts from an empty pin list when session.json is missing", async () => {
  await using fixture = await renderLocal()
  await waitForSessionReady(() => fixture.local.session.ready)

  fixture.local.session.togglePin("ses_11111111111111111111111111")
  expect(fixture.local.session.pinned()).toEqual(["ses_11111111111111111111111111"])
  await waitForSessionReady(async () => {
    const file = Bun.file(path.join(fixture.state, "session.json"))
    if (!(await file.exists())) return false
    return JSON.stringify(await file.json()) === JSON.stringify({ pinned: ["ses_11111111111111111111111111"] })
  })
})

test("loads a valid session.json and round-trips pin changes", async () => {
  await using fixture = await renderLocal({
    sessionJson: JSON.stringify({ pinned: ["ses_11111111111111111111111111"] }),
  })
  await waitForSessionReady(() => fixture.local.session.ready)

  expect(fixture.local.session.pinned()).toEqual(["ses_11111111111111111111111111"])
  fixture.local.session.togglePin("ses_11111111111111111111111111")
  expect(fixture.local.session.pinned()).toEqual([])
  await waitForSessionReady(async () => {
    const file = Bun.file(path.join(fixture.state, "session.json"))
    if (!(await file.exists())) return false
    return JSON.stringify(await file.json()) === JSON.stringify({ pinned: [] })
  })
})

test("reports a deferred pin save refusal on the toast surface", async () => {
  const corrupt = `{"pinned":["ses_11111111111111111111111111"`
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => rejections.push(reason)
  process.on("unhandledRejection", onRejection)
  try {
    let readyAtToggle: boolean | undefined
    await using fixture = await renderLocal({
      sessionJson: corrupt,
      onMount(local) {
        readyAtToggle = local.session.ready
        // Before the store loads, the save is deferred to the load chain.
        local.session.togglePin("ses_33333333333333333333333333")
      },
    })
    await waitForSessionReady(() => fixture.local.session.ready)
    await waitForSessionReady(() => fixture.toast.currentToast !== null)

    expect(readyAtToggle).toBe(false)
    expect(fixture.toast.currentToast?.variant).toBe("error")
    expect(fixture.toast.currentToast?.message).toMatch(/Refusing to overwrite unreadable session pin store/)
    expect(await Bun.file(path.join(fixture.state, "session.json")).text()).toBe(corrupt)
    await Bun.sleep(20)
    expect(rejections).toEqual([])
  } finally {
    process.off("unhandledRejection", onRejection)
  }
})
