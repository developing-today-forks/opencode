import { toUsageWindow } from "./packages/ai/src/quota/utils.ts"
for (const usedPercent of [-20, -5, 0, 50, 100, 150]) {
  const w = toUsageWindow({ usedPercent, windowSeconds: 3600, resetAt: null })
  const sum = (w.usedPercent ?? 0) + (w.remainingPercent ?? 0)
  console.log("usedPercent=" + usedPercent + " -> remainingPercent=" + w.remainingPercent + " sum=" + sum)
}
