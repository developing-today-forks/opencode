import { expect, test } from "@playwright/test"
import { openSession } from "../utils/workspace"

// The V2 custom-provider user story (opencode#2652): from the composer model
// picker, open Connect Provider, add an OpenAI-compatible provider through
// the Custom Provider form, and save it. The save must go through the
// supported APIs only — the provider definition in a config patch that never
// carries the secret, and the key in a separate credential create — and the
// saved provider's model must be selectable immediately and still configured
// after an app reload. The mock server plays the real server's part: a config
// patch for a provider exposes its integration, and storing a key credential
// connects it, so later catalog reads resolve the saved provider.
test("adds a custom provider, selects its model, and keeps it after a reload", async ({ page }) => {
  let configured = false
  let key: string | undefined

  const integrations = () => {
    const list: unknown[] = [
      { id: "opencode", name: "OpenCode", methods: [{ type: "key", label: "API key" }], connections: [] },
    ]

    if (configured) {
      list.push({
        id: "acme",
        name: "Acme",
        methods: [{ type: "key", label: "API key" }],
        connections: key ? [{ type: "credential", id: "cred_mock_acme", label: "API key", method: "key" }] : [],
      })
    }

    return list
  }

  const catalog = () => ({
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: {
          "free-model": {
            id: "free-model",
            name: "Free Model",
            cost: { input: 0, output: 0 },
            limit: { context: 200_000 },
          },
        },
      },
      ...(configured
        ? [
            {
              id: "acme",
              name: "Acme",
              models: {
                "acme-1": {
                  id: "acme-1",
                  name: "Acme 1",
                  cost: { input: 1, output: 1 },
                  limit: { context: 128_000 },
                },
              },
            },
          ]
        : []),
    ],
    connected: ["opencode", ...(key ? ["acme"] : [])],
    default: { providerID: "opencode", modelID: "free-model" },
  })

  await openSession(page, {
    name: "CustomProvider",
    provider: catalog,
    integrations,
    onConfigUpdate: ({ providerIDs }) => {
      if (providerIDs.includes("acme")) configured = true
    },
    onCredentialCreate: (input) => {
      if (input.key) key = input.key
    },
  })

  const modelControl = page.locator('[data-component="composer"] [data-action="composer-model"]')
  await modelControl.click()
  // The model drawer offers "Connect provider" directly, or — in its
  // free-tier layout — a "See 70+ more providers" entry that opens the same
  // Connect Provider dialog.
  await page
    .getByRole("button", { name: "Connect provider", exact: true })
    .first()
    .click({ timeout: 5_000 })
    .catch(() => page.getByRole("button", { name: "See 70+ more providers", exact: true }).click())

  // The provider picker always offers the Custom Provider entry.
  await page.getByRole("button", { name: /Custom Provider/ }).click()

  const form = page.getByRole("dialog").filter({ has: page.getByPlaceholder("https://api.example.com/v1") })

  await expect(form).toBeVisible()

  await form.getByLabel("Provider ID", { exact: true }).fill("acme")
  await form.getByLabel("Name", { exact: true }).fill("Acme")
  await form.getByPlaceholder("https://api.example.com/v1").fill("https://api.acme.example/v1")
  await form.getByLabel("API key", { exact: true }).fill("sk-test")
  await form.getByPlaceholder("Model ID", { exact: true }).fill("acme-1")
  await form.getByPlaceholder("Model name", { exact: true }).fill("Acme 1")

  const configPatch = page.waitForRequest(
    (request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/api/experimental/config",
  )

  const credentialPost = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/credential",
  )

  await form.getByRole("button", { name: "Save", exact: true }).click()

  // The definition is persisted without the secret; the key travels separately.
  const patch = (await configPatch).postDataJSON()
  expect(patch).toEqual({
    providers: {
      acme: {
        name: "Acme",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://api.acme.example/v1" },
        models: { "acme-1": { name: "Acme 1" } },
      },
    },
  })
  expect(JSON.stringify(patch)).not.toContain("sk-test")
  expect((await credentialPost).postDataJSON()).toEqual({
    integrationID: "acme",
    value: { type: "key", key: "sk-test" },
  })

  await expect(page.getByText("acme saved", { exact: true })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)

  // After a reload the saved provider is in the catalog: with a paid
  // provider connected, the model chip opens the regular model drawer,
  // which lists the saved provider's model for selection.
  await page.reload()
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  await modelControl.click()
  const picker = page.getByRole("dialog")
  const search = picker.getByPlaceholder("Search models", { exact: true })

  if (await search.isVisible().catch(() => false)) await search.fill("Acme")
  await picker.getByText("Acme 1", { exact: true }).click()
  await expect(modelControl).toContainText("Acme 1")

  // The selection itself survives a reload.
  await page.reload()
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  await expect(modelControl).toContainText("Acme 1")
})

// The failure leg of the same story (opencode#2812): the config stage
// succeeds but storing the API key fails. The dialog must surface the
// partial state — provider saved, key not stored — keep every entered
// value for a retry, and never claim success or close.
test("keeps the form and surfaces the partial state when storing the API key fails", async ({ page }) => {
  let configured = false

  await openSession(page, {
    name: "CustomProviderCredentialFailure",
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "free-model": {
              id: "free-model",
              name: "Free Model",
              cost: { input: 0, output: 0 },
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "free-model" },
    },
    integrations: [{ id: "opencode", name: "OpenCode", methods: [{ type: "key", label: "API key" }], connections: [] }],
    credentialCreateFailures: () => true,
    onConfigUpdate: ({ providerIDs }) => {
      if (providerIDs.includes("acme")) configured = true
    },
  })

  const modelControl = page.locator('[data-component="composer"] [data-action="composer-model"]')
  await modelControl.click()
  await page
    .getByRole("button", { name: "Connect provider", exact: true })
    .first()
    .click({ timeout: 5_000 })
    .catch(() => page.getByRole("button", { name: "See 70+ more providers", exact: true }).click())

  await page.getByRole("button", { name: /Custom Provider/ }).click()

  const form = page.getByRole("dialog").filter({ has: page.getByPlaceholder("https://api.example.com/v1") })

  await expect(form).toBeVisible()

  await form.getByLabel("Provider ID", { exact: true }).fill("acme")
  await form.getByLabel("Name", { exact: true }).fill("Acme")
  await form.getByPlaceholder("https://api.example.com/v1").fill("https://api.acme.example/v1")
  await form.getByLabel("API key", { exact: true }).fill("sk-test")
  await form.getByPlaceholder("Model ID", { exact: true }).fill("acme-1")
  await form.getByPlaceholder("Model name", { exact: true }).fill("Acme 1")

  const configPatch = page.waitForRequest(
    (request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/api/experimental/config",
  )

  const credentialPost = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/credential",
  )

  await form.getByRole("button", { name: "Save", exact: true }).click()

  // Both stages were attempted: the definition (without the secret),
  // then the key as a separate credential create.
  expect(JSON.stringify((await configPatch).postDataJSON())).not.toContain("sk-test")
  expect((await credentialPost).postDataJSON()).toEqual({
    integrationID: "acme",
    value: { type: "key", key: "sk-test" },
  })

  // The partial state is surfaced: the provider was saved, its key was not.
  await expect(
    form.getByText(
      "The provider was saved, but its API key couldn't be stored. Your entries are still here — try again to finish connecting it.",
      { exact: true },
    ),
  ).toBeVisible()
  await expect.poll(() => configured).toBe(true)
  await expect(page.getByText("acme saved", { exact: true })).toHaveCount(0)

  // The dialog stays open with every entered value retained for a retry.
  await expect(form.getByLabel("Provider ID", { exact: true })).toHaveValue("acme")
  await expect(form.getByLabel("Name", { exact: true })).toHaveValue("Acme")
  await expect(form.getByPlaceholder("https://api.example.com/v1")).toHaveValue("https://api.acme.example/v1")
  await expect(form.getByLabel("API key", { exact: true })).toHaveValue("sk-test")
  await expect(form.getByPlaceholder("Model ID", { exact: true })).toHaveValue("acme-1")
  await expect(form.getByPlaceholder("Model name", { exact: true })).toHaveValue("Acme 1")
})
