import { describe, expect, test } from "bun:test"
import { provider as deepseekProvider } from "../src/quota/providers/deepseek.js"

const fetchWith = (payload: unknown) =>
  deepseekProvider.fetchQuota({
    credentials: [
      { id: "row-1", integrationID: "deepseek", active: true, value: { type: "key", key: "fixture-key" } },
    ],
    disabledProviders: new Set<string>(),
    instances: new Map(),
    providerConfig: {},
    fetchImpl: async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
    env: {},
  } as never)

describe("probe deepseek zero third-currency", () => {
  test("zero EUR only", async () => {
    const r = await fetchWith({ balance_infos: [{ currency: "EUR", total_balance: 0 }] })
    console.log("EUR0:", r.ok, r.error, r.usage?.windows.credits_balance?.valueLabel)
  })
  test("zero GBP string only", async () => {
    const r = await fetchWith({ balance_infos: [{ currency: "GBP", total_balance: "0" }] })
    console.log("GBP0:", r.ok, r.error, r.usage?.windows.credits_balance?.valueLabel)
  })
  test("controls: zero USD, zero CNY, positive EUR", async () => {
    const usd = await fetchWith({ balance_infos: [{ currency: "USD", total_balance: 0 }] })
    console.log("USD0:", usd.ok, usd.usage?.windows.credits_balance?.valueLabel)
    const cny = await fetchWith({ balance_infos: [{ currency: "CNY", total_balance: 0 }] })
    console.log("CNY0:", cny.ok, cny.usage?.windows.credits_balance?.valueLabel)
    const eur = await fetchWith({ balance_infos: [{ currency: "EUR", total_balance: "100" }] })
    console.log("EUR100:", eur.ok, eur.usage?.windows.credits_balance?.valueLabel)
  })
  test("zero EUR alongside negative USD", async () => {
    const r = await fetchWith({ balance_infos: [{ currency: "USD", total_balance: -5 }, { currency: "EUR", total_balance: 0 }] })
    console.log("USD-5+EUR0:", r.ok, r.error, r.usage?.windows.credits_balance?.valueLabel)
  })
})
