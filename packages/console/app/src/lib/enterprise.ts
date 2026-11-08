import { sendEmail } from "~/lib/aws"
import { Resource } from "@opencode/console-resource"
import { i18n } from "~/i18n"
import { localeFromRequest } from "~/lib/language"
import { createLead } from "~/lib/salesforce"
import { inferenceSpendOptions } from "~/lib/inference-spend"
import { lookupConsoleAccount, type ConsoleAccount } from "~/lib/console-account"
import { emailOctopusSubscribe } from "~/lib/emailoctopus"

interface EnterpriseFormData {
  name: string
  role: string
  company?: string
  email: string
  phone?: string
  inferenceSpend?: string
  alias?: string
  message: string
}

const EMAIL_OCTOPUS_LIST_ID = "1b381e5e-39bd-11f1-ba4a-cdd4791f0c43"

// The failure log line needs only the status and a short excerpt of the error
// body; cap the read so a misbehaving upstream cannot buffer unboundedly.
export const ERROR_BODY_MAX_BYTES = 8192

/** Read an error response body through a bounded reader, keeping at most ERROR_BODY_MAX_BYTES. */
export async function readErrorBodyExcerpt(res: Response): Promise<string> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < ERROR_BODY_MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      const take = value.subarray(0, ERROR_BODY_MAX_BYTES - size)
      chunks.push(take)
      size += take.byteLength
    }
    if (size >= ERROR_BODY_MAX_BYTES) await reader.cancel().catch(() => undefined)
  } catch {
    // An unreadable error body still leaves the status-based log line useful.
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function splitFullName(fullName: string) {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0)
  if (parts.length === 0) return { firstName: "", lastName: "" }
  if (parts.length === 1) return { firstName: parts[0], lastName: "" }
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") }
}

export function subscribe(email: string, fullName: string) {
  const name = splitFullName(fullName)
  const fields: Record<string, string> = {}
  if (name.firstName) fields.FirstName = name.firstName
  if (name.lastName) fields.LastName = name.lastName

  const payload: { email_address: string; fields?: Record<string, string> } = { email_address: email }
  if (Object.keys(fields).length) payload.fields = fields

  return emailOctopusSubscribe(EMAIL_OCTOPUS_LIST_ID, payload).then(
    async (res) => {
      if (!res.ok) {
        console.error("EmailOctopus subscribe failed:", res.status, res.statusText, await readErrorBodyExcerpt(res))
        return false
      }
      return true
    },
    (err) => {
      console.error("Failed to subscribe enterprise email:", err)
      return false
    },
  )
}

export async function handleEnterpriseRequest(
  request: Request,
  options: {
    salesforceSubmit?: (payload: Record<string, unknown>) => Promise<boolean>
    notifications?: boolean
    accountLookup?: (email: string) => Promise<ConsoleAccount | null>
  } = {},
) {
  const dict = i18n(localeFromRequest(request))
  try {
    const body = (await request.json()) as EnterpriseFormData
    const trap = typeof body.alias === "string" ? body.alias.trim() : ""

    if (trap) {
      return Response.json({ success: true, message: dict["enterprise.form.success.submitted"] }, { status: 200 })
    }

    if (!body.name || !body.role || !body.email || !body.message) {
      return Response.json({ error: dict["enterprise.form.error.allFieldsRequired"] }, { status: 400 })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(body.email)) {
      return Response.json({ error: dict["enterprise.form.error.invalidEmailFormat"] }, { status: 400 })
    }

    const inferenceSpend = inferenceSpendOptions.find((option) => option.value === body.inferenceSpend)
    if (body.inferenceSpend && !inferenceSpend) {
      return Response.json({ error: dict["enterprise.form.error.invalidInferenceSpend"] }, { status: 400 })
    }

    const account = await (options.accountLookup ?? lookupConsoleAccount)(body.email).catch((err) => {
      console.error("Failed to look up Console account:", err)
      return undefined
    })

    const emailContent = `
${body.message}<br><br>
${inferenceSpend ? `Current monthly inference spend: ${inferenceSpend.salesforceValue}<br><br>` : ""}
--<br>
${body.name}<br>
${body.role}<br>
${body.company ? `${body.company}<br>` : ""}${body.email}<br>
${body.phone ? `${body.phone}<br>` : ""}`.trim()

    const [lead, mail, octopus] = await Promise.all([
      createLead(
        {
          name: body.name,
          role: body.role,
          company: body.company,
          email: body.email,
          phone: body.phone,
          inferenceSpend: inferenceSpend?.salesforceValue,
          message: body.message,
          consoleAccount: account,
        },
        options.salesforceSubmit,
      ).catch((err) => {
        console.error("Failed to create Salesforce lead:", err)
        return false
      }),
      options.notifications === false
        ? Promise.resolve(false)
        : sendEmail({
            to: Resource.ENTERPRISE_SALES_INBOX_EMAIL.value,
            subject: `Enterprise Inquiry from ${body.name}`,
            body: emailContent,
            replyTo: body.email,
          }).then(
            () => true,
            (err) => {
              console.error("Failed to send enterprise email:", err)
              return false
            },
          ),
      options.notifications === false ? Promise.resolve(false) : subscribe(body.email, body.name),
    ])

    if (!lead && !mail && !octopus) {
      if (import.meta.env.DEV) {
        console.warn("Enterprise inquiry accepted in dev mode without integrations", { email: body.email })
        return Response.json({ success: true, message: dict["enterprise.form.success.submitted"] }, { status: 200 })
      }
      console.error("Enterprise inquiry delivery failed", { email: body.email })
      return Response.json({ error: dict["enterprise.form.error.internalServer"] }, { status: 500 })
    }

    return Response.json({ success: true, message: dict["enterprise.form.success.submitted"] }, { status: 200 })
  } catch (error) {
    console.error("Error processing enterprise form:", error)
    return Response.json({ error: dict["enterprise.form.error.internalServer"] }, { status: 500 })
  }
}
