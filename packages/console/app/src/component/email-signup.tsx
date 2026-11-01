import { action, useSubmission } from "@solidjs/router"
import { emailOctopusSubscribe } from "~/lib/emailoctopus"
import { Show } from "solid-js"
import { useI18n } from "~/context/i18n"

const emailSignup = action(async (formData: FormData) => {
  "use server"
  const emailAddress = formData.get("email")!
  const listId = "8b9bb82c-9d5f-11f0-975f-0df6fd1e4945"
  const response = await emailOctopusSubscribe(listId, { email_address: emailAddress })
  console.log(response)
  return true
})

export function EmailSignup() {
  const submission = useSubmission(emailSignup)
  const i18n = useI18n()
  return (
    <section data-component="email">
      <div data-slot="section-title">
        <h3>{i18n.t("email.title")}</h3>
        <p>{i18n.t("email.subtitle")}</p>
      </div>
      <form data-slot="form" action={emailSignup} method="post">
        <input type="email" name="email" placeholder={i18n.t("email.placeholder")} required />
        <button type="submit" disabled={submission.pending}>
          {i18n.t("email.subscribe")}
        </button>
      </form>
      <Show when={submission.result}>
        <div style="color: #03B000; margin-top: 24px;">{i18n.t("email.success")}</div>
      </Show>
      <Show when={submission.error}>
        <div style="color: #FF408F; margin-top: 24px;">{submission.error}</div>
      </Show>
    </section>
  )
}
