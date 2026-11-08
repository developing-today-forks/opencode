import { MessagingLog } from "./packages/core/src/messaging/log.js"
const MUS = "\u{1D11E}" // 𝄞 astral: D834 DD1E
// Case 1: head cut lands inside a pair. chars budget: head = ceil(chars*0.7)
for (const chars of [40, 41, 50, 60, 100]) {
  const headPad = "a".repeat(Math.ceil(chars * 0.7) - 1)
  const text = headPad + MUS + "b".repeat(200)
  const out = MessagingLog.clip(text, chars)
  console.log(`chars=${chars} headSplit=${/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)} tailSplit=${/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)} wellFormed=${out.isWellFormed()} out=${JSON.stringify(out.slice(0, 50))}`)
}
// Case 2: tail cut lands inside a pair
for (const chars of [100, 101, 120]) {
  const tail = chars - Math.ceil(chars * 0.7) - 20
  const text = "a".repeat(200) + "x" + MUS + "b".repeat(Math.max(0, tail - 2))
  const out = MessagingLog.clip(text + "c".repeat(50), chars)
  console.log(`tailcase chars=${chars} wellFormed=${out.isWellFormed()} out_tail=${JSON.stringify(out.slice(-30))}`)
}
// Case 3: marker-too-big fallback plain slice(0, chars)
for (const chars of [10, 15, 21, 25]) {
  const text = "a".repeat(chars - 1) + MUS + "b".repeat(100)
  const out = MessagingLog.clip(text, chars)
  console.log(`fallback chars=${chars} wellFormed=${out.isWellFormed()} len=${out.length} out=${JSON.stringify(out)}`)
}
// Control: pure BMP
const ctrl = MessagingLog.clip("a".repeat(500), 100)
console.log(`control wellFormed=${ctrl.isWellFormed()} len=${ctrl.length}`)
