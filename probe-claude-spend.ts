import { toClaudeUsage } from "./packages/ai/src/quota/providers/claude.ts"
const cases: [string, unknown][] = [
  ["neg-used", { spend: { enabled: true, percent: 50, used: { amount_minor: -500, exponent: 2, currency: "USD" }, limit: { amount_minor: 1000, exponent: 2, currency: "USD" } } }],
  ["neg-limit", { spend: { enabled: true, percent: 50, used: { amount_minor: 500, exponent: 2, currency: "USD" }, limit: { amount_minor: -1000, exponent: 2, currency: "USD" } } }],
  ["used-only-neg-no-percent", { spend: { enabled: true, used: { amount_minor: -500, exponent: 2, currency: "USD" } } }],
  ["spend-enabled-no-figures", { spend: { enabled: true } }],
  ["spend-enabled-percent-only", { spend: { enabled: true, percent: 42 } }],
  ["huge-exponent", { spend: { enabled: true, percent: 50, used: { amount_minor: 500, exponent: 999, currency: "USD" }, limit: { amount_minor: 1000, exponent: 999, currency: "USD" } } }],
  ["neg-exponent", { spend: { enabled: true, percent: 50, used: { amount_minor: 5, exponent: -2, currency: "USD" }, limit: { amount_minor: 10, exponent: -2, currency: "USD" } } }],
  ["control-positive", { spend: { enabled: true, percent: 50, used: { amount_minor: 500, exponent: 2, currency: "USD" }, limit: { amount_minor: 1000, exponent: 2, currency: "USD" } } }],
  ["control-zero", { spend: { enabled: true, percent: 0, used: { amount_minor: 0, exponent: 2, currency: "USD" }, limit: { amount_minor: 1000, exponent: 2, currency: "USD" } } }],
]
for (const [name, payload] of cases) {
  const r = toClaudeUsage(payload as never)
  console.log(name, JSON.stringify(r.windows))
}
