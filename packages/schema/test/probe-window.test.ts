import { test, expect } from "bun:test"
import { Schema } from "effect"
import { ConfigModelRoutes } from "../src/config/model-routes.js"
import { ModelRouteSchedule } from "../../core/src/model-route-schedule.js"

const decode = Schema.decodeUnknownSync(ConfigModelRoutes.Window)
const cases: [string, unknown][] = [
  ["empty daysOfWeek", { daysOfWeek: [] }],
  ["empty daysOfMonth", { daysOfMonth: [] }],
  ["empty excludeWindows", { excludeWindows: [] }],
  ["empty dates (control, #2035 rejects)", { dates: [] }],
  ["empty excludeDates (control, #2035 rejects)", { excludeDates: [] }],
  ["empty object (control)", {}],
  ["lowercase day name (control)", { daysOfWeek: ["mon"] }],
  ["capitalised day name", { daysOfWeek: ["Mon"] }],
  ["padded day name", { daysOfWeek: [" mon "] }],
  ["numeric-string day", { daysOfWeek: ["3"] }],
  ["numeric day (control)", { daysOfWeek: [3] }],
  ["numeric-string day-of-month", { daysOfMonth: ["15"] }],
  ["numeric day-of-month (control)", { daysOfMonth: [15] }],
  ["padded excludeWindows name", { excludeWindows: [" peak "] }],
  ["plain excludeWindows name (control)", { excludeWindows: ["peak"] }],
  ["from zero", { from: 0, until: 1000 }],
  ["from fractional", { from: 1.5, until: 1000 }],
  ["from/until normal (control)", { from: 100, until: 1000 }],
]
test("probe", () => {
  for (const [name, input] of cases) {
    let dec = "ACCEPT"
    try { decode(input as any) } catch { dec = "REJECT" }
    const parsed = ModelRouteSchedule.parse(input)
    console.log(`${name}: schema=${dec} parser=${parsed === undefined ? "DROP" : "ACCEPT " + JSON.stringify(parsed)}`)
  }
  expect(true).toBe(true)
})
