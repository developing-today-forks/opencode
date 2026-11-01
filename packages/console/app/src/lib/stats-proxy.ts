import type { APIEvent } from "@solidjs/start/server"
import { Resource, waitUntil } from "@opencode/console-resource"
import { prefersMarkdown } from "~/lib/content-negotiation"
import { LOCALE_HEADER, cookie, localeFromRequest, route, tag } from "~/lib/language"

const dataPath = "/data"

export const STATS_FETCH_TIMEOUT_MS = 8_000
// The stats HTML shell is a small server-rendered document; 1 MiB gives it wide
// headroom while still bounding per-request memory (the #1089 download-route cap).
export const STATS_HTML_MAX_BYTES = 1024 * 1024
const statsCacheParam = "__opencode_stats_locale"

export async function statsProxy(evt: APIEvent) {
  const req = evt.request.clone()
  const locale = localeFromRequest(req)
  const redirect = redirectToLocalizedData(req, new URL(req.url), locale)
  if (redirect) return redirect

  const cache = defaultCache(caches)
  const cacheKey = statsCacheKey(req, locale)
  if (cacheKey) {
    const cached = await cache.match(cacheKey)
    if (cached) return withStatsCacheStatus(cached, "HIT")
  }

  const targetUrl = new URL(req.url)
  targetUrl.protocol = "https:"
  targetUrl.hostname = Resource.App.stage === "production" ? "stats.opencode.ai" : "stats.dev.opencode.ai"
  targetUrl.port = ""

  if (
    targetUrl.pathname.startsWith(`${dataPath}/_build/`) ||
    targetUrl.pathname === `${dataPath}/banner.jpg` ||
    targetUrl.pathname === `${dataPath}/banner.png` ||
    targetUrl.pathname === `${dataPath}/sitemap.xml`
  ) {
    targetUrl.pathname = targetUrl.pathname.slice(dataPath.length)
  }

  const requestHeaders = new Headers(req.headers)
  requestHeaders.set(LOCALE_HEADER, locale)
  requestHeaders.set("accept-language", tag(locale))

  const signal = AbortSignal.timeout(STATS_FETCH_TIMEOUT_MS)
  const response = await fetch(targetUrl, {
    method: req.method,
    headers: requestHeaders,
    body: req.body,
    signal,
    // Pass canonical redirects from the stats app to the client instead of following them here.
    redirect: "manual",
  }).catch(() => undefined)
  // A stalled or failed upstream settles as 502 (the download-route precedent)
  // instead of hanging the route or throwing out of the handler.
  if (!response) return new Response(null, { status: 502 })

  const location = response.headers.get("location")
  if (location) return withPublicLocation(response, new URL(location, targetUrl), targetUrl)
  if (!response.headers.get("content-type")?.includes("text/html")) return response

  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")
  headers.delete("etag")
  headers.delete("set-cookie")
  appendVary(headers, "Accept", "Accept-Language", "Cookie", LOCALE_HEADER)

  const html = await readStatsHtml(response, signal)
  // Over-cap or aborted HTML is a 502 and is never cached: passing it through
  // unrewritten would serve broken /_build/ asset paths.
  if (html === undefined) return new Response(null, { status: 502 })

  const result = new Response(rewriteStatsHtml(html), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
  if (!cacheKey || !response.ok) return result

  void waitUntil(cache.put(cacheKey, result.clone()))
  return withStatsCacheStatus(result, "MISS")
}

export function statsRedirect(evt: APIEvent) {
  const url = new URL(evt.request.url)
  url.pathname = `${dataPath}${url.pathname.slice("/stats".length)}`
  return new Response(null, {
    status: 308,
    headers: {
      Location: url.toString(),
    },
  })
}

// A redirect to the stats origin itself would send clients past the proxy, so keep only the path.
function withPublicLocation(response: Response, location: URL, upstream: URL) {
  if (location.origin !== upstream.origin) return response
  const headers = new Headers(response.headers)
  headers.set("location", `${location.pathname}${location.search}${location.hash}`)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** Stream the HTML body with a hard size cap; an abort or over-cap read cancels the body. */
async function readStatsHtml(response: Response, signal: AbortSignal) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > STATS_HTML_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined)
  signal.addEventListener("abort", abort, { once: true })
  try {
    signal.throwIfAborted()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const result = await reader.read()
      signal.throwIfAborted()
      if (result.done) break
      size += result.value.byteLength
      if (size > STATS_HTML_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  } finally {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}

function rewriteStatsHtml(html: string) {
  return html.replaceAll('"/_build/', `"${dataPath}/_build/`).replaceAll("'/_build/", `'${dataPath}/_build/`)
}

function statsCacheKey(request: Request, locale: ReturnType<typeof localeFromRequest>): Request | undefined {
  if (request.method !== "GET") return undefined
  if (!acceptsHtml(request)) return undefined
  if (isDataBypassPath(new URL(request.url).pathname)) return undefined

  const url = new URL(request.url)
  const additionalModels = url.searchParams.get("add")
  url.search = ""
  if (additionalModels) url.searchParams.set("add", additionalModels)
  url.searchParams.set(statsCacheParam, locale)
  return new Request(url)
}

function defaultCache(storage: CacheStorage) {
  if (!isCloudflareCacheStorage(storage)) throw new Error("Cloudflare default cache is unavailable")
  return storage.default
}

function isCloudflareCacheStorage(storage: CacheStorage): storage is CacheStorage & { default: Cache } {
  return "default" in storage
}

function withStatsCacheStatus(response: Response, status: "HIT" | "MISS") {
  const headers = new Headers(response.headers)
  headers.set("x-opencode-stats-cache", status)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function redirectToLocalizedData(request: Request, url: URL, locale: ReturnType<typeof localeFromRequest>) {
  if (locale === "en") return null
  if (request.headers.get(LOCALE_HEADER)) return null
  if (request.method !== "GET" && request.method !== "HEAD") return null
  if (!acceptsHtml(request)) return null
  if (!url.pathname.startsWith(`${dataPath}/`) && url.pathname !== dataPath) return null
  if (isDataBypassPath(url.pathname)) return null

  const next = new URL(url)
  next.pathname = route(locale, url.pathname)

  const headers = new Headers({
    Location: next.toString(),
  })
  headers.append("set-cookie", cookie(locale))
  appendVary(headers, "Accept", "Accept-Language", "Cookie", LOCALE_HEADER)

  return new Response(null, {
    status: 308,
    headers,
  })
}

function acceptsHtml(request: Request) {
  const accept = request.headers.get("accept")
  // The stats app answers Markdown requests itself, so keep them out of the HTML cache and locale redirect.
  if (prefersMarkdown(accept)) return false
  return !accept || accept.includes("text/html") || accept.includes("*/*")
}

function isDataBypassPath(pathname: string) {
  return (
    pathname.startsWith(`${dataPath}/_build/`) ||
    pathname.startsWith(`${dataPath}/api/`) ||
    pathname.startsWith(`${dataPath}/_server`) ||
    pathname === `${dataPath}/banner.jpg` ||
    pathname === `${dataPath}/banner.png` ||
    pathname === `${dataPath}/sitemap.xml` ||
    pathname.endsWith("/llms.txt") ||
    pathname.endsWith(".md") ||
    pathname.endsWith(".json")
  )
}

function appendVary(headers: Headers, ...values: string[]) {
  const existing = headers
    .get("vary")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  headers.set(
    "vary",
    values
      .reduce(
        (result, value) =>
          result.some((item) => item.toLowerCase() === value.toLowerCase()) ? result : [...result, value],
        existing ?? [],
      )
      .join(", "),
  )
}
