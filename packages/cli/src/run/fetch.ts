export const RUN_REQUEST_TIMEOUT_MS = 30_000

export function createRunFetch(timeoutMs = RUN_REQUEST_TIMEOUT_MS): typeof fetch {
  return ((request: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(request instanceof Request ? request.url : request).pathname
    if (pathname.endsWith("/api/event") || /(^|\/)api\/experimental\/session\/[^/]+\/wait$/.test(pathname))
      return fetch(request, { ...init, timeout: false } as BunFetchRequestInit)

    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline
    return fetch(request, { ...init, signal })
  }) as typeof fetch
}
