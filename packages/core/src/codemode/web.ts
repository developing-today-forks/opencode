export * as CodeModeWeb from "./web.js"

import { Extension } from "@opencode/codemode"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

const TIMEOUT_MS = 30_000

/**
 * Cap on a fetched response body. The executing program is model-written, so the URL is effectively
 * model-chosen and the body untrusted; 5 MiB is the webfetch tool's `MAX_RESPONSE_BYTES` bound for the
 * same kind of fetch. Without it, 30 s of a fast connection is gigabytes buffered whole.
 */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

/** Redirect hops followed per fetch, matching the webfetch tool's bound. */
export const MAX_REDIRECTS = 10

/**
 * Outbound-network policy (#2310). The executing program is model-written, so a bare fetch would let a
 * prompt or generated program read services reachable from this host — loopback, link-local and RFC1918
 * targets — into the model context, and a public URL could redirect into one. Every destination is
 * therefore checked before any request is sent: the hostname must resolve only to public addresses,
 * and every redirect hop is revalidated the same way. Resolution is checked immediately before the
 * request so a name that answers publicly at check time cannot be swapped for a private answer by a
 * second lookup inside fetch without racing this one; names are denied if ANY answer is non-public.
 *
 * The one escape hatch is narrow and explicit: a host operator who genuinely needs local targets
 * (for example a development server) sets OPENCODE_CODEMODE_ALLOW_PRIVATE_NETWORK=1 in the host
 * process environment. Model-written code cannot set host environment variables, and the policy is
 * on by default everywhere the variable is absent.
 */
export const ALLOW_PRIVATE_NETWORK_ENV = "OPENCODE_CODEMODE_ALLOW_PRIVATE_NETWORK"

const privateNetworkAllowed = () => process.env[ALLOW_PRIVATE_NETWORK_ENV] === "1"

const parseIPv4 = (address: string): [number, number, number, number] | undefined => {
  const parts = address.split(".")
  if (parts.length !== 4) return undefined
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined
  return octets as [number, number, number, number]
}

const isPublicIPv4 = (address: string): boolean => {
  const octets = parseIPv4(address)
  if (!octets) return false
  const [a, b, c] = octets
  if (a === 0) return false // 0.0.0.0/8 "this host on this network"
  if (a === 10) return false // RFC1918 private
  if (a === 100 && b >= 64 && b <= 127) return false // 100.64.0.0/10 CGNAT shared address space
  if (a === 127) return false // loopback
  if (a === 169 && b === 254) return false // link-local (includes cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return false // RFC1918 private
  if (a === 192 && b === 0 && c === 0) return false // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false // 192.0.2.0/24 TEST-NET-1 documentation
  if (a === 192 && b === 88 && c === 99) return false // 192.88.99.0/24 6to4 relay (deprecated)
  if (a === 192 && b === 168) return false // RFC1918 private
  if (a === 198 && (b === 18 || b === 19)) return false // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false // 198.51.100.0/24 TEST-NET-2 documentation
  if (a === 203 && b === 0 && c === 113) return false // 203.0.113.0/24 TEST-NET-3 documentation
  if (a >= 224) return false // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved (incl. broadcast)
  return true
}

const expandIPv6 = (address: string): Array<number> | undefined => {
  const zone = address.indexOf("%")
  const bare = zone === -1 ? address : address.slice(0, zone)
  // An embedded IPv4 tail ("::ffff:192.0.2.1") is rewritten to two hex groups first.
  const tail = bare.match(/(\d+\.\d+\.\d+\.\d+)$/)
  let normalized = bare
  if (tail) {
    const octets = parseIPv4(tail[1])
    if (!octets) return undefined
    const hi = ((octets[0] << 8) | octets[1]).toString(16)
    const lo = ((octets[2] << 8) | octets[3]).toString(16)
    normalized = `${bare.slice(0, bare.length - tail[1].length)}${hi}:${lo}`
  }
  const halves = normalized.split("::")
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  if (halves.length === 1 && left.length !== 8) return undefined
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 2 && missing === 0 && left.length + right.length !== 8)) return undefined
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right]
  if (groups.length !== 8) return undefined
  const values = groups.map((group) => (/^[0-9a-fA-F]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN))
  if (values.some((value) => Number.isNaN(value))) return undefined
  return values
}

const ipv4FromGroups = (groups: Array<number>): string =>
  `${(groups[0] >> 8) & 0xff}.${groups[0] & 0xff}.${(groups[1] >> 8) & 0xff}.${groups[1] & 0xff}`

export const isPublicIPAddress = (address: string): boolean => {
  const version = isIP(address)
  if (version === 4) return isPublicIPv4(address)
  if (version === 6) {
    const groups = expandIPv6(address)
    if (!groups) return false
    // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible forms are judged by the embedded IPv4 address.
    if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
      return isPublicIPv4(ipv4FromGroups([groups[6], groups[7]]))
    }
    // 6to4 (2002::/16) embeds the relay's IPv4 address; NAT64 (64:ff9b::/96) embeds the target's.
    if (groups[0] === 0x2002) return isPublicIPv4(ipv4FromGroups([groups[1], groups[2]]))
    if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
      return isPublicIPv4(ipv4FromGroups([groups[6], groups[7]]))
    }
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false // 2001:db8::/32 documentation
    if (groups[0] >= 0x2001 && groups[0] <= 0x2001 && groups[1] < 0x0200) return false // 2001::/32 Teredo + 2001:2::/48 benchmarking + ORCHID
    // Only global unicast 2000::/3 may pass, and the ranges above carved out of it stay denied:
    // this also excludes loopback ::1, unspecified ::, ULA fc00::/7, link-local fe80::/10 and
    // multicast ff00::/8, none of which are in 2000::/3 except Teredo/benchmarking handled above.
    return groups[0] >= 0x2000 && groups[0] <= 0x3fff
  }
  return false
}

const denied = (target: string) =>
  new Error(
    `fetch to ${target} is denied: Code Mode fetch may only reach public network destinations ` +
      `(loopback, private, link-local and other non-public targets are blocked; a host operator can ` +
      `opt in with ${ALLOW_PRIVATE_NETWORK_ENV}=1)`,
  )

/** Throws unless `url` is an http(s) URL whose hostname resolves only to public addresses. */
export const assertPublicDestination = async (url: URL): Promise<void> => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`fetch cannot be used with the ${url.protocol} protocol.`)
  }
  if (privateNetworkAllowed()) return
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (isIP(hostname)) {
    if (!isPublicIPAddress(hostname)) throw denied(hostname)
    return
  }
  if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost")) {
    throw denied(hostname)
  }
  // Fail closed when resolution fails: an unresolvable name gets no request either way, and
  // surfacing the lookup error keeps the failure legible instead of a fetch retry storm.
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((entry) => !isPublicIPAddress(entry.address))) {
    throw denied(hostname)
  }
}

const readBounded = async (response: Response, method: string): Promise<Uint8Array> => {
  const tooLarge = () => new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`)
  // HEAD and 304 responses have no body; their content-length may describe the GET representation.
  if (method !== "HEAD" && response.status !== 304) {
    const declared = Number(response.headers.get("content-length"))
    if (Number.isSafeInteger(declared) && declared > MAX_RESPONSE_BYTES) {
      // Cancel before rejecting: an uncancelled body keeps downloading in the background
      // until it completes or the fetch timeout fires.
      await response.body?.cancel().catch(() => {})
      throw tooLarge()
    }
  }
  if (!response.body) {
    const bytes = await response.bytes()
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw tooLarge()
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw tooLarge()
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

type Init = {
  readonly method?: string
  readonly headers?: Record<string, string> | Array<[string, string]>
  readonly body?: string | Uint8Array<ArrayBuffer> | URLSearchParams
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const fetch = async (input: string | URL, init: Init = {}) => {
  const parsed = URL.parse(String(input))
  if (!parsed) throw new Error(`fetch URL is invalid: ${String(input)}`)
  if (parsed.protocol === "file:") throw new Error("fetch cannot be used for filesystem access.")
  let url = parsed
  let method = (init.method ?? "GET").toUpperCase()
  let body = init.body
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  // Redirects are followed manually so every hop's destination is revalidated against the
  // outbound-network policy before the request for that hop is sent (#2310); the transport's
  // own redirect following would send the request to an unchecked destination first.
  for (let hop = 0; ; hop++) {
    await assertPublicDestination(url)
    const response = await globalThis.fetch(url, {
      method,
      headers: init.headers,
      body,
      redirect: "manual",
      signal,
    })
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null
    if (!location) {
      const bytes = await readBounded(response, method)
      const headers = Object.fromEntries(response.headers)
      const text = () => new TextDecoder().decode(bytes)
      return {
        url: url.href,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        redirected: hop > 0,
        headers: {
          // Own-property lookups only (#805): headers is a plain record, so a bare index or
          // `in` reads through Object.prototype - an absent "constructor" resolved to the
          // Object function and "__proto__" to Object.prototype instead of null / false.
          get: (name: string) => {
            const key = name.toLowerCase()
            return Object.hasOwn(headers, key) ? headers[key] : null
          },
          has: (name: string) => Object.hasOwn(headers, name.toLowerCase()),
          entries: () => Object.entries(headers),
        },
        text: async () => text(),
        json: async () => JSON.parse(text()),
        bytes: async () => bytes,
      }
    }
    await response.body?.cancel().catch(() => {})
    if (hop >= MAX_REDIRECTS) throw new Error(`fetch exceeded ${MAX_REDIRECTS} redirects`)
    const next = new URL(location, url)
    // Fetch-spec method rewriting: 303 always becomes GET (except HEAD), as do 301/302 for POST.
    if (response.status === 303 ? method !== "HEAD" : (response.status === 301 || response.status === 302) && method === "POST") {
      method = "GET"
      body = undefined
    }
    url = next
  }
}

export const extension = Extension.make({ name: "web", globals: { fetch } })

/** What to show for a fetch call: its method and URL. */
export const display = (args: ReadonlyArray<unknown>) => {
  const [input, init] = args as [string | URL, Init | undefined]
  return { method: init?.method?.toUpperCase() ?? "GET", url: String(input) }
}
