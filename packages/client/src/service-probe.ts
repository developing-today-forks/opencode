import { homedir } from "node:os"
import { join } from "node:path"
import type { DiscoverOptions, Endpoint, Info } from "./service.js"
import { defaultEnsureTiming } from "./service-timing.js"
import { matchesVersion } from "./service-version.js"

// Shared by the Effect and Promise clients. Keep this module free of Effect so the
// Promise client never loads the Effect runtime.

export type LocalService = {
  readonly info: Info
  readonly endpoint: Endpoint
  readonly version?: string
  readonly state: "ready" | "waiting" | "failed"
  readonly compatible: boolean
}

/**
 * What `ensure()` does with a registered service that answered: return it, keep polling while
 * it starts, replace it because its version does not meet the requirement, or fail.
 */
export function decide(service: LocalService, options: DiscoverOptions) {
  if (!matchesVersion(service.version, options))
    return { _tag: "replace", pty: service.state === "ready" ? "handoff" : "clear" } as const
  if (!service.compatible)
    return fail(
      "Background service uses an incompatible health protocol. Update this client or explicitly restart the service.",
    )
  if (service.state === "ready") return { _tag: "reuse" } as const
  if (service.state === "failed") return fail("Background service failed to start")
  return { _tag: "wait" } as const
}

function fail(message: string) {
  return { _tag: "fail" as const, error: new Error(message) }
}

/** The default registration file. */
export function fallback() {
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "opencode", "service.json")
}

/** Whether two registrations describe the same service instance. */
export function same(left: Info, right: Info) {
  return left.id === right.id && left.version === right.version && left.url === right.url && left.pid === right.pid
}

/**
 * Maximum `/api/info` probe body, in bytes.
 *
 * A healthy answer is a tiny struct — {@link decodeInfo} only reads `version`
 * and `pid` — so 64 KiB leaves kilobytes of headroom while keeping a bad
 * registered endpoint from OOMing the client during automatic discovery.
 */
export const maxProbeBodyBytes = 64 * 1024

/** Ask a registered owner for its health and classify the answer. */
export async function probeResult(info: Info, timeout = defaultEnsureTiming.requestTimeout) {
  const endpoint = {
    url: info.url,
    auth: info.password === undefined ? undefined : { type: "basic", username: "opencode", password: info.password },
  } satisfies Endpoint
  const signal = AbortSignal.timeout(timeout)
  const result = await fetch(new URL("/api/info", info.url), { headers: headers(endpoint), signal })
    .then(async (response) => ({
      response,
      body: response.status === 404 ? undefined : await readProbeBody(response),
    }))
    .catch(() => undefined)
  if (result === undefined) return { service: undefined, timedOut: signal.aborted }
  const response = result.response
  // A missing health endpoint identifies protocol incompatibility, not an older
  // version. Only an unmet version requirement lets ensure replace this owner.
  if (response.status === 404)
    return {
      service: {
        info,
        endpoint,
        version: info.version,
        state: "ready",
        compatible: false,
      } satisfies LocalService,
      timedOut: false,
    }
  const serverInfo = decodeInfo(result.body)
  if (serverInfo === undefined) return { service: undefined, timedOut: false }
  if (serverInfo.pid !== info.pid) return { service: undefined, timedOut: false }
  if (info.version !== undefined && serverInfo.version !== info.version) return { service: undefined, timedOut: false }
  return {
    service: {
      info,
      endpoint,
      version: serverInfo.version,
      state: response.ok ? "ready" : response.status === 500 ? "failed" : "waiting",
      compatible: true,
    } satisfies LocalService,
    timedOut: false,
  }
}

/** Create HTTP authentication headers for a service endpoint. */
export function headers(endpoint: Endpoint) {
  if (endpoint.auth === undefined) return undefined
  return {
    authorization: "Basic " + Buffer.from(endpoint.auth.username + ":" + endpoint.auth.password).toString("base64"),
  }
}

/** Read the probe body through a bounded path; over-cap bodies yield undefined, read failures throw. */
async function readProbeBody(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxProbeBodyBytes) {
    try {
      await response.body?.cancel()
    } catch {}
    return undefined
  }
  if (response.body === null) {
    // Read failures (including the probe timeout abort) propagate to
    // probeResult's outer catch, which classifies them via signal.aborted.
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxProbeBodyBytes) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  try {
    while (true) {
      // Do not swallow read failures: a timeout abort rejecting read() must
      // reach probeResult's outer catch so the probe reports timedOut, which
      // is what lets ensure() terminate an unresponsive registered owner.
      const next = await reader.read()
      if (next.done) {
        text += decoder.decode()
        break
      }
      bytes += next.value.byteLength
      if (bytes > maxProbeBodyBytes) {
        try {
          await reader.cancel()
        } catch {}
        return undefined
      }
      text += decoder.decode(next.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function decodeInfo(input: unknown) {
  if (typeof input !== "object" || input === null) return
  if (!("version" in input) || typeof input.version !== "string") return
  if (!("pid" in input) || typeof input.pid !== "number" || !Number.isInteger(input.pid) || input.pid < 0) return
  return { version: input.version, pid: input.pid }
}
