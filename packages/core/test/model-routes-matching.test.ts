import { describe, expect, test } from "bun:test"
import { expand, routeVariants } from "@opencode/core/config/plugin/model-routes"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { Schema } from "effect"

const model = (providerID: string, id: string, variants: string[], enabled = true) =>
  [
    id,
    {
      ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id)),
      variants: variants.map((variant) => ({ id: Model.VariantID.make(variant) })),
      enabled,
    },
  ] as const

const ALL = ["low", "medium", "high", "xhigh", "max"]

// Provider order is anthropic, openai, github-copilot; a pool's matched models follow it.
const catalog = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
  [
    Provider.ID.make("anthropic"),
    new Map([
      model("anthropic", "claude-haiku-5", ["low", "high"]),
      model("anthropic", "claude-haiku-5.5", ["low", "medium", "high"]),
      model("anthropic", "claude-sonnet-6", ALL),
      model("anthropic", "claude-opus-6.1", ["high", "max"]),
      model("anthropic", "claude-mythos-1", ["high"]),
      model("anthropic", "claude-haiku-old", ["low"], false),
    ]),
  ],
  [
    Provider.ID.make("openai"),
    new Map([
      model("openai", "luna-5", ALL),
      model("openai", "luna-5.5", ALL),
      model("openai", "luna-6", ALL),
      model("openai", "luna-6.1", ALL),
      model("openai", "luna-mini", ["low", "high"]),
      model("openai", "argon", ["low", "medium", "high"]),
    ]),
  ],
  [
    Provider.ID.make("github-copilot"),
    new Map([
      model("github-copilot", "LUNA-6.1", ["medium", "high"]),
      model("github-copilot", "claude-opus-6.1", ["high"]),
    ]),
  ],
])

/** Pools decoded the way the config loader decodes them. */
const pools = (input: Record<string, unknown>) =>
  new Map(
    Object.entries(input).map(([id, route]) => [id, Schema.decodeUnknownSync(ConfigModelRoutes.Route)(route)] as const),
  )

const refs = (id: string, routes: ReturnType<typeof pools>) =>
  expand(id, routes, catalog).leaves.map(
    (leaf) => `${leaf.ref.providerID}/${leaf.ref.id}${leaf.ref.variant ? `#${leaf.ref.variant}` : ""}`,
  )

const remaps = (id: string, routes: ReturnType<typeof pools>) =>
  Object.fromEntries(
    expand(id, routes, catalog).leaves.map((leaf) => [
      `${leaf.ref.providerID}/${leaf.ref.id}`,
      Object.fromEntries(
        Object.entries(leaf.variantMap ?? {}).map(([level, to]): [string, string | false] => [
          level,
          to === false ? false : String(to),
        ]),
      ),
    ]),
  )

const offered = (id: string, routes: ReturnType<typeof pools>) =>
  routeVariants(expand(id, routes, catalog).leaves, routes.get(id)?.levels).map((variant) => String(variant.id))

describe("pool matching keys", () => {
  test("include joins models from every provider in provider order, whatever the case, without disabled ones", () => {
    expect(refs("small", pools({ small: { include: ["*luna*", "*HAIKU*"] } }))).toEqual([
      "anthropic/claude-haiku-5",
      "anthropic/claude-haiku-5.5",
      "openai/luna-5",
      "openai/luna-5.5",
      "openai/luna-6",
      "openai/luna-6.1",
      "openai/luna-mini",
      "github-copilot/LUNA-6.1",
    ])
  })

  test("exclude removes what it matches, so the small pool keeps 5.5 and 6.1", () => {
    const routes = pools({ small: { include: ["*luna*", "*haiku*"], exclude: ["*-5", "*-6", "*-mini"] } })
    expect(refs("small", routes)).toEqual([
      "anthropic/claude-haiku-5.5",
      "openai/luna-5.5",
      "openai/luna-6.1",
      "github-copilot/LUNA-6.1",
    ])
  })

  test("contains finds text in the model id across providers, and notContains takes it back out", () => {
    const routes = pools({ claude: { contains: ["haiku", "SONNET", "opus", "mythos"], notContains: ["Mythos"] } })
    expect(refs("claude", routes)).toEqual([
      "anthropic/claude-haiku-5",
      "anthropic/claude-haiku-5.5",
      "anthropic/claude-sonnet-6",
      "anthropic/claude-opus-6.1",
      "github-copilot/claude-opus-6.1",
    ])
  })

  test("contains and notContains search the whole provider/model text, so a provider id matches too", () => {
    const routes = pools({
      copilot: { contains: ["copilot"] },
      "luna-elsewhere": { contains: ["luna"], notContains: ["OpenAI"] },
      // A pattern keeps its own rule: without a /, it is tested against the model id alone.
      "copilot-pattern": { include: ["*copilot*"] },
    })
    expect(refs("copilot", routes)).toEqual(["github-copilot/LUNA-6.1", "github-copilot/claude-opus-6.1"])
    expect(refs("luna-elsewhere", routes)).toEqual(["github-copilot/LUNA-6.1"])
    expect(refs("copilot-pattern", routes)).toEqual([])
  })

  test("match joins the models one expression selects", () => {
    const routes = pools({ small: { match: "(*luna* or *haiku*) and not 're:-(5|6)$' and not *mini*" } })
    expect(refs("small", routes)).toEqual([
      "anthropic/claude-haiku-5.5",
      "openai/luna-5.5",
      "openai/luna-6.1",
      "github-copilot/LUNA-6.1",
    ])
  })

  test("targets come first in their order, matched models follow, and no model is added twice", () => {
    const routes = pools({
      mixed: {
        targets: ["openai/luna-6.1#high", "anthropic/claude-sonnet-6"],
        include: ["*luna-6*", "*sonnet*"],
      },
    })
    const result = expand("mixed", routes, catalog)
    expect(refs("mixed", routes)).toEqual([
      "openai/luna-6.1#high",
      "anthropic/claude-sonnet-6",
      "openai/luna-6",
      "github-copilot/LUNA-6.1",
    ])
    expect(result.leaves.map((leaf) => leaf.fixedVariant)).toEqual([true, false, false, false])
    expect(result.nodes[0].children).toEqual([{ leaf: 0 }, { leaf: 1 }, { leaf: 2 }, { leaf: 3 }])
  })

  test("exclude also removes a pool's targets and the members its nested pools bring", () => {
    const routes = pools({
      inner: { targets: ["openai/luna-5", "openai/luna-5.5"] },
      outer: {
        targets: ["opencode-route/inner", "anthropic/claude-haiku-5", "anthropic/claude-haiku-5.5"],
        exclude: ["*-5"],
      },
    })
    expect(refs("outer", routes)).toEqual(["openai/luna-5.5", "anthropic/claude-haiku-5.5"])
    expect(expand("outer", routes, catalog).nodes.map((node) => node.children)).toEqual([
      [{ node: 1 }, { leaf: 1 }],
      [{ leaf: 0 }],
    ])
    // The nested pool on its own keeps what only the outer pool excludes.
    expect(refs("inner", routes)).toEqual(["openai/luna-5", "openai/luna-5.5"])
  })

  test("a pool named in include, exclude or match stands for that pool's models", () => {
    const routes = pools({
      claude: { contains: ["haiku", "sonnet", "opus", "mythos"] },
      "frontier-direct": { include: ["anthropic/*opus*", "anthropic/*mythos*"] },
      "claude-agg": { include: ["claude"], exclude: ["frontier-direct"] },
      "claude-expr": { match: "opencode-route/claude and not frontier-direct" },
    })
    const expected = [
      "anthropic/claude-haiku-5",
      "anthropic/claude-haiku-5.5",
      "anthropic/claude-sonnet-6",
      "github-copilot/claude-opus-6.1",
    ]
    expect(refs("claude-agg", routes)).toEqual(expected)
    expect(refs("claude-expr", routes)).toEqual(expected)
  })

  test("a pool name matches in any case wherever a pool names another pool", () => {
    const routes = pools({
      Lunas: { targets: ["openai/luna-6", "openai/luna-6.1"] },
      claude: { contains: ["opus"] },
      // A nested pool reference, and its weight key.
      "by-target": {
        targets: ["opencode-route/lunas", "anthropic/claude-mythos-1"],
        selection: "weighted",
        weights: { "OPENCODE-ROUTE/LUNAS": 3 },
      },
      // Matching keys and an expression.
      "by-name": { include: ["CLAUDE", "openai/luna-6*"], exclude: ["opencode-route/LUNAS"] },
      "by-expression": { match: "OPENCODE-ROUTE/Claude and not github-copilot/*" },
      // A variant rule's match.
      "by-rule": { targets: ["openai/luna-6"], variantRules: [{ match: "LUNAS", map: { max: false } }] },
    })
    expect(refs("by-target", routes)).toEqual(["openai/luna-6", "openai/luna-6.1", "anthropic/claude-mythos-1"])
    expect(expand("by-target", routes, catalog).nodes[0].weights).toEqual([3, 1])
    expect(refs("by-name", routes)).toEqual(["anthropic/claude-opus-6.1", "github-copilot/claude-opus-6.1"])
    expect(refs("by-expression", routes)).toEqual(["anthropic/claude-opus-6.1"])
    expect(remaps("by-rule", routes)["openai/luna-6"]).toEqual({ max: false })
    for (const id of ["by-target", "by-name", "by-expression", "by-rule"])
      expect(expand(id, routes, catalog).diagnostics).toEqual([])
  })

  test("a pool name that matches several pools only ignoring case uses the first, and says so", () => {
    const routes = pools({
      Small: { targets: ["anthropic/claude-haiku-5"] },
      small: { targets: ["anthropic/claude-haiku-5.5"] },
      exact: { include: ["small"] },
      loose: { include: ["SMALL"] },
    })
    expect(refs("exact", routes)).toEqual(["anthropic/claude-haiku-5.5"])
    expect(expand("exact", routes, catalog).diagnostics).toEqual([])
    expect(refs("loose", routes)).toEqual(["anthropic/claude-haiku-5"])
    expect(expand("loose", routes, catalog).diagnostics).toEqual([
      "pool loose names SMALL, which matches Small, small ignoring case; it uses Small",
    ])
  })

  test("a pool that names itself, directly or through others, adds nothing for that name and reports nothing", () => {
    const routes = pools({
      self: { include: ["self", "*argon*"], exclude: ["self"] },
      "small-all": { include: ["small", "small-old", "small-all"] },
      small: { include: ["*haiku-5.5"] },
      "small-old": { include: ["*haiku-5", "small-all"] },
      a: { targets: ["opencode-route/b"] },
      b: { include: ["a", "*argon*"] },
    })
    expect(refs("self", routes)).toEqual(["openai/argon"])
    expect(refs("small-all", routes)).toEqual(["anthropic/claude-haiku-5", "anthropic/claude-haiku-5.5"])
    expect(refs("small-old", routes)).toEqual(["anthropic/claude-haiku-5", "anthropic/claude-haiku-5.5"])
    expect(refs("a", routes)).toEqual(["openai/argon"])
    for (const id of routes.keys()) expect(expand(id, routes, catalog).diagnostics).toEqual([])
  })

  test("an opencode-route/ name that is not a pool is reported; any other unknown name is a pattern", () => {
    const result = expand("p", pools({ p: { include: ["opencode-route/nope", "argon"] } }), catalog)
    expect(result.leaves.map((leaf) => String(leaf.ref.id))).toEqual(["argon"])
    expect(result.diagnostics).toEqual(["pool p names opencode-route/nope, which is not a pool"])
  })

  test("a nested pool pinned to a variant brings only the matched models that have it, at that variant", () => {
    const routes = pools({ outer: { targets: ["opencode-route/lunas#xhigh"] }, lunas: { include: ["openai/luna-*"] } })
    expect(refs("outer", routes)).toEqual([
      "openai/luna-5#xhigh",
      "openai/luna-5.5#xhigh",
      "openai/luna-6#xhigh",
      "openai/luna-6.1#xhigh",
    ])
  })

  test("weights and budgets reach models a pool pulled in by pattern", () => {
    const routes = pools({
      weighted: {
        include: ["*argon*", "openai/luna-6.1"],
        selection: "weighted",
        weights: { "openai/argon": 3 },
        budgets: { "openai/argon": { requestsPerDay: 10 } },
      },
    })
    const result = expand("weighted", routes, catalog)
    expect(refs("weighted", routes)).toEqual(["openai/luna-6.1", "openai/argon"])
    expect(result.nodes[0].weights).toEqual([1, 3])
    expect(result.leaves[1].budget).toEqual({ requestsPerDay: 10 })
  })

  test("a malformed pool that never went through the config loader contributes nothing", () => {
    const result = expand("bad", pools({ bad: { include: ["*luna*", "re:("] } }), catalog)
    expect(result.leaves).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toStartWith("pool bad is skipped: include.1: ")
  })

  test("a pool named many times over is expanded once per expansion", () => {
    // Pool k names pools k-1 and k-2. Expanded again at every mention, the last pool would expand 1,973 pools
    // here and about 243,000 at 26 pools. The expansion is synchronous, so a test timeout could never stop
    // that; counting model lookups catches it at once. Each pool scans the catalog once, so lookups stay
    // under pools x models.
    const catalogSize = 300
    const poolCount = 16
    const large = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
      [
        Provider.ID.make("p"),
        new Map(
          Array.from({ length: catalogSize }, (_, index) =>
            model("p", `m${index}-${["luna", "haiku", "other"][index % 3]}`, []),
          ),
        ),
      ],
    ])
    const routes = pools(
      Object.fromEntries(
        Array.from({ length: poolCount }, (_, index) => [
          `p${index}`,
          { include: index === 0 ? ["*luna*"] : index === 1 ? ["*haiku*"] : [`p${index - 1}`, `p${index - 2}`] },
        ]),
      ),
    )
    const lookups = { count: 0 }
    const ids = expand(`p${poolCount - 1}`, routes, large, (providerID, modelID) => {
      lookups.count++
      return large.get(providerID)?.get(modelID)
    }).leaves.map((leaf) => String(leaf.ref.id))
    expect(ids).toHaveLength(200)
    expect(ids.every((id) => id.endsWith("-luna") || id.endsWith("-haiku"))).toBe(true)
    expect(lookups.count).toBeGreaterThan(0)
    expect(lookups.count).toBeLessThanOrEqual(poolCount * catalogSize)
  })

  test("a pool nested along many paths looks each model up once, and expands as it did before", () => {
    // Pool k targets pools k-1 and k-2 and its own glob, so p7 is reached along 41 paths. Each path used to
    // look every model its glob matches up again before finding it placed: 410 lookups here, and 5.4 million
    // for 20 pools over 2,000 models, which took about 3.8 s. The leaves and nodes below are what the
    // expansion gave before that changed.
    const ids = Array.from({ length: 30 }, (_, index) => `m${index}-${["luna", "haiku", "other"][index % 3]}`)
    const large = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
      [Provider.ID.make("p"), new Map(ids.map((id) => model("p", id, [])))],
    ])
    const routes = pools(
      Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          `p${index}`,
          index < 2
            ? { targets: [index === 0 ? "p/*-luna" : "p/*-haiku"] }
            : { targets: [`opencode-route/p${index - 1}`, `opencode-route/p${index - 2}`, "p/*-other"] },
        ]),
      ),
    )
    const lookups = { count: 0 }
    const result = expand("p7", routes, large, (providerID, modelID) => {
      lookups.count++
      return large.get(providerID)?.get(modelID)
    })
    const named = (suffix: string) => ids.filter((id) => id.endsWith(suffix))
    // The deepest path comes first: p1 places the haiku models, p0 the luna ones, then p2 the others.
    expect(result.leaves.map((leaf) => String(leaf.ref.id))).toEqual([
      ...named("-haiku"),
      ...named("-luna"),
      ...named("-other"),
    ])
    expect(lookups.count).toBe(ids.length)
    // Every visit leaves a node, in the order of the visits. Only the first visit of each pool has children.
    expect(result.nodes.map((node) => node.routeID).join(" ")).toBe(
      "p7 p6 p5 p4 p3 p2 p1 p0 p1 p2 p1 p0 p3 p2 p1 p0 p1 p4 p3 p2 p1 p0 p1 p2 p1 p0 p5 p4 p3 p2 p1 p0 p1 p2 p1 p0 p3 p2 p1 p0 p1",
    )
    const leaves = (from: number) => Array.from({ length: 10 }, (_, index) => ({ leaf: from + index }))
    expect(
      result.nodes.flatMap((node, index) => (node.children.length > 0 ? [[index, node.routeID, node.children]] : [])),
    ).toEqual([
      [0, "p7", [{ node: 1 }]],
      [1, "p6", [{ node: 2 }]],
      [2, "p5", [{ node: 3 }]],
      [3, "p4", [{ node: 4 }]],
      [4, "p3", [{ node: 5 }]],
      [5, "p2", [{ node: 6 }, { node: 7 }, ...leaves(20)]],
      [6, "p1", leaves(0)],
      [7, "p0", leaves(10)],
    ])
  })
})

describe("pool effort levels", () => {
  test("false makes a target sit a level out, so the rest of the pool still offers it", () => {
    const routes = pools({
      big: {
        targets: [
          { model: "openai/argon", variants: { xhigh: "high", max: false } },
          "openai/luna-6",
          "anthropic/claude-sonnet-6",
        ],
      },
      before: {
        targets: [{ model: "openai/argon", variants: { xhigh: "high" } }, "openai/luna-6", "anthropic/claude-sonnet-6"],
      },
    })
    expect(remaps("big", routes)["openai/argon"]).toEqual({ xhigh: "high", max: false })
    expect(offered("big", routes)).toEqual(ALL)
    // A target that cannot run max and does not say it sits it out still takes max from the pool.
    expect(offered("before", routes)).toEqual(["low", "medium", "high", "xhigh"])
  })

  test("variantRules remap the levels of the models a pool pulled in by pattern", () => {
    const routes = pools({
      "smart-fast": {
        include: ["*argon*", "openai/luna-6"],
        variantRules: [{ match: "*argon*", map: { medium: "high", high: "high", xhigh: "high", max: "high" } }],
      },
    })
    expect(remaps("smart-fast", routes)).toEqual({
      "openai/luna-6": {},
      "openai/argon": { medium: "high", high: "high", xhigh: "high", max: "high" },
    })
    expect(offered("smart-fast", routes)).toEqual(ALL)
  })

  test("declared levels are all a pool offers, and a model that cannot run one sits it out", () => {
    const routes = pools({
      small: {
        include: ["anthropic/claude-haiku-5", "openai/luna-6.1", "anthropic/claude-mythos-1"],
        levels: ["low", "medium", "high"],
      },
    })
    expect(remaps("small", routes)).toEqual({
      "anthropic/claude-haiku-5": { medium: false },
      "anthropic/claude-mythos-1": { low: false, medium: false },
      "openai/luna-6.1": {},
    })
    expect(offered("small", routes)).toEqual(["low", "medium", "high"])
    expect(expand("small", routes, catalog).diagnostics).toEqual([])
  })

  test("a declared level no model can run is left out and reported, until a rule maps it onto one", () => {
    const declared = { include: ["anthropic/claude-haiku-5", "openai/luna-6.1"], levels: ["low", "ultra"] }
    const routes = pools({
      small: declared,
      mapped: { ...declared, variantRules: [{ match: "*luna*", map: { ultra: "max" } }] },
    })
    expect(offered("small", routes)).toEqual(["low"])
    expect(expand("small", routes, catalog).diagnostics).toEqual([
      "pool small declares level ultra, but none of its models can run it, so it is not offered",
    ])
    expect(offered("mapped", routes)).toEqual(["low", "ultra"])
    expect(remaps("mapped", routes)).toEqual({
      "anthropic/claude-haiku-5": { ultra: false },
      "openai/luna-6.1": { ultra: "max" },
    })
    expect(expand("mapped", routes, catalog).diagnostics).toEqual([])
  })

  test("a later rule overrides an earlier one level by level, and a target's own variants override every rule", () => {
    const routes = pools({
      rules: {
        targets: [{ model: "openai/luna-6", variants: { max: false } }],
        include: ["openai/luna-5.5"],
        variantRules: [
          { match: "*", map: { low: "medium", max: "high" } },
          { match: "*luna-6*", map: { low: "low", max: "xhigh" } },
          // A remap to a variant the model lacks leaves the earlier rule's choice in place.
          { match: "openai/luna-5.5", map: { low: "turbo" } },
        ],
      },
    })
    expect(remaps("rules", routes)).toEqual({
      "openai/luna-6": { low: "low", max: false },
      "openai/luna-5.5": { low: "medium", max: "high" },
    })
  })

  test("an enclosing pool's rules reach a nested pool's members, and the nested pool's own rules win", () => {
    const routes = pools({
      outer: { targets: ["opencode-route/inner"], variantRules: [{ match: "*", map: { low: "medium", max: "high" } }] },
      inner: { targets: ["openai/luna-6"], variantRules: [{ match: "*luna*", map: { max: "xhigh" } }] },
    })
    expect(remaps("outer", routes)).toEqual({ "openai/luna-6": { low: "medium", max: "xhigh" } })
    expect(remaps("inner", routes)).toEqual({ "openai/luna-6": { max: "xhigh" } })
  })

  test("a pool named in include brings its models without its effort settings", () => {
    const routes = pools({
      source: { targets: [{ model: "openai/argon", variants: { xhigh: "high", max: false } }] },
      agg: { include: ["source"] },
    })
    expect(remaps("agg", routes)).toEqual({ "openai/argon": {} })
    expect(offered("agg", routes)).toEqual(["low", "medium", "high"])
  })

  test("with declared levels a pinned target runs each of them at its pin", () => {
    const routes = pools({
      pinned: { targets: ["openai/luna-6#high", "anthropic/claude-haiku-5"], levels: ["low", "medium"] },
    })
    expect(remaps("pinned", routes)).toEqual({ "openai/luna-6": {}, "anthropic/claude-haiku-5": { medium: false } })
    expect(offered("pinned", routes)).toEqual(["low", "medium"])
  })

  test("a nested pool keeps its declared levels, so the pool above it offers what it does", () => {
    const routes = pools({
      // luna-6 runs every level, and this pool offers it at low only.
      "low-only": { targets: ["openai/luna-6"], levels: ["low"] },
      "low-outer": { targets: ["opencode-route/low-only"] },
      // mythos cannot run low, and this pool still offers low through haiku.
      both: { targets: ["anthropic/claude-haiku-5", "anthropic/claude-mythos-1"], levels: ["low", "high"] },
      "both-outer": { targets: ["opencode-route/both"] },
    })
    expect(offered("low-only", routes)).toEqual(["low"])
    expect(offered("low-outer", routes)).toEqual(["low"])
    expect(remaps("low-outer", routes)).toEqual({
      "openai/luna-6": { medium: false, high: false, xhigh: false, max: false },
    })
    expect(offered("both", routes)).toEqual(["low", "high"])
    expect(offered("both-outer", routes)).toEqual(["low", "high"])
    expect(remaps("both-outer", routes)).toEqual({
      "anthropic/claude-haiku-5": {},
      "anthropic/claude-mythos-1": { low: false },
    })
  })

  test("a nested pool's members sit out a level only another member of the outer pool has", () => {
    const routes = pools({
      // haiku-5 has low and high, and this pool offers it at low only.
      "low-only": { targets: ["anthropic/claude-haiku-5"], levels: ["low"] },
      // luna-6 has every level, so the outer pool offers each of them, and only luna-6 runs the ones above low.
      outer: { targets: ["opencode-route/low-only", "openai/luna-6"] },
    })
    // The levels follow the members' order, so only the set is compared.
    expect(new Set(offered("outer", routes))).toEqual(new Set(ALL))
    expect(remaps("outer", routes)).toEqual({
      "anthropic/claude-haiku-5": { medium: false, high: false, xhigh: false, max: false },
      "openai/luna-6": {},
    })
  })

  test("a nested pool pinned at a level it declares runs its pin at each level of the outer pool", () => {
    const routes = pools({
      "high-only": { targets: ["anthropic/claude-haiku-5"], levels: ["high"] },
      outer: { targets: ["opencode-route/high-only#high"], levels: ["low"] },
    })
    expect(refs("outer", routes)).toEqual(["anthropic/claude-haiku-5#high"])
    expect(remaps("outer", routes)).toEqual({ "anthropic/claude-haiku-5": {} })
    expect(offered("outer", routes)).toEqual(["low"])
  })

  test("a member pinned inside a nested pool still keeps to that pool's levels", () => {
    const routes = pools({
      // luna-6 is pinned at high, and this pool offers it at low only.
      "low-only": { targets: ["openai/luna-6#high"], levels: ["low"] },
      outer: { targets: ["opencode-route/low-only"], levels: ["low", "max"] },
    })
    expect(remaps("outer", routes)).toEqual({
      "openai/luna-6": { medium: false, high: false, xhigh: false, max: false },
    })
    expect(offered("outer", routes)).toEqual(["low"])
    expect(expand("outer", routes, catalog).diagnostics).toEqual([
      "pool outer declares level max, but none of its models can run it, so it is not offered",
    ])
  })

  test("a nested pool written as a target object sits out, as a whole, the levels it maps to false", () => {
    const routes = pools({
      lunas: { targets: ["openai/luna-6", "openai/luna-6.1"] },
      outer: {
        targets: [{ model: "opencode-route/lunas", variants: { max: false } }, "anthropic/claude-sonnet-6"],
      },
    })
    expect(remaps("outer", routes)).toEqual({
      "openai/luna-6": { max: false },
      "openai/luna-6.1": { max: false },
      "anthropic/claude-sonnet-6": {},
    })
    expect(offered("outer", routes)).toEqual(ALL)
  })

  test("a model a pinned nested pool leaves out can still join the pool above it on that pool's terms", () => {
    const routes = pools({
      inner: { targets: [{ model: "openai/luna-6", variants: { max: false } }] },
      outer: { targets: ["opencode-route/inner#max"], include: ["openai/luna-6"] },
    })
    expect(refs("outer", routes)).toEqual(["openai/luna-6"])
  })

  test("a nested pool pinned at a level leaves out the members that sit that level out", () => {
    const routes = pools({
      remapped: { targets: [{ model: "openai/luna-6", variants: { max: false } }, "anthropic/claude-opus-6.1"] },
      ruled: {
        include: ["openai/luna-6", "anthropic/claude-opus-6.1"],
        variantRules: [{ match: "*luna*", map: { max: false } }],
      },
      // The target sits max out, so the include that also matches it does not bring it back.
      both: { targets: [{ model: "openai/luna-6", variants: { max: false } }], include: ["openai/luna-6"] },
      outer: { targets: ["opencode-route/remapped#max", "opencode-route/ruled#max", "opencode-route/both#max"] },
    })
    expect(refs("outer", routes)).toEqual(["anthropic/claude-opus-6.1#max"])
    // Selected without a pin, each pool still has both members, and luna-6 sits max out there too.
    expect(refs("remapped", routes)).toEqual(["openai/luna-6", "anthropic/claude-opus-6.1"])
    expect(refs("ruled", routes)).toEqual(["anthropic/claude-opus-6.1", "openai/luna-6"])
  })

  test("a pinned nested pool's remaps and rules apply only to its pin, so its members run at every level above", () => {
    const routes = pools({
      // Each pool sits low out, a level it is never selected at once it is pinned at max.
      remapped: { targets: [{ model: "openai/luna-6", variants: { low: false } }] },
      ruled: { targets: ["openai/luna-6.1"], variantRules: [{ match: "*", map: { low: false } }] },
      plain: { targets: ["openai/luna-5"] },
      wrapped: { targets: [{ model: "opencode-route/plain", variants: { low: false } }] },
      outer: {
        targets: [
          "opencode-route/remapped#max",
          "opencode-route/ruled#max",
          "opencode-route/wrapped#max",
          "openai/argon",
        ],
        levels: ["low", "high"],
      },
    })
    expect(refs("outer", routes)).toEqual([
      "openai/luna-6#max",
      "openai/luna-6.1#max",
      "openai/luna-5#max",
      "openai/argon",
    ])
    // Nothing sits low out, so outer at low runs the luna models at max and argon at low.
    expect(remaps("outer", routes)).toEqual({
      "openai/luna-6": {},
      "openai/luna-6.1": {},
      "openai/luna-5": {},
      "openai/argon": {},
    })
    expect(offered("outer", routes)).toEqual(["low", "high"])
  })

  test("a rule of a pool above a pin applies to that pool's levels, so it sits a pinned member out of those only", () => {
    const routes = pools({
      inner: { targets: ["openai/luna-6"] },
      // max is the pin's name, and a level this pool does not offer: luna-6 still runs at max at low and high.
      outer: {
        targets: ["opencode-route/inner#max", "openai/argon"],
        levels: ["low", "high"],
        variantRules: [{ match: "*luna*", map: { max: false } }],
      },
      // low is a level this pool offers, so luna-6 sits it out and runs at max at high only.
      "outer-low": {
        targets: ["opencode-route/inner#max", "openai/argon"],
        levels: ["low", "high"],
        variantRules: [{ match: "*luna*", map: { low: false } }],
      },
    })
    expect(refs("outer", routes)).toEqual(["openai/luna-6#max", "openai/argon"])
    expect(remaps("outer", routes)).toEqual({ "openai/luna-6": { max: false }, "openai/argon": {} })
    expect(offered("outer", routes)).toEqual(["low", "high"])
    expect(remaps("outer-low", routes)).toEqual({ "openai/luna-6": { low: false }, "openai/argon": {} })
  })

  test("each pin's rules apply to its own level, when a pinned pool pins another pool again", () => {
    const routes = pools({
      inner: { targets: ["openai/luna-6", "openai/luna-6.1"] },
      // middle runs only at max and pins inner at high. Its rule for high names a level it never runs, so it
      // leaves luna-6 alone; its rule for max sits luna-6.1 out of the one level it runs.
      middle: {
        targets: ["opencode-route/inner#high"],
        variantRules: [
          { match: "openai/luna-6", map: { high: false } },
          { match: "openai/luna-6.1", map: { max: false } },
        ],
      },
      outer: { targets: ["opencode-route/middle#max"] },
    })
    expect(refs("outer", routes)).toEqual(["openai/luna-6#high"])
    expect(remaps("outer", routes)).toEqual({ "openai/luna-6": {} })
  })

  test("a member left out at a pin is not brought back by a later target or matching key at the same pin", () => {
    const routes = pools({
      // A later target of the same pool, a glob that matches luna-6 again.
      globbed: { targets: [{ model: "openai/luna-6", variants: { max: false } }, "openai/luna-6*"] },
      // A target and an include of the pool that holds the one leaving luna-6 out.
      deep: { targets: [{ model: "openai/luna-6", variants: { max: false } }] },
      holder: { targets: ["opencode-route/deep", "openai/luna-6"], include: ["openai/luna-6*"] },
      outer: { targets: ["opencode-route/globbed#max"] },
      "outer-holder": { targets: ["opencode-route/holder#max"] },
    })
    expect(refs("outer", routes)).toEqual(["openai/luna-6.1#max"])
    expect(refs("outer-holder", routes)).toEqual(["openai/luna-6.1#max"])
    // Selected without a pin, each pool places luna-6 first, sitting max out, and adds it nowhere else.
    expect(refs("globbed", routes)).toEqual(["openai/luna-6", "openai/luna-6.1"])
    expect(remaps("globbed", routes)["openai/luna-6"]).toEqual({ max: false })
    expect(refs("holder", routes)).toEqual(["openai/luna-6", "openai/luna-6.1"])
  })

  test("a member with its own pin is left out of a pinned pool whose pin it sits out", () => {
    const routes = pools({
      inner: { targets: [{ model: "openai/luna-6#high", variants: { max: false } }, "anthropic/claude-opus-6.1"] },
      outer: { targets: ["opencode-route/inner#max"], levels: ["low", "max"] },
    })
    expect(refs("outer", routes)).toEqual(["anthropic/claude-opus-6.1#max"])
  })

  test("at a pin, a nested pool whose target object sits the pin out is left out as a whole, with its models", () => {
    const routes = pools({
      deep: { targets: ["anthropic/claude-opus-6.1"] },
      inner: { targets: [{ model: "opencode-route/deep", variants: { max: false } }, "openai/luna-6"] },
      // The same, with an include that matches deep's model: it does not bring it back at the pin.
      matched: {
        targets: [{ model: "opencode-route/deep", variants: { max: false } }, "openai/luna-6"],
        include: ["anthropic/*opus*"],
      },
      outer: { targets: ["opencode-route/inner#max"], levels: ["low", "max"] },
      "outer-matched": { targets: ["opencode-route/matched#max"] },
    })
    expect(refs("outer", routes)).toEqual(["openai/luna-6#max"])
    expect(remaps("outer", routes)).toEqual({ "openai/luna-6": {} })
    expect(offered("outer", routes)).toEqual(["low", "max"])
    expect(refs("outer-matched", routes)).toEqual(["openai/luna-6#max"])
  })

  test("a nested pool left out at a pin keeps its members' own pins, so a later target repeating one adds nothing", () => {
    const routes = pools({
      deep: { targets: ["openai/luna-6#high"] },
      inner: {
        targets: [
          { model: "opencode-route/deep", variants: { max: false } },
          "openai/luna-6#high",
          "anthropic/claude-opus-6.1",
        ],
      },
      // The same with the pin on the nested pool's reference: deep2 would bring luna-6.1 at high.
      deep2: { targets: ["openai/luna-6.1"] },
      inner2: {
        targets: [
          { model: "opencode-route/deep2#high", variants: { max: false } },
          "openai/luna-6.1#high",
          "anthropic/claude-opus-6.1",
        ],
      },
      outer: { targets: ["opencode-route/inner#max"] },
      outer2: { targets: ["opencode-route/inner2#max"] },
    })
    expect(refs("outer", routes)).toEqual(["anthropic/claude-opus-6.1#max"])
    expect(refs("outer2", routes)).toEqual(["anthropic/claude-opus-6.1#max"])
    // Selected without a pin, deep's luna-6#high comes first and sits max out, and the later one repeats it.
    expect(refs("inner", routes)).toEqual(["openai/luna-6#high", "anthropic/claude-opus-6.1"])
    expect(remaps("inner", routes)["openai/luna-6"]).toEqual({ max: false })
    expect(refs("inner2", routes)).toEqual(["openai/luna-6.1#high", "anthropic/claude-opus-6.1"])
  })

  test("at a pin, a target with its own #variant is a separate member, as when the pool is selected at that level", () => {
    const routes = pools({
      // luna-6 sits max out, and luna-6#max is another target, pinned at max.
      repeated: { targets: [{ model: "openai/luna-6", variants: { max: false } }, "openai/luna-6#max"] },
      // The nested pool sits max out as a whole, and the target after it is pinned at max.
      plain: { targets: ["openai/luna-6"] },
      wrapped: { targets: [{ model: "opencode-route/plain", variants: { max: false } }, "openai/luna-6#max"] },
      // luna-6 sits max out, and the pool after it, pinned at max, brings luna-6 at max.
      repinned: { targets: [{ model: "openai/luna-6", variants: { max: false } }, "opencode-route/plain#max"] },
      "outer-repeated": { targets: ["opencode-route/repeated#max"] },
      "outer-wrapped": { targets: ["opencode-route/wrapped#max"] },
      "outer-repinned": { targets: ["opencode-route/repinned#max"] },
    })
    for (const id of ["repeated", "wrapped", "repinned"]) {
      expect(refs(`outer-${id}`, routes)).toEqual(["openai/luna-6#max"])
      // Selected at max without a pin, each pool runs luna-6 at max through the other target as well.
      expect(
        expand(id, routes, catalog).leaves.map(
          (leaf) =>
            `${leaf.ref.id}${leaf.ref.variant ? `#${leaf.ref.variant}` : ""} ${leaf.variantMap?.max === false ? "sits max out" : "runs max"}`,
        ),
      ).toEqual(["luna-6 sits max out", "luna-6#max runs max"])
    }
  })

  test("a pool pinned at a level a rule remaps runs the matched model at the mapped variant", () => {
    const routes = pools({
      // argon has no max; the rule maps max onto high, so pinned at max it runs at high.
      inner: { include: ["openai/argon"], variantRules: [{ match: "*argon*", map: { max: "high" } }] },
      outer: { targets: ["opencode-route/inner#max"] },
    })
    expect(refs("outer", routes)).toEqual(["openai/argon#max"])
    expect(remaps("outer", routes)).toEqual({ "openai/argon": { max: "high" } })
  })

  test("a nested pool pinned at a level it does not declare adds nothing, and says so", () => {
    const routes = pools({
      "low-only": { targets: ["openai/luna-6"], levels: ["low"] },
      outer: { targets: ["opencode-route/low-only#max", "anthropic/claude-opus-6.1"] },
    })
    const result = expand("outer", routes, catalog)
    expect(refs("outer", routes)).toEqual(["anthropic/claude-opus-6.1"])
    expect(result.diagnostics).toEqual([
      "pool low-only is pinned at level max, which it does not declare, so it adds nothing",
    ])
  })

  test("a nested pool that does not declare the pin it inherits still keeps its members from being added again", () => {
    const routes = pools({
      "low-only": { targets: ["openai/luna-6"], levels: ["low"] },
      // Selected at max without a pin, low-only's luna-6 comes first and sits max out, so the later luna-6, by
      // target or by include, repeats it.
      middle: { targets: ["opencode-route/low-only", "openai/luna-6", "anthropic/claude-opus-6.1"], levels: ["max"] },
      matched: {
        targets: ["opencode-route/low-only", "anthropic/claude-opus-6.1"],
        include: ["openai/luna-6"],
        levels: ["max"],
      },
      // A pin written on the reference makes low-only a separate member, which adds nothing at max.
      repinned: { targets: ["opencode-route/low-only#max", "openai/luna-6"], levels: ["max"] },
      outer: { targets: ["opencode-route/middle#max"] },
      "outer-matched": { targets: ["opencode-route/matched#max"] },
      "outer-repinned": { targets: ["opencode-route/repinned#max"] },
    })
    expect(refs("outer", routes)).toEqual(["anthropic/claude-opus-6.1#max"])
    expect(expand("outer", routes, catalog).diagnostics).toEqual([
      "pool low-only is pinned at level max, which it does not declare, so it adds nothing",
    ])
    expect(refs("outer-matched", routes)).toEqual(["anthropic/claude-opus-6.1#max"])
    expect(refs("outer-repinned", routes)).toEqual(["openai/luna-6#max"])
    expect(refs("middle", routes)).toEqual(["openai/luna-6", "anthropic/claude-opus-6.1"])
    expect(remaps("middle", routes)["openai/luna-6"].max).toBe(false)
  })

  test("a target uses the model as it can be used now, so a configured variant counts", () => {
    // The definition of argon has low, medium and high; the configuration gives it a turbo variant too,
    // which only the model as it can be used now carries.
    const [, configured] = model("openai", "argon", ["low", "medium", "high", "turbo"])
    const candidate = (providerID: Provider.ID, modelID: Model.ID) =>
      String(providerID) === "openai" && String(modelID) === "argon"
        ? configured
        : catalog.get(providerID)?.get(modelID)
    const routes = pools({
      declared: { targets: ["openai/argon"], levels: ["high", "turbo"] },
      ruled: { targets: ["openai/argon"], variantRules: [{ match: "*", map: { max: "turbo" } }] },
    })
    const declared = expand("declared", routes, catalog, candidate)
    expect(routeVariants(declared.leaves, ["high", "turbo"]).map((variant) => String(variant.id))).toEqual([
      "high",
      "turbo",
    ])
    expect(declared.leaves[0].variantMap).toBeUndefined()
    expect(declared.diagnostics).toEqual([])
    expect(expand("ruled", routes, catalog, candidate).leaves[0].variantMap).toEqual({
      max: Model.VariantID.make("turbo"),
    })
    // Without the configured model the definition is all there is, as when the provider is not connected.
    expect(expand("declared", routes, catalog).leaves[0].variantMap).toEqual({ turbo: false })
  })
})
