export function getFilename(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[/\\]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return trimmed.slice(index + 1)
}

export function getDirectory(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[/\\]+$/, "")
  const parts = trimmed.split(/[/\\]/)
  return parts.slice(0, parts.length - 1).join("/") + "/"
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

// A cut between a high and a low surrogate would emit a lone surrogate;
// drop the pair whole so the result stays well-formed (at most one char shorter).
const safeHead = (text: string, end: number) =>
  end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))
    ? text.slice(0, end - 1)
    : text.slice(0, end)

const safeTail = (text: string, count: number) => {
  if (count <= 0) return ""
  const start = text.length - count
  return start > 0 && isHighSurrogate(text.charCodeAt(start - 1)) && isLowSurrogate(text.charCodeAt(start))
    ? text.slice(start + 1)
    : text.slice(start)
}

export function getFilenameTruncated(path: string | undefined, maxLength = 20) {
  const filename = getFilename(path)
  if (filename.length <= maxLength) return filename
  // slice(0, maxLength - 1) below is slice(0, -1) at maxLength 0: it keeps
  // all but the last character instead of returning an empty string.
  if (maxLength <= 0) return ""
  const lastDot = filename.lastIndexOf(".")
  const extension = lastDot <= 0 ? "" : filename.slice(lastDot)
  const available = maxLength - extension.length - 1
  if (available <= 0) return safeHead(filename, maxLength - 1) + "…"
  return safeHead(filename, available) + "…" + extension
}

export function truncateMiddle(text: string, maxLength = 20) {
  if (text.length <= maxLength) return text
  if (maxLength <= 0) return ""
  const available = maxLength - 1
  const start = Math.ceil(available / 2)
  const end = Math.floor(available / 2)
  // slice(-0) is slice(0): at maxLength 1-2 nothing is kept from the end, and
  // slicing with it would return the whole string.
  return safeHead(text, start) + "…" + (end > 0 ? safeTail(text, end) : "")
}

const isDrive = (value: string) => {
  if (value.length !== 2) return false
  const code = value.charCodeAt(0)
  return value[1] === ":" && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
}

const trimTrailingSlashes = (value: string) => {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== "/") return value.slice(0, i + 1)
  }
  return ""
}

const isWindowsPath = (value: string) => value[1] === ":" || value.startsWith("\\\\")

/** A comparable form of a directory path: forward slashes for Windows paths, no trailing slash except on roots. */
export function comparablePath(path: string) {
  const value = isWindowsPath(path) ? path.replaceAll("\\", "/") : path
  const trimmed = trimTrailingSlashes(value)
  if (!trimmed && value.startsWith("/")) return "/"
  if (isDrive(trimmed)) return `${trimmed}/`
  return trimmed
}

/** `child` is `parent` or inside it. Windows drive and UNC paths compare case-insensitively. */
export function containsDirectory(parent: string, child: string) {
  const normalize = (value: string) => {
    const key = comparablePath(value)
    return /^[a-z]:\//i.test(key) || key.startsWith("//") ? key.toLowerCase() : key
  }
  const root = normalize(parent)
  const target = normalize(child)
  return target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`)
}

export function sameDirectory(a: string, b: string) {
  return containsDirectory(a, b) && containsDirectory(b, a)
}

export function encodeFilePath(filepath: string): string {
  // Normalize Windows paths: convert backslashes to forward slashes
  const normalized = filepath.replace(/\\/g, "/")

  // Handle Windows absolute paths (D:/path -> /D:/path for proper file:// URLs)
  const rooted = /^[A-Za-z]:/.test(normalized) ? "/" + normalized : normalized

  // Encode each path segment (preserving forward slashes as path separators)
  // Keep the colon in Windows drive letters (`/C:/...`) so downstream file URL parsers
  // can reliably detect drives.
  return rooted
    .split("/")
    .map((segment, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join("/")
}

const MAX_LINE_NUMBER = 1_000_000

const lineHashPattern = /^#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i

const lineHashSuffixPattern = /^(.*?)#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i

const lineColonSuffixPattern = /^(.*?):(\d+)(?::\d+)?(?:-(\d+)(?::\d+)?)?:?$/

function toLineRange(first: number, second: number) {
  if (
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(second) ||
    first < 1 ||
    second < 1 ||
    first > MAX_LINE_NUMBER ||
    second > MAX_LINE_NUMBER
  ) {
    return undefined
  }

  return {
    start: Math.min(first, second),
    end: Math.max(first, second),
  }
}

export function isLineRangeHash(hash: string) {
  return lineHashPattern.test(hash)
}

export function parsePathLineSuffix(input: string) {
  const hashMatch = input.match(lineHashSuffixPattern)

  if (hashMatch) {
    const first = Number(hashMatch[2])
    const second = hashMatch[3] ? Number(hashMatch[3]) : first

    return {
      path: hashMatch[1] ?? "",
      selection: toLineRange(first, second),
    }
  }

  const colonMatch = input.match(lineColonSuffixPattern)

  if (colonMatch && !/^[a-z]:?$/i.test(colonMatch[1] ?? "")) {
    const first = Number(colonMatch[2])
    const second = colonMatch[3] ? Number(colonMatch[3]) : first

    return {
      path: colonMatch[1] ?? "",
      selection: toLineRange(first, second),
    }
  }

  return { path: input, selection: undefined }
}
