import { stringWidth } from "./string-width"

export function titlecase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function time(input: number): string {
  const date = new Date(input)
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export function datetime(input: number): string {
  const date = new Date(input)
  const localTime = time(input)
  const localDate = date.toLocaleDateString()
  return `${localTime} · ${localDate}`
}

export function number(num: number): string {
  // 999950+ would round to "1000.0K"
  if (num >= 999950) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}

export function duration(input: number) {
  if (input < 1000) {
    return `${input}ms`
  }
  if (input < 60000) {
    return `${(input / 1000).toFixed(1)}s`
  }
  if (input < 3600000) {
    const minutes = Math.floor(input / 60000)
    const seconds = Math.floor((input % 60000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (input < 86400000) {
    const hours = Math.floor(input / 3600000)
    const minutes = Math.floor((input % 3600000) / 60000)
    return `${hours}h ${minutes}m`
  }
  const days = Math.floor(input / 86400000)
  const hours = Math.floor((input % 86400000) / 3600000)
  return `${days}d ${hours}h`
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

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str
  if (len <= 0) return ""
  return safeHead(str, len - 1) + "…"
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function graphemes(str: string) {
  return Array.from(graphemeSegmenter.segment(str), (item) => item.segment)
}

export function takeWidth(str: string, width: number) {
  if (width <= 0) return ""
  if (stringWidth(str) <= width) return str

  const result: string[] = []
  let used = 0
  for (const segment of graphemes(str)) {
    const next = stringWidth(segment)
    if (used + next > width) break
    result.push(segment)
    used += next
  }
  return result.join("")
}

export function truncateWidth(str: string, width: number): string {
  if (width <= 0) return ""
  if (stringWidth(str) <= width) return str
  if (width === 1) return "…"
  return takeWidth(str, width - 1) + "…"
}

export function truncateLeft(str: string, len: number): string {
  if (str.length <= len) return str
  if (len <= 0) return ""
  if (len === 1) return "…"
  return "…" + safeTail(str, len - 1)
}

export function truncateMiddle(str: string, maxLength: number = 35): string {
  if (str.length <= maxLength) return str

  if (maxLength <= 0) return ""

  const ellipsis = "…"
  const keepStart = Math.ceil((maxLength - ellipsis.length) / 2)
  const keepEnd = Math.floor((maxLength - ellipsis.length) / 2)

  // slice(-0) is slice(0): at maxLength 1-2 nothing is kept from the end, and
  // slicing with it would return the whole string.
  return safeHead(str, keepStart) + ellipsis + (keepEnd > 0 ? safeTail(str, keepEnd) : "")
}

export * as Locale from "./locale"
