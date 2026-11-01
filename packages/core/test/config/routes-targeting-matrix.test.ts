import { describe, expect, test } from "bun:test"
import {
  configuredProviderRoutes,
  configuredWindows,
  expand,
  routeWeightRules,
  weightRulesAcross,
} from "@opencode/core/config/plugin/model-routes"
import type { Entry } from "@opencode/schema/config"
import { Model } from "@opencode/core/model"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteTuning } from "@opencode/core/model-route-tuning"
import { Provider } from "@opencode/core/provider"
import type { ConfigModelRoutes } from "@opencode/schema/config/model-routes"

// Targeting matrix for #1140's addendum (comment 6552743230): every construct in
// `experimental.routes.*` must target providers and models SYMMETRICALLY in BOTH
// route kinds. Rows = construct, columns = target kind x route kind. Health stays
// on the concrete provider/model/credential leaf in every cell (groups are
// expansion only, per #1134), so targeting a provider route ultimately judges the
// concrete leaves it expands to — that is what makes the two route kinds
// symmetric by construction wherever a construct matches leaves.
//
//   construct        | provider          | model             | provider/model pair | route
//   -----------------+-------------------+-------------------+---------------------+------------------
//   windows (gate)   | WORKS both kinds  | WORKS both kinds  | WORKS both kinds    | WORKS both kinds
//                    | model route: the  | model route: a    | model route: the    | model route: gate
//                    | provider is named | door-set target   | target's own gate   | on a nested-route
//                    | on each target    | `*/model` gated   | (target.window);    | reference; provider
//                    | referencing it;   | once gates the    | provider route: a   | route: gate on the
//                    | provider route:   | model on every    | member gate in the  | referencing target
//                    | per-member gate   | door; provider    | group serving that  | gates the whole
//                    | (routes.providers | route: the group  | one model is the    | group (one model,
//                    | .windows, NEW)    | serves one model, | pair                | so also the model
//                    |                   | so the group gate |                     | cell)
//                    |                   | is the model gate |                     |
//   schedules        | WORKS both kinds  | WORKS both kinds  | WORKS both kinds    | WORKS both kinds
//   (global,         | providers[] match | models[] match    | targets[] match     | routes[] match —
//   routes.schedules)| on concrete leaf  | on concrete leaf  | on concrete leaf    | a provider route's
//                    |                   |                   |                     | id is on the path
//   schedules        | WORKS both kinds: targets[] patterns name a provider (`openai/*`), a model
//   (route-local,    | (`*/gpt-*`), a pair (`openai/gpt-*`), or everything (empty). Provider-route-local
//   incl. NEW        | schedules (routes.providers[].schedules, NEW) ride on the provider-route group
//   provider-route   | and judge its concrete leaves exactly as a model route's schedules judge its
//   schedules)       | targets. Route cell: OUT OF SCOPE by construction for route-local schedules —
//                    | a route-local rule lives inside the one route it targets; cross-route
//                    | targeting by route id is the global schedules' routes[] cell above.
//   settings         | OUT OF SCOPE as targeting, by design: routes.settings holds machinery-wide
//   (routes.settings)| constants with no provider/model/route selector. Its bench/demotion/quota
//                    | effects are judged per concrete provider/model/credential leaf in BOTH
//                    | route kinds identically (the constants suite in model-route.test.ts pins
//                    | the values; the config surface is pinned in nested-routes.test.ts).
//                    | Per-route variation already exists where it belongs: a route's own
//                    | health block overrides bench bases for that route.
//   tuning           | WORKS both kinds for provider, model and pair: tuning notes match a
//   (routes.tuning)  | case-insensitive substring of `provider/model`, and provider-route leaves
//                    | are concrete provider/model pairs, so a note naming a provider, a model,
//                    | or a pair applies identically wherever the leaf was reached. Route cell:
//                    | OUT OF SCOPE — notes record operational facts about providers/models
//                    | ("out of quota, back in 3 hours"), not routes; pausing a whole route
//                    | is what windows/schedules do.
//   log              | No targeting surface at all (a single capture flag); nothing to make
//                    | symmetric.

const main = Provider.ID.make("openai")
const alt = Provider.ID.make("openai.alternate")
const anthropic = Provider.ID.make("anthropic")

const catalog = (entries: [Provider.ID, string[]][]) =>
  new Map<Provider.ID, ReadonlyMap<string, Model.Info>>(
    entries.map(
      ([id, ids]) =>
        [id, new Map(ids.map((model) => [model, Model.Info.default(id, Model.ID.make(model))] as const))] as const,
    ),
  )

const both = catalog([
  [main, ["gpt-6.1-terra", "gpt-6.1-sol"]],
  [alt, ["gpt-6.1-terra", "gpt-6.1-sol"]],
  [anthropic, ["claude-sonnet-5"]],
])

const selection = (reference: string) => {
  const [providerID, model] = reference.split("/")
  return { providerID, model }
}

const route = (
  targets: (string | { model: string; window?: string | { name: string; invert?: boolean } })[],
  extra: object = {},
  id = "r",
) =>
  new Map<string, ConfigModelRoutes.Route>([
    [
      id,
      {
        targets: targets.map((target) =>
          typeof target === "string" ? selection(target) : { ...target, model: selection(target.model) },
        ),
        ...extra,
      } as unknown as ConfigModelRoutes.Route,
    ],
  ])

const entriesWith = (experimental: unknown) =>
  [{ type: "document", info: { experimental } }] as unknown as Entry[]

const windows = configuredWindows(
  entriesWith({
    routes: {
      windows: {
        daytime: { start: "00:00", end: "01:00", timezone: "UTC" },
        always: {},
      },
    },
  }),
)
// 00:30 UTC is inside "daytime"; 12:00 UTC is outside it.
const inside = Date.UTC(2026, 0, 5, 0, 30)
const outside = Date.UTC(2026, 0, 5, 12, 0)

const ref = (reference: string) => {
  const [providerID, model] = reference.split("/")
  return Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(model) })
}

describe("targeting matrix: windows", () => {
  test("pair x model route: a target's window gates exactly that provider/model pair", () => {
    const { nodes } = expand(
      "r",
      route([{ model: "openai/gpt-6.1-terra", window: "daytime" }, "openai/gpt-6.1-sol"]),
      both,
      windows,
    )
    const gate = nodes[0].children[0].gate
    expect(gate?.name).toBe("daytime")
    expect(ModelRoute.gateOpen(gate, inside)).toBe(true)
    expect(ModelRoute.gateOpen(gate, outside)).toBe(false)
    expect(nodes[0].children[1].gate).toBeUndefined()
  })

  test("route x model route: a window on a nested-route reference gates the whole group", () => {
    const routes = new Map<string, ConfigModelRoutes.Route>([
      ...route(["openai/gpt-6.1-terra"], {}, "pool"),
      ...route([{ model: "opencode-route/pool", window: "daytime" }]),
    ])
    const { nodes } = expand("r", routes, both, windows)
    expect(nodes[0].children[0].gate?.name).toBe("daytime")
  })

  test("model x model route: a gated door-set target gates the model on every door", () => {
    const { nodes, leaves } = expand("r", route([{ model: "*/gpt-6.1-terra", window: "daytime" }]), both, windows)
    expect(leaves).toHaveLength(2)
    expect(nodes[0].children.map((child) => child.gate?.name)).toEqual(["daytime", "daytime"])
  })

  test("provider x model route: every target naming the provider carries its gate", () => {
    const { nodes } = expand(
      "r",
      route([
        { model: "openai/gpt-6.1-terra", window: "daytime" },
        { model: "openai/gpt-6.1-sol", window: "daytime" },
        "anthropic/claude-sonnet-5",
      ]),
      both,
      windows,
    )
    expect(nodes[0].children.map((child) => child.gate?.name)).toEqual(["daytime", "daytime", undefined])
  })

  test("provider x provider route (NEW): a per-member window gates only that member, in every model group", () => {
    const providerRoutes = new Map<string, ModelRoute.ProviderRoute>([
      [
        "openai-plan",
        {
          providers: ["openai.alternate", "openai"],
          selection: "ordered",
          weights: {},
          windows: { openai: "daytime" },
        },
      ],
    ])
    const { nodes, leaves } = expand(
      "r",
      route(["openai-plan/gpt-6.1-terra", "openai-plan/gpt-6.1-sol"]),
      both,
      windows,
      providerRoutes,
    )
    expect(leaves).toHaveLength(4)
    const groups = nodes.filter((node) => node.providerRoute === "openai-plan")
    expect(groups).toHaveLength(2)
    for (const group of groups) {
      // Member order is [openai.alternate, openai]: only the openai leaf is gated.
      expect(group.children[0].gate).toBeUndefined()
      expect(group.children[1].gate?.name).toBe("daytime")
      expect(ModelRoute.gateOpen(group.children[1].gate, outside)).toBe(false)
      expect(ModelRoute.gateOpen(group.children[1].gate, inside)).toBe(true)
    }
  })

  test("pair x provider route (NEW): an inverted member gate benches exactly the member's pair in the group", () => {
    const providerRoutes = new Map<string, ModelRoute.ProviderRoute>([
      [
        "openai-plan",
        {
          providers: ["openai.alternate", "openai"],
          selection: "ordered",
          weights: {},
          windows: { "openai.alternate": { name: "daytime", invert: true } },
        },
      ],
    ])
    const { nodes } = expand("r", route(["openai-plan/gpt-6.1-terra"]), both, windows, providerRoutes)
    const group = nodes.find((node) => node.providerRoute === "openai-plan")!
    expect(group.children[0].gate?.invert).toBe(true)
    expect(ModelRoute.gateOpen(group.children[0].gate, inside)).toBe(false)
    expect(ModelRoute.gateOpen(group.children[0].gate, outside)).toBe(true)
    expect(group.children[1].gate).toBeUndefined()
  })

  test("route + model x provider route: a window on the referencing target gates the whole provider-route group", () => {
    const providerRoutes = new Map<string, ModelRoute.ProviderRoute>([
      ["openai-plan", { providers: ["openai.alternate", "openai"], selection: "ordered", weights: {} }],
    ])
    const { nodes } = expand(
      "r",
      route([{ model: "openai-plan/gpt-6.1-terra", window: "daytime" }, "openai-plan/gpt-6.1-sol"]),
      both,
      windows,
      providerRoutes,
    )
    // The group serves exactly one model, so gating the group is gating that model
    // through this provider route — and the whole route reference at once.
    expect(nodes[0].children[0].gate?.name).toBe("daytime")
    expect(nodes[0].children[1].gate).toBeUndefined()
  })

  test("a per-member window survives configuredProviderRoutes from the nested config shape", () => {
    const parsed = configuredProviderRoutes(
      entriesWith({
        routes: {
          providers: {
            "openai-plan": {
              providers: ["openai.alternate", "openai"],
              windows: { openai: "daytime" },
              schedules: [{ targets: ["openai/*"], when: { start: "00:00" }, factor: 2 }],
            },
          },
        },
      }),
      new Set(["openai", "openai.alternate"]),
      new Map(),
    )
    expect(parsed.get("openai-plan")?.windows).toEqual({ openai: "daytime" })
    expect(parsed.get("openai-plan")?.schedules).toHaveLength(1)
  })
})

describe("targeting matrix: schedules", () => {
  const global = (schedule: object) =>
    weightRulesAcross([schedule] as unknown as ConfigModelRoutes.GlobalSchedule[], windows)
  const always = { start: "00:00", end: "23:59", timezone: "UTC" }
  // Judge at a fixed instant inside every window used below: the "always" window
  // above has no day constraint, and Date.UTC(2026,0,5,12,0) is a Monday.
  const now = Date.UTC(2026, 0, 5, 12, 0)

  test("provider x model route + provider route leaf: a global providers[] rule scales the concrete leaf either way", () => {
    const rules = global({ providers: ["openai"], when: always, factor: 2 })
    expect(ModelRoute.weightOf(ref("openai/gpt-6.1-terra"), 1, now, { schedules: rules })).toBe(2)
    expect(ModelRoute.weightOf(ref("openai.alternate/gpt-6.1-terra"), 1, now, { schedules: rules })).toBe(1)
    // The same leaf reached through a provider route IS the concrete openai leaf:
    const { leaves } = expand(
      "r",
      route(["openai-plan/gpt-6.1-terra"]),
      both,
      windows,
      new Map([["openai-plan", { providers: ["openai.alternate", "openai"], selection: "ordered", weights: {} }]]),
    )
    const openaiLeaf = leaves.find((leaf) => String(leaf.ref.providerID) === "openai")!
    expect(ModelRoute.weightOf(openaiLeaf.ref, 1, now, { schedules: rules })).toBe(2)
  })

  test("model x both kinds: a global models[] rule scales by model regardless of provider", () => {
    const rules = global({ models: ["*terra*"], when: always, factor: 3 })
    expect(ModelRoute.weightOf(ref("openai/gpt-6.1-terra"), 1, now, { schedules: rules })).toBe(3)
    expect(ModelRoute.weightOf(ref("openai.alternate/gpt-6.1-terra"), 1, now, { schedules: rules })).toBe(3)
    expect(ModelRoute.weightOf(ref("openai/gpt-6.1-sol"), 1, now, { schedules: rules })).toBe(1)
  })

  test("pair x both kinds: a global targets[] rule scales exactly the named pair", () => {
    const rules = global({ targets: ["openai/gpt-6.1-terra"], when: always, weight: 7 })
    expect(ModelRoute.weightOf(ref("openai/gpt-6.1-terra"), 1, now, { schedules: rules })).toBe(7)
    expect(ModelRoute.weightOf(ref("openai.alternate/gpt-6.1-terra"), 1, now, { schedules: rules })).toBe(1)
    expect(ModelRoute.weightOf(ref("openai/gpt-6.1-sol"), 1, now, { schedules: rules })).toBe(1)
  })

  test("route x both kinds: a global routes[] rule matches a model route id and a provider route id alike", () => {
    const byModelRoute = global({ routes: ["r"], when: always, factor: 2 })
    expect(ModelRoute.weightOf(ref("openai/gpt-6.1-terra"), 1, now, { schedules: byModelRoute, routes: ["r"] })).toBe(
      2,
    )
    const byProviderRoute = global({ routes: ["openai-plan"], when: always, factor: 4 })
    // On the path into a provider-route group, the provider route's id is a route
    // on the path (the group's node carries it), exactly like a nested model route.
    expect(
      ModelRoute.weightOf(ref("openai/gpt-6.1-terra"), 1, now, {
        schedules: byProviderRoute,
        routes: ["r", "openai-plan"],
      }),
    ).toBe(4)
    expect(
      ModelRoute.weightOf(ref("openai/gpt-6.1-terra"), 1, now, { schedules: byProviderRoute, routes: ["r"] }),
    ).toBe(1)
  })

  test("route-local schedules x provider/model/pair in a model route (targets patterns)", () => {
    const byProvider = routeWeightRules(
      {
        targets: [],
        schedules: [{ targets: ["openai/*"], when: always, factor: 2 }],
      } as unknown as ConfigModelRoutes.Route,
      windows,
    )
    expect(ModelRoute.weightOf(ref("openai/gpt-6.1-sol"), 1, now, { schedules: byProvider })).toBe(2)
    expect(ModelRoute.weightOf(ref("anthropic/claude-sonnet-5"), 1, now, { schedules: byProvider })).toBe(1)
    const byModel = routeWeightRules(
      {
        targets: [],
        schedules: [{ targets: ["*/gpt-6.1-terra"], when: always, factor: 5 }],
      } as unknown as ConfigModelRoutes.Route,
      windows,
    )
    expect(ModelRoute.weightOf(ref("openai.alternate/gpt-6.1-terra"), 1, now, { schedules: byModel })).toBe(5)
    expect(ModelRoute.weightOf(ref("openai.alternate/gpt-6.1-sol"), 1, now, { schedules: byModel })).toBe(1)
  })

  test("provider-route-local schedules (NEW): rules ride on the group and scale its concrete leaves by provider, model and pair", () => {
    const providerRoutes = new Map<string, ModelRoute.ProviderRoute>([
      [
        "openai-plan",
        {
          providers: ["openai.alternate", "openai"],
          selection: "ordered",
          weights: {},
          schedules: [
            { targets: ["openai/*"], when: always, factor: 2 },
            { targets: ["*/gpt-6.1-terra"], when: always, factor: 3 },
            { targets: ["openai.alternate/gpt-6.1-sol"], when: always, weight: 9 },
          ] as unknown as ConfigModelRoutes.Schedule[],
        },
      ],
    ])
    const { nodes, leaves } = expand(
      "r",
      route(["openai-plan/gpt-6.1-terra", "openai-plan/gpt-6.1-sol"]),
      both,
      windows,
      providerRoutes,
    )
    const groups = nodes.filter((node) => node.providerRoute === "openai-plan")
    expect(groups).toHaveLength(2)
    for (const group of groups) expect(group.schedules).toHaveLength(3)
    const terra = groups[0].schedules!
    const byRef = (reference: string) => leaves.find((leaf) => `${leaf.ref.providerID}/${leaf.ref.id}` === reference)!
    // provider pattern + model pattern compose on the terra pair: 1 * 2 * 3
    expect(ModelRoute.weightOf(byRef("openai/gpt-6.1-terra").ref, 1, now, { schedules: terra })).toBe(6)
    expect(ModelRoute.weightOf(byRef("openai.alternate/gpt-6.1-terra").ref, 1, now, { schedules: terra })).toBe(3)
    // pair rule sets the sol pair's weight outright; provider rule scales openai's sol
    const sol = groups[1].schedules!
    expect(ModelRoute.weightOf(byRef("openai.alternate/gpt-6.1-sol").ref, 1, now, { schedules: sol })).toBe(9)
    expect(ModelRoute.weightOf(byRef("openai/gpt-6.1-sol").ref, 1, now, { schedules: sol })).toBe(2)
    // Route cell, out of scope by construction: the rules live on this provider
    // route's groups only — a different route's nodes carry none of them.
    const other = expand("other", route(["openai/gpt-6.1-terra"], {}, "other"), both, windows, providerRoutes)
    expect(other.nodes[0].schedules ?? []).toHaveLength(0)
  })
})

describe("targeting matrix: tuning notes", () => {
  test("provider, model and pair x both kinds: a note's match is a substring of the concrete provider/model", () => {
    const notes = ModelRouteTuning.parseNotes([
      "openai: promo credits, reset at 2026-01-04T00:00:00Z",
      "gpt-6.1-terra: out of quota, back in 3 hours",
      "openai.alternate/gpt-6.1-sol: promo credits, reset at 2026-01-04T00:00:00Z",
    ])
    const adjustments = ModelRouteTuning.noteAdjustments(notes, Date.parse("2026-01-03T00:00:00Z"), 60_000)
    // A provider-route leaf and a direct model-route leaf with the same concrete
    // provider/model are indistinguishable to the matcher — that is the symmetry.
    expect(adjustments.map((item) => item.match)).toEqual([
      "openai",
      "gpt-6.1-terra",
      "openai.alternate/gpt-6.1-sol",
    ])
    for (const item of adjustments) expect(item.action).toBe("skip")
  })
})
