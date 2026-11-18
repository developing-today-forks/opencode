import { describe, expect, test } from "bun:test"
import { parseDotEnv } from "../src/providers/vibe-auth"
import { Wildcard } from "../../core/src/util/wildcard.ts"
import { activityCalendar } from "../../util/src/activity-calendar.ts"

describe("probe dotenv", () => {
  test("cases", () => {
    console.log("dq-escape:", JSON.stringify(parseDotEnv('A="x\\ny"')))
    console.log("multiline:", JSON.stringify(parseDotEnv('A="line1\nB=injected\nline3"\nC=real')))
    console.log("junk:", JSON.stringify(parseDotEnv('A="x" junk')))
    console.log("tabcomment:", JSON.stringify(parseDotEnv("A=x\t# note")))
    console.log("exporttab:", JSON.stringify(parseDotEnv("export\tA=1")))
    console.log("nospace:", JSON.stringify(parseDotEnv('A="x#y"#c')))
    console.log("sq:", JSON.stringify(parseDotEnv("A='x\\'y'")))
    console.log("unqhash:", JSON.stringify(parseDotEnv("A=x#y")))
    console.log("tabafter:", JSON.stringify(parseDotEnv('A="x"\t# note')))
    expect(true).toBe(true)
  })
})
describe("probe wildcard", () => {
  test("cases", () => {
    const cases: Array<[string, string]> = [
      ["foo", "foo *"], ["foo bar baz", "foo *"], ["foobar", "foo *"],
      ["a/c", "a?c"], ["ABC", "abc"], ["git status", "git *"], ["git", "git *"],
      ["foo ", "foo *"], ["x", "*"], ["a.b", "a.b"], ["axb", "a.b"], ["foo*bar", "foo*bar"],
    ]
    for (const [i, p] of cases) console.log(`wc input=${JSON.stringify(i)} pattern=${JSON.stringify(p)} -> ${Wildcard.match(i, p)}`)
    expect(true).toBe(true)
  })
})
describe("probe calendar dup dates", () => {
  test("dup", () => {
    const from = new Date("2026-11-02T00:00:00").getTime()
    const to = new Date("2026-11-09T00:00:00").getTime()
    const out = activityCalendar({ activity: [{ date: "2026-11-03", steps: 5 }, { date: "2026-11-03", steps: 7 }], from, to, maxWeeks: 4 })
    console.log("cal-dup:", JSON.stringify(out.weeks.flat().filter((d) => d.steps > 0)))
    expect(true).toBe(true)
  })
})
