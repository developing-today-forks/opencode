export * as Identifier from "./identifier.js"

const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

export function ascending() {
  return create(false)
}

export function descending() {
  return create(true)
}

// The sortable prefix is the top 14 hex chars: the full packed
// `timestamp * 0x1000 + counter` at 56 bits, so ordering holds until the
// timestamp reaches 2^44 ms (~year 2527). Before #561 the prefix held only
// the low 48 bits and wrapped every 2^36 ms. IDs minted by that scheme keep
// their 26-char shape and stay valid, but their cross-era ordering cannot be
// recovered — the discarded high bits were never stored — so the ordering
// guarantee below applies among IDs minted by this scheme; consumers that
// need true historical order sort by stored creation time where they have it.
//
// Minting is monotonic within a process: a timestamp at or below the
// high-water mark (same millisecond, clock regression, or an explicit past
// timestamp) continues the high-water sequence instead of re-entering an
// earlier prefix space, and a counter that would exceed its 12 bits advances
// the effective timestamp by 1 ms rather than borrowing the next
// millisecond's space, which the real next millisecond would then re-mint.
export function create(descending: boolean, timestamp = Date.now()) {
  if (timestamp > lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++
  if (counter > 0xfff) {
    lastTimestamp++
    counter = 1
  }

  const current = BigInt(lastTimestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  const time = Array.from({ length: 7 }, (_, index) =>
    Number((value >> BigInt(48 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(length - 14))
  return time + Array.from(bytes, (byte) => chars[byte % 62]).join("")
}
