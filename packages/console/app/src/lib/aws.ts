import { Resource } from "@opencode/console-resource"
import { AwsClient } from "aws4fetch"

let client: AwsClient | undefined

/** Bound on the SES call (#1143): a stalled SES endpoint must reject within this window
 * instead of pinning the enterprise-form request that awaits it. Matches the sibling
 * EmailOctopus bound in the same flow. */
export const SEND_EMAIL_TIMEOUT_MS = 5_000

export async function sendEmail(input: { to: string; subject: string; body: string; replyTo?: string }) {
  client ??= new AwsClient({
    accessKeyId: Resource.AWS_SES_ACCESS_KEY_ID.value,
    secretAccessKey: Resource.AWS_SES_SECRET_ACCESS_KEY.value,
    region: "us-east-1",
    // aws4fetch retries (5xx/429) wait out their backoff without observing the
    // abort signal, so a retrying call could run ~30s past the 5s bound above.
    retries: 0,
  })
  const res = await client.fetch("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails", {
    signal: AbortSignal.timeout(SEND_EMAIL_TIMEOUT_MS),
    method: "POST",
    headers: {
      "X-Amz-Target": "SES.SendEmail",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      FromEmailAddress: `OpenCode Zen <contact@anoma.ly>`,
      Destination: {
        ToAddresses: [input.to],
      },
      ...(input.replyTo && { ReplyToAddresses: [input.replyTo] }),
      Content: {
        Simple: {
          Subject: {
            Charset: "UTF-8",
            Data: input.subject,
          },
          Body: {
            Text: {
              Charset: "UTF-8",
              Data: input.body,
            },
            Html: {
              Charset: "UTF-8",
              Data: input.body,
            },
          },
        },
      },
    }),
  })
  if (!res.ok) throw new Error(`Failed to send email: ${res.statusText}`)
}
