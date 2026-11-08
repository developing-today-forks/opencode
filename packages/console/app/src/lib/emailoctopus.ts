import { Resource } from "@opencode/console-resource"

export const EMAILOCTOPUS_TIMEOUT_MS = 5000

/** Subscribe a contact to an EmailOctopus list, bounded so a stalled API fails instead of hanging the request. */
export function emailOctopusSubscribe(listId: string, payload: Record<string, unknown>) {
  return fetch(`https://api.emailoctopus.com/lists/${listId}/contacts`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${Resource.EMAILOCTOPUS_API_KEY.value}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(EMAILOCTOPUS_TIMEOUT_MS),
  })
}
