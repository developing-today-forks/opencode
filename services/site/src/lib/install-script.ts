// The V2 install script (`curl -fsSL https://opencode.ai/v2/install | bash`) is proxied live from
// the upstream repo on every request, always the latest. The upstream fetch carries a named
// deadline (#2885, restoring the behaviour #1246 added to the old www install page and lost when
// the route moved into this service): a stalled upstream must not leave the route pending until
// the platform terminates it. The same signal stays attached while the response body streams
// through, so a slow-dripping body is bounded too. A fetch that fails before any header arrives
// (the deadline included) answers a bounded 503 instead of hanging or throwing out of the
// middleware. The success path is byte- and header-identical to the unbounded proxy it replaces,
// apart from the deadline: status and headers pass through, Cache-Control is forced to no-store.

export const INSTALL_SCRIPT_URL = "https://raw.githubusercontent.com/anomalyco/opencode/dev/install"
export const INSTALL_FETCH_TIMEOUT_MS = 30_000

/** Answers /v2/install with the upstream install script, streamed through under the deadline. */
export async function installScript(timeoutMs: number = INSTALL_FETCH_TIMEOUT_MS): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetch(INSTALL_SCRIPT_URL, { signal })
  } catch {
    return new Response("The install script is temporarily unavailable. Please try again shortly.\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    })
  }
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", "no-store")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
