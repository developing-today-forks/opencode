import { describe, expect, test } from "bun:test"
import { ModelRouteMatch } from "@opencode/core/model-route-match"
import { Result } from "effect"

const model = (reference: string) => {
  const slash = reference.indexOf("/")
  return { providerID: reference.slice(0, slash), id: reference.slice(slash + 1) }
}

const success = <A>(result: Result.Result<A, unknown>) => {
  if (Result.isFailure(result)) throw new Error(`expected success, got ${JSON.stringify(result.failure)}`)
  return result.success
}

const failure = <E>(result: Result.Result<unknown, E>) => {
  if (Result.isSuccess(result)) throw new Error("expected a failure")
  return result.failure
}

const pattern = (text: string) => success(ModelRouteMatch.pattern(text))
const matching = (test: ModelRouteMatch.Predicate, references: string[]) =>
  references.filter((reference) => test(model(reference)))

describe("ModelRouteMatch patterns", () => {
  const ids = [
    "openai/gpt-6-luna",
    "github-copilot/GPT-6-Luna",
    "openai/gpt-6-astra",
    "openrouter/anthropic/claude-sonnet-4-5",
    "anthropic/claude-sonnet-4-5",
  ]

  test("a pattern without a slash matches the model id in every provider, whatever its case", () => {
    expect(matching(pattern("*LUNA*"), ids)).toEqual(["openai/gpt-6-luna", "github-copilot/GPT-6-Luna"])
    // The provider is not part of what it sees.
    expect(matching(pattern("openai*"), ids)).toEqual([])
  })

  test("a pattern with a slash matches provider/model, and * runs across a slash inside a model id", () => {
    expect(matching(pattern("openrouter/*claude*"), ids)).toEqual(["openrouter/anthropic/claude-sonnet-4-5"])
    expect(matching(pattern("anthropic/*"), ids)).toEqual(["anthropic/claude-sonnet-4-5"])
    expect(matching(pattern("*/*sonnet*"), ids)).toEqual([
      "openrouter/anthropic/claude-sonnet-4-5",
      "anthropic/claude-sonnet-4-5",
    ])
  })

  test("a glob covers the whole id, so *-5 and *-6 leave 5.5 and 6.1 alone", () => {
    const versions = ["p/luna-5", "p/luna-5.5", "p/luna-6", "p/luna-6.1", "p/haiku-5"]
    expect(matching(pattern("*-5"), versions)).toEqual(["p/luna-5", "p/haiku-5"])
    expect(matching(pattern("*-6"), versions)).toEqual(["p/luna-6"])
  })

  test("re: starts a regular expression that ignores case and matches anywhere unless anchored", () => {
    const versions = ["p/LUNA-5", "p/luna-5.5", "q/luna-6", "p/sol-luna-6x"]
    expect(matching(pattern("re:luna-(5|6)$"), versions)).toEqual(["p/LUNA-5", "q/luna-6"])
    expect(matching(pattern("re:luna-6"), versions)).toEqual(["q/luna-6", "p/sol-luna-6x"])
    // With a slash it sees provider/model.
    expect(matching(pattern("re:^q/"), versions)).toEqual(["q/luna-6"])
  })

  test("an empty pattern and a malformed regular expression are refused", () => {
    expect(failure(ModelRouteMatch.pattern(""))).toBe("empty pattern")
    expect(failure(ModelRouteMatch.pattern("re:"))).toBe("empty pattern")
    expect(failure(ModelRouteMatch.pattern("re:luna-(5"))).toContain("Invalid regular expression")
  })
})

describe("ModelRouteMatch substrings", () => {
  test("text is found anywhere in the model id, whatever its case", () => {
    const haiku = success(ModelRouteMatch.substring("HAIKU"))
    expect(matching(haiku, ["anthropic/claude-haiku-4-5", "openai/gpt-6-luna"])).toEqual(["anthropic/claude-haiku-4-5"])
  })

  test("text is found anywhere in provider/model, so a provider id matches too; patterns keep their own rule", () => {
    const ids = ["anthropic/claude-opus-4-1", "openrouter/anthropic/claude-sonnet-4-5", "github-copilot/gpt-6-luna"]
    expect(matching(success(ModelRouteMatch.substring("anthropic/")), ids)).toEqual([
      "anthropic/claude-opus-4-1",
      "openrouter/anthropic/claude-sonnet-4-5",
    ])
    expect(matching(success(ModelRouteMatch.substring("Copilot")), ids)).toEqual(["github-copilot/gpt-6-luna"])
    expect(matching(success(ModelRouteMatch.substring("router")), ids)).toEqual([
      "openrouter/anthropic/claude-sonnet-4-5",
    ])
    // A pattern without a / is still tested against the model id alone.
    expect(matching(pattern("*copilot*"), ids)).toEqual([])
    expect(matching(pattern("*copilot*/*"), ids)).toEqual(["github-copilot/gpt-6-luna"])
  })

  test("empty text is refused, since it would match every model", () => {
    expect(failure(ModelRouteMatch.substring(""))).toBe("empty text, which would match every model")
  })
})

describe("ModelRouteMatch pool names", () => {
  test("a name matches a pool in any case, and an exact spelling wins", () => {
    expect(ModelRouteMatch.poolsNamed(["claude", "small-old"], "CLAUDE")).toEqual(["claude"])
    expect(ModelRouteMatch.poolsNamed(["Small", "small"], "small")).toEqual(["small"])
    expect(ModelRouteMatch.poolsNamed(["Small", "small"], "SMALL")).toEqual(["Small", "small"])
    expect(ModelRouteMatch.poolsNamed(["claude"], "claud")).toEqual([])
  })
})

describe("ModelRouteMatch expressions", () => {
  const term = (text: string): ModelRouteMatch.Expression => ({ type: "term", text })

  test("not binds tightest and or loosest", () => {
    expect(success(ModelRouteMatch.parse("a or b and not c"))).toEqual({
      type: "or",
      left: term("a"),
      right: { type: "and", left: term("b"), right: { type: "not", operand: term("c") } },
    })
  })

  test("parentheses group, keywords ignore case, and a quoted keyword is a term", () => {
    expect(success(ModelRouteMatch.parse("(A OR b) AND NOT 'and'"))).toEqual({
      type: "and",
      left: { type: "or", left: term("A"), right: term("b") },
      right: { type: "not", operand: term("and") },
    })
  })

  test("a quoted term keeps spaces and parentheses, such as a regular expression with a group", () => {
    expect(success(ModelRouteMatch.parse(`'re:gpt-(5|6)$' or "* 6"`))).toEqual({
      type: "or",
      left: term("re:gpt-(5|6)$"),
      right: term("* 6"),
    })
  })

  test("a malformed expression says what is wrong", () => {
    const cases: [string, string][] = [
      ["", "empty expression"],
      ["   ", "empty expression"],
      ["a and", "expected a pattern or pool name, found the end"],
      ["and a", 'expected a pattern or pool name, found "and"'],
      ["not", "expected a pattern or pool name, found the end"],
      ["(a or b", 'missing ")" before the end'],
      ["a or b)", 'unmatched ")"'],
      ["a b", 'expected "and" or "or" before "b"'],
      ["a xor b", "xor is not supported: write (a or b) and not (a and b)"],
      ["'re:gpt-(5", "unclosed quote in 're:gpt-"],
    ]
    expect(cases.map(([source]) => failure(ModelRouteMatch.parse(source)))).toEqual(cases.map(([, message]) => message))
  })

  test("a built expression tests each model against its terms", () => {
    const expression = success(ModelRouteMatch.parse("(*luna* or *haiku*) and not 're:-(5|6)$'"))
    const test = success(ModelRouteMatch.build(expression, ModelRouteMatch.pattern))
    expect(matching(test, ["p/luna-5", "p/luna-5.5", "p/haiku-6", "p/haiku-6.1", "p/sonnet-7", "p/LUNA-7"])).toEqual([
      "p/luna-5.5",
      "p/haiku-6.1",
      "p/LUNA-7",
    ])
  })

  test("a term the builder refuses fails the expression", () => {
    const expression = success(ModelRouteMatch.parse("*luna* or 're:luna-(5'"))
    expect(failure(ModelRouteMatch.build(expression, ModelRouteMatch.pattern))).toContain("Invalid regular expression")
  })
})

describe("ModelRouteMatch.compile", () => {
  test("a pool with only targets selects nothing more and excludes nothing", () => {
    const compiled = success(ModelRouteMatch.compile({ targets: [] }, () => undefined))
    expect(compiled.selects).toBeUndefined()
    expect(compiled.excludes(model("openai/gpt-6-luna"))).toBe(false)
    expect(compiled.rules).toEqual([])
  })

  test("include, contains and match select; exclude and notContains remove", () => {
    const compiled = success(
      ModelRouteMatch.compile(
        {
          include: ["*luna*"],
          contains: ["haiku"],
          match: "*sonnet* and not *-old",
          exclude: ["*-5"],
          notContains: ["mini"],
        },
        () => undefined,
      ),
    )
    const ids = ["p/luna-5", "p/claude-haiku-6", "p/claude-sonnet-4", "p/claude-sonnet-old", "p/opus", "p/luna-mini"]
    expect(matching((candidate) => compiled.selects?.(candidate) === true, ids)).toEqual([
      "p/luna-5",
      "p/claude-haiku-6",
      "p/claude-sonnet-4",
      "p/luna-mini",
    ])
    expect(matching(compiled.excludes, ids)).toEqual(["p/luna-5", "p/luna-mini"])
  })

  test("a term that names a pool stands for what the resolver returns for it", () => {
    const compiled = success(
      ModelRouteMatch.compile({ include: ["claude"] }, (text) =>
        text === "claude" ? (candidate) => candidate.id === "picked" : undefined,
      ),
    )
    expect(matching((candidate) => compiled.selects?.(candidate) === true, ["p/picked", "p/claude"])).toEqual([
      "p/picked",
    ])
  })

  test("every malformed entry is reported with where it is in the pool", () => {
    const problems = failure(
      ModelRouteMatch.compile(
        {
          include: ["*luna*", "re:("],
          exclude: [""],
          contains: [""],
          match: "a b",
          variantRules: [
            { match: "*argon*", map: { max: false } },
            { match: "x and", map: {} },
          ],
        },
        () => undefined,
      ),
    )
    expect(problems.map((problem) => problem.path.join("."))).toEqual([
      "include.1",
      "contains.0",
      "match",
      "exclude.0",
      "variantRules.1.match",
    ])
  })

  test("a pool that nothing could ever join is a problem; an explicit empty target list is not", () => {
    const none = [{ path: [], message: "it has no targets, include, contains or match" }]
    expect(ModelRouteMatch.problems({})).toEqual(none)
    expect(ModelRouteMatch.problems({ exclude: ["*-mini"] })).toEqual(none)
    expect(ModelRouteMatch.problems({ targets: [] })).toEqual([])
    expect(ModelRouteMatch.problems({ match: "*luna*" })).toEqual([])
  })
})
