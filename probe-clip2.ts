import { MessagingLog } from "./packages/core/src/messaging/log.js"
const MUS = "\u{1D11E}"
let found = 0
for (let chars = 30; chars <= 300 && found < 4; chars++) {
  for (let pad = 0; pad < 60 && found < 4; pad++) {
    const text = "a".repeat(300) + "z".repeat(pad) + MUS + "b".repeat(300)
    const out = MessagingLog.clip(text, chars)
    if (!out.isWellFormed() && /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)) {
      console.log(`TAIL SPLIT chars=${chars} pad=${pad} out_tail=${JSON.stringify(out.slice(-24))}`)
      found++
    }
  }
}
console.log(`tail splits found: ${found}`)
