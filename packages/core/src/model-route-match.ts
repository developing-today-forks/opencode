export * as ModelRouteMatch from "./model-route-match.js"

import type { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { Result } from "effect"

/** A model as a pool's matching keys see it. */
export interface Candidate {
  readonly providerID: string
  readonly id: string
}

export type Predicate = (candidate: Candidate) => boolean

/** A parsed `match` expression. A term is a pattern or the name of another pool. */
export type Expression =
  | { readonly type: "term"; readonly text: string }
  | { readonly type: "not"; readonly operand: Expression }
  | { readonly type: "and" | "or"; readonly left: Expression; readonly right: Expression }

/** One `variantRules` entry: the level remap for the models its `match` selects. */
export interface Rule {
  readonly applies: Predicate
  readonly map: Readonly<Record<string, string | false>>
}

/** A pool's matching keys, ready to test models. `selects` is unset when the pool has no include,
 * contains or match, so it pulls in nothing beyond its targets. */
export interface Compiled {
  readonly selects?: Predicate
  readonly excludes: Predicate
  readonly rules: readonly Rule[]
}

export interface Problem {
  /** Where the problem is inside the pool, such as ["include", "2"]. */
  readonly path: readonly string[]
  readonly message: string
}

export type Keys = Pick<
  ConfigModelRoutes.Route,
  "targets" | "include" | "exclude" | "contains" | "notContains" | "match" | "variantRules"
>

/** Compiles a pool's matching keys. `reference` turns a term that names another pool into that pool's
 * models; every other term is a pattern. Fails with every malformed entry, so a pool is never built
 * from part of what it says. */
export function compile(
  route: Keys,
  reference: (text: string) => Predicate | undefined,
): Result.Result<Compiled, readonly Problem[]> {
  const problems: Problem[] = []
  const keep = (path: readonly string[], result: Result.Result<Predicate, string>) => {
    if (Result.isFailure(result)) problems.push({ path, message: result.failure })
    return Result.isSuccess(result) ? [result.success] : []
  }
  const term = (text: string) => {
    const pool = reference(text)
    return pool ? Result.succeed(pool) : pattern(text)
  }
  const expression = (source: string) => Result.flatMap(parse(source), (parsed) => build(parsed, term))
  const each = (
    key: "include" | "exclude" | "contains" | "notContains",
    read: (text: string) => Result.Result<Predicate, string>,
  ) => (route[key] ?? []).flatMap((text, index) => keep([key, String(index)], read(text)))
  const selects = [
    ...each("include", term),
    ...each("contains", substring),
    ...(route.match === undefined ? [] : keep(["match"], expression(route.match))),
  ]
  const excludes = [...each("exclude", term), ...each("notContains", substring)]
  const rules = (route.variantRules ?? []).flatMap((rule, index) =>
    keep(["variantRules", String(index), "match"], expression(rule.match)).map((applies) => ({
      applies,
      map: rule.map,
    })),
  )
  if (problems.length > 0) return Result.fail(problems)
  return Result.succeed({
    ...(route.include !== undefined || route.contains !== undefined || route.match !== undefined
      ? { selects: (candidate: Candidate) => selects.some((test) => test(candidate)) }
      : {}),
    excludes: (candidate) => excludes.some((test) => test(candidate)),
    rules,
  })
}

/** Why the config loader skips a pool: nothing could ever join it, or a matching key is malformed. Pool
 * names are known only once every config file is read, so each term is checked as a pattern here; a
 * pool name is always a valid one. */
export function problems(route: Keys): readonly Problem[] {
  const compiled = compile(route, () => undefined)
  return [
    ...(route.targets === undefined &&
    route.include === undefined &&
    route.contains === undefined &&
    route.match === undefined
      ? [{ path: [], message: "it has no targets, include, contains or match" }]
      : []),
    ...(Result.isFailure(compiled) ? compiled.failure : []),
  ]
}

/** `re:` and a regular expression, or text where `*` stands for any run of characters. With a `/` it is
 * tested against `provider/model`, without one against the model id in every provider. Case never
 * matters. A glob covers the whole id; a regular expression may match part of it unless anchored. */
export function pattern(text: string): Result.Result<Predicate, string> {
  if (text === "" || text === "re:") return Result.fail("empty pattern")
  const subject = subjectOf(text)
  const expression = text.startsWith("re:")
    ? Result.try({
        try: () => new RegExp(text.slice(3), "i"),
        catch: (error) => (error instanceof Error ? error.message : String(error)),
      })
    : Result.succeed(new RegExp(`^${text.split("*").map(escape).join(".*")}$`, "i"))
  return Result.map(
    expression,
    (regex): Predicate =>
      (candidate) =>
        regex.test(subject(candidate)),
  )
}

/** A `contains` or `notContains` entry: text found anywhere in `provider/model`, so a provider id matches too.
 * Case never matters. */
export function substring(text: string): Result.Result<Predicate, string> {
  if (text === "") return Result.fail("empty text, which would match every model")
  const needle = text.toLowerCase()
  return Result.succeed((candidate) => `${candidate.providerID}/${candidate.id}`.toLowerCase().includes(needle))
}

/** The pools a name may refer to, in configuration order: the one spelled exactly so, else each one whose id
 * matches ignoring case. A pool name matches in any case wherever a pool is named. */
export function poolsNamed(ids: Iterable<string>, name: string): readonly string[] {
  const all = [...ids]
  if (all.includes(name)) return [name]
  const lower = name.toLowerCase()
  return all.filter((id) => id.toLowerCase() === lower)
}

const TOKEN = /\s+|[()]|'[^']*'|"[^"]*"|[^\s()]+/g

/** Parses a `match` expression: terms joined by `and`, `or` and `not`, with parentheses; `not` binds
 * tightest and `or` loosest. A term with spaces or parentheses, such as a regular expression with a
 * group, goes in single or double quotes. Keywords ignore case, and a quoted keyword is a term. */
export function parse(source: string): Result.Result<Expression, string> {
  const tokens = Array.from(source.matchAll(TOKEN), (match) => match[0]).filter((token) => token.trim() !== "")
  const unclosed = tokens.find((token) => /^['"]/.test(token) && (token.length < 2 || !token.endsWith(token[0])))
  if (unclosed !== undefined) return Result.fail(`unclosed quote in ${unclosed}`)
  if (tokens.length === 0) return Result.fail("empty expression")
  // Quoted tokens keep their quotes here, so a quoted keyword never reads as one.
  const keyword = (index: number, word: string) => tokens[index]?.toLowerCase() === word
  const shown = (index: number) => (index < tokens.length ? `"${tokens[index]}"` : "the end")
  type Step = Result.Result<readonly [Expression, number], string>

  const primary = (index: number): Step => {
    if (tokens[index] === "(") {
      const inner = either(index + 1)
      if (Result.isFailure(inner)) return inner
      const [expression, next] = inner.success
      return tokens[next] === ")"
        ? Result.succeed([expression, next + 1])
        : Result.fail(`missing ")" before ${shown(next)}`)
    }
    if (index >= tokens.length || tokens[index] === ")" || ["and", "or"].some((word) => keyword(index, word)))
      return Result.fail(`expected a pattern or pool name, found ${shown(index)}`)
    const token = tokens[index]
    const text = /^['"]/.test(token) ? token.slice(1, -1) : token
    return Result.succeed([{ type: "term", text }, index + 1])
  }
  const negation = (index: number): Step =>
    keyword(index, "not")
      ? Result.map(negation(index + 1), ([operand, next]) => [{ type: "not", operand }, next] as const)
      : primary(index)
  const chain =
    (type: "and" | "or", operand: (index: number) => Step) =>
    (index: number): Step => {
      const first = operand(index)
      if (Result.isFailure(first) || !keyword(first.success[1], type)) return first
      const [left, next] = first.success
      return Result.map(chain(type, operand)(next + 1), ([right, end]) => [{ type, left, right }, end] as const)
    }
  const both = chain("and", negation)
  const either = chain("or", both)

  const parsed = either(0)
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
  const [expression, end] = parsed.success
  if (end === tokens.length) return Result.succeed(expression)
  if (keyword(end, "xor")) return Result.fail("xor is not supported: write (a or b) and not (a and b)")
  if (tokens[end] === ")") return Result.fail('unmatched ")"')
  return Result.fail(`expected "and" or "or" before ${shown(end)}`)
}

/** The predicate of a parsed expression, with each term turned into one by `term`. */
export function build(
  expression: Expression,
  term: (text: string) => Result.Result<Predicate, string>,
): Result.Result<Predicate, string> {
  if (expression.type === "term") return term(expression.text)
  if (expression.type === "not")
    return Result.map(
      build(expression.operand, term),
      (operand): Predicate =>
        (candidate) =>
          !operand(candidate),
    )
  const type = expression.type
  return Result.map(
    Result.all([build(expression.left, term), build(expression.right, term)]),
    ([left, right]): Predicate =>
      type === "and"
        ? (candidate) => left(candidate) && right(candidate)
        : (candidate) => left(candidate) || right(candidate),
  )
}

const subjectOf = (text: string) =>
  text.includes("/")
    ? (candidate: Candidate) => `${candidate.providerID}/${candidate.id}`
    : (candidate: Candidate) => candidate.id

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
