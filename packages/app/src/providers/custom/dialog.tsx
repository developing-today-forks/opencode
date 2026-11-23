import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Field } from "@opencode/ui/field"
import { TextInput } from "@opencode/ui/text-input"
import { createSignal, For, Show, type Component } from "solid-js"
import { useDialog } from "@opencode/ui/context/dialog"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useIntegrations } from "@/providers/catalog/integrations"
import { useProviders } from "@/providers/catalog/providers"
import { showToast } from "@/shell/notifications/toast"
import { emptyCustomProviderForm, headerRow, modelRow, type FormState } from "./form"
import { saveCustomProvider } from "./save"

/**
 * The V2 custom-provider form: an OpenAI-compatible endpoint, its API key,
 * models, and optional headers. Saving persists the provider definition
 * through the config API and the key through the provider-scoped credential
 * path (see save.ts). A failed save keeps every entered value in place and
 * says which stage failed; only a fully successful save closes the dialog.
 */
export const DialogCustomProvider: Component<{
  directory?: string
  onSaved?: (providerID: string) => void
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useServerSDK()
  const data = useData()
  const integrations = useIntegrations(() => props.directory)
  const providers = useProviders(() => props.directory)

  const [form, setForm] = createStore<FormState>(emptyCustomProviderForm())
  const [pending, setPending] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  const existingProviderIDs = () => {
    const ids = new Set<string>(integrations.list().map((integration) => integration.id))

    for (const [id] of providers.all()) ids.add(id)

    return ids
  }

  const save = async () => {
    if (pending()) return
    setPending(true)
    setFailure(undefined)

    const location = props.directory ? { directory: props.directory } : undefined

    const result = await saveCustomProvider({
      form,
      t: language.t,
      existingProviderIDs: existingProviderIDs(),
      api: {
        updateConfig: (input) => sdk.api.experimental.config.update(input),
        createCredential: (input) => sdk.api.credential.create(input),
        reload: async () => {
          if (!location) await data.location.syncInfo()
          const ref = location ?? data.location.default()
          await Promise.all([
            data.location.integration.sync(ref),
            data.location.provider.sync(ref),
            data.location.model.sync(ref),
          ]).catch(() => undefined)
        },
      },
    })
      .catch((error: unknown) => {
        setFailure(language.t("provider.custom.error.saveFailed"))

        return undefined
      })
      .finally(() => setPending(false))

    if (!result) return

    if (result.ok) {
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.custom.saved", { provider: result.providerID }),
      })
      dialog.close()
      props.onSaved?.(result.providerID)

      return
    }

    if (result.stage === "validation") {
      setForm("err", result.err)
      setForm("models", (rows) => rows.map((row, index) => ({ ...row, err: result.models[index] ?? {} })))
      setForm("headers", (rows) => rows.map((row, index) => ({ ...row, err: result.headers[index] ?? {} })))

      return
    }

    // The entered values stay in the form; only the message changes.
    setFailure(
      result.stage === "credential"
        ? language.t("provider.custom.error.credentialFailed")
        : language.t("provider.custom.error.saveFailed"),
    )
  }

  const fieldError = (message?: string) => (
    <Show when={message}>
      <div class="text-[13px] leading-5 text-[var(--v2-state-fg-danger)]">{message}</div>
    </Show>
  )

  return (
    <Dialog size="large" fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("provider.custom.title")}
          description={language.t("provider.custom.description")}
        />
      </DialogHeader>
      <DialogBody class="px-4 pb-4">
        <form
          class="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <Field invalid={!!form.err.providerID}>
            <Field.Label>{language.t("provider.custom.providerID")}</Field.Label>
            <TextInput
              class="!w-full"
              value={form.providerID}
              invalid={!!form.err.providerID}
              autocomplete="off"
              spellcheck={false}
              onInput={(event) => setForm("providerID", event.currentTarget.value)}
            />
            {fieldError(form.err.providerID)}
          </Field>
          <Field invalid={!!form.err.name}>
            <Field.Label>{language.t("provider.custom.name")}</Field.Label>
            <TextInput
              class="!w-full"
              value={form.name}
              invalid={!!form.err.name}
              autocomplete="off"
              spellcheck={false}
              onInput={(event) => setForm("name", event.currentTarget.value)}
            />
            {fieldError(form.err.name)}
          </Field>
          <Field invalid={!!form.err.baseURL}>
            <Field.Label>{language.t("provider.custom.baseURL")}</Field.Label>
            <TextInput
              class="!w-full"
              value={form.baseURL}
              invalid={!!form.err.baseURL}
              placeholder="https://api.example.com/v1"
              autocomplete="off"
              spellcheck={false}
              onInput={(event) => setForm("baseURL", event.currentTarget.value)}
            />
            {fieldError(form.err.baseURL)}
          </Field>
          <Field>
            <Field.Label>{language.t("provider.custom.apiKey")}</Field.Label>
            <TextInput
              class="!w-full"
              type="password"
              value={form.apiKey}
              placeholder={language.t("provider.custom.apiKey.placeholder")}
              autocomplete="off"
              spellcheck={false}
              onInput={(event) => setForm("apiKey", event.currentTarget.value)}
            />
          </Field>

          <div class="flex flex-col gap-2">
            <div class="text-[13px] font-[530] text-v2-text-text-base">{language.t("provider.custom.models")}</div>
            <For each={form.models}>
              {(model, index) => (
                <div class="flex items-start gap-2">
                  <div class="flex flex-1 flex-col gap-1">
                    <TextInput
                      class="!w-full"
                      value={model.id}
                      placeholder={language.t("provider.custom.model.id")}
                      invalid={!!model.err.id}
                      autocomplete="off"
                      spellcheck={false}
                      onInput={(event) => setForm("models", index(), "id", event.currentTarget.value)}
                    />
                    {fieldError(model.err.id)}
                  </div>
                  <div class="flex flex-1 flex-col gap-1">
                    <TextInput
                      class="!w-full"
                      value={model.name}
                      placeholder={language.t("provider.custom.model.name")}
                      invalid={!!model.err.name}
                      autocomplete="off"
                      spellcheck={false}
                      onInput={(event) => setForm("models", index(), "name", event.currentTarget.value)}
                    />
                    {fieldError(model.err.name)}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={form.models.length <= 1}
                    onClick={() => setForm("models", (rows) => rows.filter((_, i) => i !== index()))}
                  >
                    {language.t("provider.custom.remove")}
                  </Button>
                </div>
              )}
            </For>
            <div>
              <Button type="button" variant="ghost" onClick={() => setForm("models", (rows) => [...rows, modelRow()])}>
                {language.t("provider.custom.model.add")}
              </Button>
            </div>
          </div>

          <div class="flex flex-col gap-2">
            <div class="text-[13px] font-[530] text-v2-text-text-base">{language.t("provider.custom.headers")}</div>
            <For each={form.headers}>
              {(header, index) => (
                <div class="flex items-start gap-2">
                  <div class="flex flex-1 flex-col gap-1">
                    <TextInput
                      class="!w-full"
                      value={header.key}
                      placeholder={language.t("provider.custom.header.key")}
                      invalid={!!header.err.key}
                      autocomplete="off"
                      spellcheck={false}
                      onInput={(event) => setForm("headers", index(), "key", event.currentTarget.value)}
                    />
                    {fieldError(header.err.key)}
                  </div>
                  <div class="flex flex-1 flex-col gap-1">
                    <TextInput
                      class="!w-full"
                      value={header.value}
                      placeholder={language.t("provider.custom.header.value")}
                      invalid={!!header.err.value}
                      autocomplete="off"
                      spellcheck={false}
                      onInput={(event) => setForm("headers", index(), "value", event.currentTarget.value)}
                    />
                    {fieldError(header.err.value)}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={form.headers.length <= 1}
                    onClick={() => setForm("headers", (rows) => rows.filter((_, i) => i !== index()))}
                  >
                    {language.t("provider.custom.remove")}
                  </Button>
                </div>
              )}
            </For>
            <div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setForm("headers", (rows) => [...rows, headerRow()])}
              >
                {language.t("provider.custom.header.add")}
              </Button>
            </div>
          </div>

          <Show when={failure()}>
            <div class="text-[13px] leading-5 text-[var(--v2-state-fg-danger)]">{failure()}</div>
          </Show>

          <div class="flex justify-end">
            <Button type="submit" variant="submit" disabled={pending()} aria-busy={pending()}>
              {language.t("common.save")}
            </Button>
          </div>
        </form>
      </DialogBody>
    </Dialog>
  )
}
