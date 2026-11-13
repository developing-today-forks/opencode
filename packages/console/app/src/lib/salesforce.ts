import { Resource } from "@opencode/console-resource"
import { z } from "zod"
import { consoleAccountFields, type ConsoleAccount } from "./console-account"

/**
 * Bounds for the Salesforce login/lead fetches. The 8s timeout matches the
 * in-file salesforceRequest() precedent; the 1 MiB cap bounds the token and
 * error body reads below while login()/createLead() consume them
 * (#1097, outbound-HTTP deadline-and-cap family #1127).
 */
export const SALESFORCE_REQUEST_TIMEOUT_MS = 8000
export const SALESFORCE_MAX_RESPONSE_BYTES = 1024 * 1024

/** Read a Salesforce response body with a hard size cap; an over-cap read cancels the body and throws. */
async function readCappedBody(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > SALESFORCE_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Salesforce response exceeded ${SALESFORCE_MAX_RESPONSE_BYTES} bytes`)
  }
  if (!response.body) throw new Error("Salesforce response had no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > SALESFORCE_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`Salesforce response exceeded ${SALESFORCE_MAX_RESPONSE_BYTES} bytes`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readCappedBodyText(response: Response): Promise<string> {
  return new TextDecoder().decode(await readCappedBody(response))
}

// Match provider domains exactly; business domains hosted by these providers remain business addresses.
const personalEmailDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.co.uk",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.de",
  "hotmail.it",
  "live.com",
  "live.co.uk",
  "live.ca",
  "live.com.au",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.in",
  "yahoo.com.au",
  "yahoo.ca",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.it",
  "yahoo.co.jp",
  "ymail.com",
  "rocketmail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "aim.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "mail.com",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "tuta.com",
  "tuta.io",
  "tutanota.com",
  "tutanota.de",
])

async function login() {
  const url = Resource.SALESFORCE_INSTANCE_URL.value.replace(/\/$/, "")
  const clientId = Resource.SALESFORCE_CLIENT_ID.value
  const clientSecret = Resource.SALESFORCE_CLIENT_SECRET.value

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  })

  const res = await fetch(`${url}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(SALESFORCE_REQUEST_TIMEOUT_MS),
  }).catch((err) => {
    console.error("Failed to fetch Salesforce access token:", err)
  })

  if (!res) return

  if (!res.ok) {
    const body = await readCappedBodyText(res).catch((err) => {
      console.error("Failed to read Salesforce error response body:", err)
      return "<unreadable response body>"
    })
    console.error("Failed to fetch Salesforce access token:", res.status, body)
    return
  }

  const data = await readCappedBodyText(res)
    .then((text) => JSON.parse(text) as { access_token?: string; instance_url?: string } | undefined)
    .catch((err) => {
      console.error("Failed to read Salesforce access token response:", err)
    })
  if (!data) return
  if (!data.access_token) {
    console.error("Salesforce auth response did not include an access token")
    return
  }

  return {
    token: data.access_token,
    url: data.instance_url ?? url,
  }
}

export interface SalesforceLeadInput {
  name: string
  role: string
  company?: string
  email: string
  phone?: string
  inferenceSpend?: string
  message: string
  consoleAccount?: ConsoleAccount | null
}

export async function createLead(
  input: SalesforceLeadInput,
  submit?: (payload: Record<string, unknown>) => Promise<boolean>,
): Promise<boolean> {
  const payload = {
    LastName: input.name,
    Company: input.company?.trim() || "Website",
    Email: input.email,
    Phone: input.phone ?? null,
    Title: input.role,
    Description: input.message,
    Current_Monthly_Inference_Spend__c: input.inferenceSpend,
    LeadSource: "enterprise website form",
    ...(input.consoleAccount === undefined ? {} : consoleAccountFields(input.consoleAccount)),
  }
  if (submit) return submit(payload)
  const auth = await login()
  if (!auth) return false

  const res = await fetch(`${auth.url}/services/data/v59.0/sobjects/Lead`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SALESFORCE_REQUEST_TIMEOUT_MS),
  }).catch((err) => {
    console.error("Failed to create Salesforce lead:", err)
  })

  if (!res) return false

  if (!res.ok) {
    const body = await readCappedBodyText(res).catch((err) => {
      console.error("Failed to read Salesforce error response body:", err)
      return "<unreadable response body>"
    })
    console.error("Failed to create Salesforce lead:", res.status, body)
    return false
  }

  return true
}

export type SalesforceRequest = (
  path: string,
  method?: "GET" | "POST" | "PATCH",
  payload?: Record<string, unknown>,
) => Promise<unknown>

export async function salesforceRequest(): Promise<SalesforceRequest> {
  const auth = await login()
  if (!auth) throw new Error("Salesforce authentication unavailable")
  return async (path, method = "GET", payload) => {
    const response = await fetch(`${auth.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error(`Salesforce request failed (${response.status})`)
    if (response.status === 204) return null
    return response.json()
  }
}

/** Update existing people without changing their acquisition source or sales notes. */
export async function syncConsoleAccount(account: ConsoleAccount, request: SalesforceRequest) {
  const quote = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
  const matches = async (object: "Contact" | "Lead") => {
    const query = `SELECT Id FROM ${object} WHERE ${object === "Lead" ? "IsConverted = false AND " : ""}(Console_Account_ID__c = '${quote(account.id)}' OR Email = '${quote(account.email.toLowerCase())}')`
    const records: { Id: string }[] = []
    let path: string | undefined = `/services/data/v59.0/query?q=${encodeURIComponent(query)}`
    while (path) {
      const result = z
        .object({
          records: z.array(z.object({ Id: z.string().regex(/^[a-zA-Z0-9]{15,18}$/) })),
          done: z.boolean(),
          nextRecordsUrl: z.string().optional(),
        })
        .parse(await request(path))
      records.push(...result.records)
      if (result.done) break
      if (!result.nextRecordsUrl?.startsWith("/services/data/")) throw new Error("Salesforce query pagination missing")
      path = result.nextRecordsUrl
    }
    return records.map((record) => ({ object, id: record.Id }))
  }
  const people = [...(await matches("Contact")), ...(await matches("Lead"))]
  const fields = consoleAccountFields(account)
  for (const person of people)
    await request(`/services/data/v59.0/sobjects/${person.object}/${person.id}`, "PATCH", fields)
  if (people.length > 0) return { success: true, created: false, updated: people.length }
  const domain = account.email.slice(account.email.lastIndexOf("@") + 1).toLowerCase()
  const result = z.object({ success: z.literal(true), id: z.string() }).parse(
    await request("/services/data/v59.0/sobjects/Lead", "POST", {
      LastName: (account.name?.trim() || account.email).slice(0, 80),
      Company: personalEmailDomains.has(domain) ? "Individual" : domain,
      Email: account.email.toLowerCase(),
      LeadSource: "console signup",
      ...fields,
    }),
  )
  return { success: true, created: true, id: result.id }
}
