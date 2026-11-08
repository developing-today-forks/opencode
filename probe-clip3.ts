import { MessagingLog } from "./packages/core/src/messaging/log.js"
const MUS = "\u{1D11E}"
let found = 0
for (let chars = 40; chars <= 300 && found < 4; chars++) {
  for (let after = 0; after < 80 && found < 4; after++) {
    const text = "a".repeat(300) + MUS + "b".repeat(after)
    const out = MessagingLog.clip(text, chars)
    const loneLow = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    if (!out.isWellFormed() && loneLow.test(out)) {
      console.log(`TAIL SPLIT chars=${chars} after=${after} out=${JSON.stringify(out.slice(-30))}`)
      found++
    }
  }
}
console.log(`tail splits found: ${found}`)
