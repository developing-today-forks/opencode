import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  configuredProviderRoutes,
  configuredWindows,
  expand,
  routeVariants,
  routeWeightRules,
  weightRulesAcross,
} from "@opencode/core/config/plugin/model-routes"
import type { Entry } from "@opencode/schema/config"
import { Model } from "@opencode/core/model"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteSchedule } from "@opencode/core/model-route-schedule"
import { Provider } from "@opencode/core/provider"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"

const anthropic = Provider.ID.make("anthropic")
const openai = Provider.ID.make("openai")
const now = Date.now()

const models = (ids: string[]) =>
  new Map(ids.map((id) => [id, Model.Info.default(anthropic, Model.ID.make(id))] as const))

const definitions = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
  [anthropic, models(["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"])],
  [openai, models(["gpt-6-luna"])],
])

const selection = (reference: string) => {
  const [providerID, model] = reference.split("/")
  return { providerID, model }
}
const route = (
  targets: (
    | string
    | {
        model: string
        until?: number
        variants?: Record<string, string>
        cache_format?: string
        limit?: { context: number }
        window?: string | { name: string; invert?: boolean }
      }
  )[],
  extra: object = {},
) =>
  new Map<string, ConfigModelRoutes.Route>([
    [
      "r",
      {
        targets: targets.map((target) =>
          typeof target === "string" ? selection(target) : { ...target, model: selection(target.model) },
        ),
        ...extra,
      } as unknown as ConfigModelRoutes.Route,
    ],
  ])

describe("pool targets", () => {
  test("a glob target joins every matching model of its provider, in provider order", () => {
    const { leaves } = expand("r", route(["anthropic/*sonnet*", "anthropic/*opus*"]), definitions)
    expect(leaves.map((leaf) => String(leaf.ref.id))).toEqual(["claude-sonnet-4-5", "claude-opus-4-1"])
  })

  test("a time-limited nested-route target is dropped when expired and expanded while live (#580)", () => {
    const nested = (until: number) =>
      new Map<string, ConfigModelRoutes.Route>([
        [
          "pool",
          {
            targets: [{ model: { providerID: "anthropic", model: "claude-opus-4-1" } }],
          } as unknown as ConfigModelRoutes.Route,
        ],
        [
          "r",
          {
            targets: [
              { model: { providerID: "opencode-route", model: "pool" }, until },
              { model: { providerID: "openai", model: "gpt-6-luna" } },
            ],
          } as unknown as ConfigModelRoutes.Route,
        ],
      ])
    const expired = expand("r", nested(now - 1), definitions)
    expect(expired.leaves.map((leaf) => String(leaf.ref.id))).toEqual(["gpt-6-luna"])
    const live = expand("r", nested(now + 60_000), definitions)
    expect(live.leaves.map((leaf) => String(leaf.ref.id))).toEqual(["claude-opus-4-1", "gpt-6-luna"])
  })

  test("a glob that matches nothing contributes nothing and does not fail the route", () => {
    const { leaves } = expand("r", route(["anthropic/*mistral*", "openai/gpt-6-luna"]), definitions)
    expect(leaves.map((leaf) => String(leaf.ref.id))).toEqual(["gpt-6-luna"])
  })

  test("a model reached by two targets appears once", () => {
    const { leaves } = expand("r", route(["anthropic/*sonnet*", "anthropic/claude-sonnet-4-5"]), definitions)
    expect(leaves).toHaveLength(1)
  })

  test("a time-limited target is in the route until its end time, then leaves it", () => {
    const live = { model: "anthropic/*opus*", until: now + 60_000 }
    const expired = { model: "openai/gpt-6-luna", until: now - 1 }
    const kept = expand("r", route([live, expired]), definitions)
    expect(kept.leaves.map((leaf) => String(leaf.ref.id))).toEqual(["claude-opus-4-1"])
  })
})

describe("advertised variants", () => {
  const withVariants = (providerID: Provider.ID, id: string, variants: string[]) =>
    [
      id,
      {
        ...Model.Info.default(providerID, Model.ID.make(id)),
        variants: variants.map((variant) => ({ id: Model.VariantID.make(variant) })),
      },
    ] as const

  test("a route offers a variant only when every target can produce it, natively or through a remap", () => {
    const definitionsWithVariants = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
      [anthropic, new Map([withVariants(anthropic, "claude-opus-4-1", ["high", "medium"])])],
      [openai, new Map([withVariants(openai, "gpt-6-luna", ["high"])])],
    ])
    const { leaves } = expand(
      "r",
      route([
        { model: "anthropic/claude-opus-4-1", variants: { low: "medium" } },
        { model: "openai/gpt-6-luna", variants: { low: "high" } },
      ]),
      definitionsWithVariants,
    )
    // `high` is native to both; `low` is remapped on both; `medium` only the first target has.
    expect(routeVariants(leaves).map((variant) => String(variant.id))).toEqual(["high", "low"])
  })
})

describe("pinned variants", () => {
  const withVariants = (providerID: Provider.ID, id: string, variants: string[]) =>
    [
      id,
      {
        ...Model.Info.default(providerID, Model.ID.make(id)),
        variants: variants.map((variant) => ({ id: Model.VariantID.make(variant) })),
      },
    ] as const

  // Neither leaf offers "medium" natively; both remap it to "high" in their target specs.
  const definitionsWithVariants = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
    [anthropic, new Map([withVariants(anthropic, "claude-opus-4-1", ["none", "low", "high", "max"])])],
    [openai, new Map([withVariants(openai, "gpt-6-luna", ["low", "high"])])],
  ])
  const routes = new Map<string, ConfigModelRoutes.Route>([
    [
      "pool",
      {
        targets: [
          { model: { providerID: "anthropic", model: "claude-opus-4-1" }, variants: { medium: "high" } },
          { model: { providerID: "openai", model: "gpt-6-luna" }, variants: { medium: "high" } },
        ],
      } as unknown as ConfigModelRoutes.Route,
    ],
    [
      "scout",
      {
        targets: [{ model: { providerID: "opencode-route", model: "pool", variant: "medium" } }],
      } as unknown as ConfigModelRoutes.Route,
    ],
  ])

  test("a config-pinned variant reachable only through a target's remap does not prune the leaf", () => {
    const { leaves } = expand("scout", routes, definitionsWithVariants)
    expect(leaves.map((leaf) => `${leaf.ref.providerID}/${leaf.ref.id}#${leaf.ref.variant}`)).toEqual([
      "anthropic/claude-opus-4-1#high",
      "openai/gpt-6-luna#high",
    ])
  })

  test("a pinned variant no target can produce natively or through a remap still prunes the leaf", () => {
    const { leaves } = expand(
      "scout",
      new Map([
        [
          "pool",
          {
            targets: [
              { model: { providerID: "anthropic", model: "claude-opus-4-1" }, variants: { medium: "ultra" } },
              { model: { providerID: "openai", model: "gpt-6-luna" }, variants: { medium: "ultra" } },
            ],
          } as unknown as ConfigModelRoutes.Route,
        ],
        [
          "scout",
          {
            targets: [{ model: { providerID: "opencode-route", model: "pool", variant: "medium" } }],
          } as unknown as ConfigModelRoutes.Route,
        ],
      ]),
      definitionsWithVariants,
    )
    expect(leaves).toEqual([])
  })

  test("a pinned variant the model offers natively still resolves to that variant", () => {
    const { leaves } = expand(
      "scout",
      new Map([
        [
          "pool",
          {
            targets: [{ model: { providerID: "anthropic", model: "claude-opus-4-1" }, variants: { medium: "high" } }],
          } as unknown as ConfigModelRoutes.Route,
        ],
        [
          "scout",
          {
            targets: [{ model: { providerID: "opencode-route", model: "pool", variant: "max" } }],
          } as unknown as ConfigModelRoutes.Route,
        ],
      ]),
      definitionsWithVariants,
    )
    expect(leaves.map((leaf) => `${leaf.ref.id}#${leaf.ref.variant}`)).toEqual(["claude-opus-4-1#max"])
  })
})

describe("pool weight schedules", () => {
  test("a route's schedule is normalized and carried on its node", () => {
    const routes = route(["openai/gpt-6-luna", "anthropic/claude-opus-4-1"], {
      schedules: [
        {
          id: "peak",
          targets: ["deepseek/*", "  "],
          when: { daysOfWeek: ["Mon", "fri"], start: "9:00", end: "17:00", timezone: "America/Chicago" },
          factor: 0.8,
          note: "peak hours",
        },
        { targets: ["*"], when: { timezone: "Mars/Olympus" }, factor: 10 },
        { targets: ["*"], when: { start: "09:00", end: "17:00" } },
      ],
    })
    const { nodes } = expand("r", routes, definitions)
    expect(nodes[0].schedules).toEqual([
      {
        id: "peak",
        match: { targets: ["deepseek/*"] },
        window: { daysOfWeek: [1, 5], start: "09:00", end: "17:00", timezone: "America/Chicago" },
        factor: 0.8,
        note: "peak hours",
      },
    ])
  })

  test("routeWeightRules drops an unreadable window instead of shifting weights at the wrong time", () => {
    expect(
      routeWeightRules({
        targets: [],
        schedules: [{ targets: ["*"], when: { start: "25:00" }, factor: 2 }],
      } as unknown as ConfigModelRoutes.Route),
    ).toEqual([])
  })

  test("a global schedule keeps its matchers, including the route filter", () => {
    expect(
      weightRulesAcross([
        {
          id: "peak",
          providers: ["deepseek"],
          models: ["*chat*"],
          targets: ["deepseek/*"],
          routes: ["coding"],
          when: { daysOfWeek: ["mon"], start: "09:00", end: "17:00" },
          weight: 0.25,
        },
        { when: {}, factor: 2 },
      ] as unknown as ConfigModelRoutes.GlobalSchedule[]),
    ).toEqual([
      {
        id: "peak",
        match: { targets: ["deepseek/*"], providers: ["deepseek"], models: ["*chat*"], routes: ["coding"] },
        window: { daysOfWeek: [1], start: "09:00", end: "17:00" },
        weight: 0.25,
      },
      { window: {}, factor: 2 },
    ])
  })

  test("an always-on window keeps only the fields that were set", () => {
    const [rule] = weightRulesAcross([
      { when: { daysOfWeek: [0], start: "09:00" }, factor: 0.5 },
    ] as unknown as ConfigModelRoutes.GlobalSchedule[])
    expect(rule.window).toEqual({ daysOfWeek: [0], start: "09:00" })
  })
})

/** Runs `run` with console.warn captured, returning the warning messages (#734). */
const warnings = (run: () => void) => {
  const original = console.warn
  const messages: string[] = []
  console.warn = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "))
  }
  try {
    run()
  } finally {
    console.warn = original
  }
  return messages
}

describe("named windows", () => {
  const windows = new Map([["peak", { daysOfWeek: [1, 5], start: "09:00", end: "17:00" }]])

  test("routeWeightRules resolves a schedule's window by name and drops an unknown name", () => {
    expect(
      routeWeightRules(
        {
          targets: [],
          schedules: [
            { targets: ["*"], when: "peak", factor: 2 },
            { targets: ["*"], when: "nope", factor: 3 },
          ],
        } as unknown as ConfigModelRoutes.Route,
        windows,
      ),
    ).toEqual([{ match: { targets: ["*"] }, window: { daysOfWeek: [1, 5], start: "09:00", end: "17:00" }, factor: 2 }])
  })

  test("weightRulesAcross resolves a schedule's window by name and drops an unknown name", () => {
    expect(
      weightRulesAcross(
        [
          { when: "peak", factor: 2 },
          { when: "nope", factor: 3 },
        ] as unknown as ConfigModelRoutes.GlobalSchedule[],
        windows,
      ),
    ).toEqual([{ window: { daysOfWeek: [1, 5], start: "09:00", end: "17:00" }, factor: 2 }])
  })

  test("expand attaches a resolved gate to a target, including the inverted form", () => {
    const { nodes } = expand(
      "r",
      route([
        { model: "anthropic/claude-opus-4-1", window: "peak" },
        { model: "openai/gpt-6-luna", window: { name: "peak", invert: true } },
        "anthropic/claude-sonnet-4-5",
      ]),
      definitions,
      windows,
    )
    expect(nodes[0].children[0].gate).toEqual({
      name: "peak",
      window: { daysOfWeek: [1, 5], start: "09:00", end: "17:00" },
    })
    expect(nodes[0].children[1].gate).toEqual({
      name: "peak",
      window: { daysOfWeek: [1, 5], start: "09:00", end: "17:00" },
      invert: true,
    })
    expect(nodes[0].children[2].gate).toBeUndefined()
  })

  test("expand attaches a resolved gate to a nested-route target", () => {
    const routes = new Map<string, ConfigModelRoutes.Route>([
      [
        "pool",
        {
          targets: [{ model: { providerID: "anthropic", model: "claude-opus-4-1" } }],
        } as unknown as ConfigModelRoutes.Route,
      ],
      [
        "r",
        {
          targets: [{ model: { providerID: "opencode-route", model: "pool" }, window: "peak" }],
        } as unknown as ConfigModelRoutes.Route,
      ],
    ])
    const { nodes } = expand("r", routes, definitions, windows)
    expect(nodes[0].children[0].gate).toEqual({
      name: "peak",
      window: { daysOfWeek: [1, 5], start: "09:00", end: "17:00" },
    })
  })

  test("expand with an unknown window name leaves the target ungated", () => {
    const { nodes, leaves } = expand(
      "r",
      route([{ model: "anthropic/claude-opus-4-1", window: "nope" }]),
      definitions,
      windows,
    )
    expect(leaves).toHaveLength(1)
    expect(nodes[0].children[0].gate).toBeUndefined()
  })

  test("an unknown window name in a schedule or gate warns, naming the window and the site (#734)", () => {
    const scheduleWarnings = warnings(() =>
      routeWeightRules(
        {
          targets: [],
          schedules: [{ id: "peak-rule", targets: ["*"], when: "nope", factor: 3 }],
        } as unknown as ConfigModelRoutes.Route,
        windows,
      ),
    )
    expect(scheduleWarnings).toHaveLength(1)
    expect(scheduleWarnings[0]).toContain('"nope"')
    expect(scheduleWarnings[0]).toContain("peak-rule")

    const gateWarnings = warnings(() =>
      expand("r", route([{ model: "anthropic/claude-opus-4-1", window: "nope" }]), definitions, windows),
    )
    expect(gateWarnings).toHaveLength(1)
    expect(gateWarnings[0]).toContain('"nope"')
    expect(gateWarnings[0]).toContain('"r"')
  })

  test("configuredWindows drops a defined-but-unparseable window with a warning naming it (#734)", () => {
    const entries = [
      {
        type: "document",
        info: {
          experimental: {
            routes: { windows: {
              bad: { start: "25:99", end: "17:00" },
              peak: { daysOfWeek: [1, 5], start: "09:00", end: "17:00" },
            },
          },
        },
      },
      },
    ] as unknown as Entry[]
    let parsed: ReturnType<typeof configuredWindows> | undefined
    const messages = warnings(() => {
      parsed = configuredWindows(entries)
    })
    expect(parsed?.has("bad")).toBe(false)
    expect(parsed?.has("peak")).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('"bad"')
    expect(messages[0]).toContain("routes.windows")
  })

  test("configuredWindows resolves excludeWindows and drops an unknown or cyclic reference with a warning (#821)", () => {
    const entries = [
      {
        type: "document",
        info: {
          experimental: {
            routes: { windows: {
              "cn-holidays": { dates: ["2026-10-01"], timezone: "Asia/Shanghai" },
              peak: {
                daysOfWeek: [1, 2, 3, 4, 5],
                start: "09:00",
                end: "17:00",
                timezone: "Asia/Shanghai",
                excludeWindows: ["cn-holidays"],
              },
              broken: { excludeWindows: ["nope"] },
              selfish: { excludeWindows: ["selfish"] },
            },
          },
        },
      },
      },
    ] as unknown as Entry[]
    let parsed: ReturnType<typeof configuredWindows> | undefined
    const messages = warnings(() => {
      parsed = configuredWindows(entries)
    })
    expect(parsed?.has("cn-holidays")).toBe(true)
    expect(parsed?.has("broken")).toBe(false)
    expect(parsed?.has("selfish")).toBe(false)
    expect(messages).toHaveLength(2)
    // The resolved peak window is inactive on the named holiday and active on an ordinary weekday,
    // judged with no registry at evaluation time.
    const peak = parsed?.get("peak")!
    expect(ModelRouteSchedule.active(peak, Date.UTC(2026, 9, 1, 2, 0))).toBe(false) // Thu 2026-10-01 10:00 Shanghai
    expect(ModelRouteSchedule.active(peak, Date.UTC(2026, 9, 8, 2, 0))).toBe(true) // Thu 2026-10-08 10:00 Shanghai
  })

  test("a route referenced twice by one parent keeps both group nodes, sharing leaf indexes", () => {
    const routes = new Map<string, ConfigModelRoutes.Route>([
      [
        "flash-plan",
        {
          targets: [{ model: { providerID: "anthropic", model: "claude-sonnet-4-5" } }],
        } as unknown as ConfigModelRoutes.Route,
      ],
      [
        "mimo-plan",
        {
          targets: [{ model: { providerID: "openai", model: "gpt-6-luna" } }],
        } as unknown as ConfigModelRoutes.Route,
      ],
      [
        "background",
        {
          targets: [
            { model: { providerID: "opencode-route", model: "flash-plan" } },
            { model: { providerID: "opencode-route", model: "mimo-plan" } },
            { model: { providerID: "opencode-route", model: "flash-plan" } },
          ],
        } as unknown as ConfigModelRoutes.Route,
      ],
    ])
    const { leaves, nodes } = expand("background", routes, definitions)
    expect(leaves).toHaveLength(2)
    expect(nodes).toHaveLength(4)
    expect(nodes[0].children).toEqual([{ node: 1 }, { node: 2 }, { node: 3 }])
    expect(nodes[1].children).toEqual([{ leaf: 0 }])
    expect(nodes[2].children).toEqual([{ leaf: 1 }])
    expect(nodes[3].children).toEqual([{ leaf: 0 }])
  })
})

describe("per-target context limits", () => {
  const withLimit = (providerID: Provider.ID, id: string, context: number) =>
    [
      id,
      {
        ...Model.Info.default(providerID, Model.ID.make(id)),
        limit: { context, output: 32_000 },
      },
    ] as const

  const mixed = () =>
    new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
      [
        anthropic,
        new Map([
          withLimit(anthropic, "opus", 200_000),
          withLimit(anthropic, "sonnet", 200_000),
          withLimit(anthropic, "haiku", 500_000),
        ]),
      ],
      [openai, new Map([withLimit(openai, "gpt-6-luna", 200_000)])],
    ])

  test("a target-level limit survives schema parsing, and a non-positive ceiling is refused", () => {
    const decode = Schema.decodeUnknownSync(ConfigModelRoutes.Target)
    expect(decode({ model: "anthropic/claude-opus-4-1", limit: { context: 100_000 } })).toMatchObject({
      limit: { context: 100_000 },
    })
    expect(decode("anthropic/claude-opus-4-1")).toMatchObject({
      providerID: "anthropic",
      model: "claude-opus-4-1",
    })
    for (const context of [0, -100]) {
      expect(() => decode({ model: "anthropic/claude-opus-4-1", limit: { context } })).toThrow()
    }
  })

  test("expand threads a per-target limit onto its leaf", () => {
    const { leaves } = expand(
      "r",
      route([{ model: "anthropic/opus", limit: { context: 100_000 } }, "openai/gpt-6-luna"]),
      mixed(),
    )
    expect(leaves.map((leaf) => leaf.contextLimit)).toEqual([100_000, undefined])
  })

  test("a flat mixed-ceiling pool carries per-element ceilings without a nested route", () => {
    const { leaves } = expand(
      "r",
      route([
        { model: "anthropic/opus", limit: { context: 100_000 } },
        { model: "anthropic/sonnet", limit: { context: 100_000 } },
        { model: "anthropic/haiku", limit: { context: 200_000 } },
      ]),
      mixed(),
    )
    expect(leaves.map((leaf) => `${leaf.ref.providerID}/${leaf.ref.id}`)).toEqual([
      "anthropic/opus",
      "anthropic/sonnet",
      "anthropic/haiku",
    ])
    expect(leaves.map((leaf) => leaf.contextLimit)).toEqual([100_000, 100_000, 200_000])
  })

  test("a nested-route reference's own limit caps the leaves reached through it", () => {
    const routes = new Map<string, ConfigModelRoutes.Route>([
      [
        "inner",
        {
          targets: [{ model: { providerID: "anthropic", model: "opus" } }],
        } as unknown as ConfigModelRoutes.Route,
      ],
      [
        "r",
        {
          targets: [
            { model: { providerID: "opencode-route", model: "inner" }, limit: { context: 100_000 } },
            { model: { providerID: "openai", model: "gpt-6-luna" } },
          ],
        } as unknown as ConfigModelRoutes.Route,
      ],
    ])
    const { leaves } = expand("r", routes, mixed())
    expect(leaves.map((leaf) => leaf.contextLimit)).toEqual([100_000, undefined])
  })

  test("a leaf reached through several references keeps the smallest ceiling", () => {
    const both = (first: object, second: object) =>
      new Map<string, ConfigModelRoutes.Route>([
        ["a", { targets: [{ model: { providerID: "anthropic", model: "opus" } }] } as unknown as ConfigModelRoutes.Route],
        ["b", { targets: [{ model: { providerID: "anthropic", model: "opus" } }] } as unknown as ConfigModelRoutes.Route],
        [
          "r",
          {
            targets: [
              { model: { providerID: "opencode-route", model: "a" }, ...first },
              { model: { providerID: "opencode-route", model: "b" }, ...second },
            ],
          } as unknown as ConfigModelRoutes.Route,
        ],
      ])
    for (const routes of [both({ limit: { context: 100_000 } }, {}), both({}, { limit: { context: 100_000 } })]) {
      const { leaves } = expand("r", routes, mixed())
      expect(leaves).toHaveLength(1)
      expect(leaves[0].contextLimit).toBe(100_000)
    }
  })

  test("a duplicate target in the same route still tightens the leaf ceiling", () => {
    const { leaves } = expand(
      "r",
      route(["anthropic/opus", { model: "anthropic/opus", limit: { context: 100_000 } }]),
      mixed(),
    )
    expect(leaves).toHaveLength(1)
    expect(leaves[0].contextLimit).toBe(100_000)
  })

  test("the tighter of the target's own limit and an inherited one wins", () => {
    const routes = new Map<string, ConfigModelRoutes.Route>([
      [
        "inner",
        {
          targets: [{ model: { providerID: "anthropic", model: "opus" }, limit: { context: 150_000 } }],
        } as unknown as ConfigModelRoutes.Route,
      ],
      [
        "r",
        {
          targets: [{ model: { providerID: "opencode-route", model: "inner" }, limit: { context: 100_000 } }],
        } as unknown as ConfigModelRoutes.Route,
      ],
    ])
    const { leaves } = expand("r", routes, mixed())
    expect(leaves.map((leaf) => leaf.contextLimit)).toEqual([100_000])
  })
})

describe("cache formats", () => {
  test("a route-level cache_format reaches every leaf", () => {
    const { leaves } = expand(
      "r",
      route(["anthropic/claude-opus-4-1", "openai/gpt-6-luna"], { cache_format: "anthropic" }),
      definitions,
    )
    expect(leaves.map((leaf) => leaf.cacheFormat)).toEqual(["anthropic", "anthropic"])
  })

  test("a target-level cache_format overrides the route-level one", () => {
    const { leaves } = expand(
      "r",
      route(
        [{ model: "anthropic/claude-opus-4-1", cache_format: "alibaba" }, "openai/gpt-6-luna"],
        { cache_format: "anthropic" },
      ),
      definitions,
    )
    expect(leaves.map((leaf) => leaf.cacheFormat)).toEqual(["alibaba", "anthropic"])
  })

  test("a nested route's own cache_format wins over the one it inherits", () => {
    const routes = new Map<string, ConfigModelRoutes.Route>([
      [
        "inner",
        {
          cache_format: "alibaba",
          targets: [{ model: { providerID: "anthropic", model: "claude-opus-4-1" } }],
        } as unknown as ConfigModelRoutes.Route,
      ],
      [
        "r",
        {
          cache_format: "anthropic",
          targets: [
            { model: { providerID: "opencode-route", model: "inner" } },
            { model: { providerID: "openai", model: "gpt-6-luna" } },
          ],
        } as unknown as ConfigModelRoutes.Route,
      ],
    ])
    const { leaves } = expand("r", routes, definitions)
    expect(leaves.map((leaf) => leaf.cacheFormat)).toEqual(["alibaba", "anthropic"])
  })

  test("leaves carry no cache format when neither the route nor the target declares one", () => {
    const { leaves } = expand("r", route(["anthropic/claude-opus-4-1", "openai/gpt-6-luna"]), definitions)
    expect(leaves.every((leaf) => leaf.cacheFormat === undefined)).toBe(true)
  })
})

describe("door-set targets (#637)", () => {
  const cline = Provider.ID.make("cline-pass")
  const go = Provider.ID.make("opencode-go")
  const doors = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
    [anthropic, models(["deepseek-v4-flash", "claude-sonnet-4-5"])],
    [cline, models(["deepseek-v4-flash", "mimo-flash"])],
    [go, models(["deepseek-v4-flash"])],
    [ModelRoute.PROVIDER_ID, models(["deepseek-v4-flash"])],
  ])
  const doorRoute = (targets: unknown[]) =>
    new Map<string, ConfigModelRoutes.Route>([["r", { targets } as unknown as ConfigModelRoutes.Route]])
  const refs = (leaves: ReturnType<typeof expand>["leaves"]) =>
    leaves.map((leaf) => `${leaf.ref.providerID}/${leaf.ref.id}`)

  test("a door-set target runs its model on every door that lists it, in catalog order, and never on the routes provider", () => {
    const { leaves } = expand("r", doorRoute([{ model: { providerID: "*", model: "deepseek-v4-flash" } }]), doors)
    expect(refs(leaves)).toEqual([
      "anthropic/deepseek-v4-flash",
      "cline-pass/deepseek-v4-flash",
      "opencode-go/deepseek-v4-flash",
    ])
  })

  test("exclusions always win, even for a door that lists the model", () => {
    const { leaves } = expand(
      "r",
      doorRoute([{ model: { providerID: "*", model: "deepseek-v4-flash" }, exclude: ["cline-pass"] }]),
      doors,
    )
    expect(refs(leaves)).toEqual(["anthropic/deepseek-v4-flash", "opencode-go/deepseek-v4-flash"])
  })

  test("a door that does not list the model contributes nothing, and a model no door lists contributes nothing", () => {
    expect(refs(expand("r", doorRoute([{ model: { providerID: "*", model: "claude-sonnet-4-5" } }]), doors).leaves)).toEqual([
      "anthropic/claude-sonnet-4-5",
    ])
    expect(expand("r", doorRoute([{ model: { providerID: "*", model: "no-such-model" } }]), doors).leaves).toEqual([])
  })

  test("a glob model pattern expands over the door set", () => {
    const { leaves } = expand(
      "r",
      doorRoute([{ model: { providerID: "*", model: "deepseek-*" }, exclude: ["opencode-go"] }]),
      doors,
    )
    expect(refs(leaves)).toEqual(["anthropic/deepseek-v4-flash", "cline-pass/deepseek-v4-flash"])
  })

  test("a disabled catalog model is skipped on its door", () => {
    const withDisabled = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
      [anthropic, models(["deepseek-v4-flash"])],
      [
        go,
        new Map([
          [
            "deepseek-v4-flash",
            { ...Model.Info.default(go, Model.ID.make("deepseek-v4-flash")), enabled: false },
          ] as const,
        ]),
      ],
    ])
    const { leaves } = expand("r", doorRoute([{ model: { providerID: "*", model: "deepseek-v4-flash" } }]), withDisabled)
    expect(refs(leaves)).toEqual(["anthropic/deepseek-v4-flash"])
  })

  test("an enumerated target reached again by a door set appears once", () => {
    const { leaves } = expand(
      "r",
      doorRoute([
        { model: { providerID: "anthropic", model: "deepseek-v4-flash" } },
        { model: { providerID: "*", model: "deepseek-v4-flash" } },
      ]),
      doors,
    )
    expect(refs(leaves)).toEqual([
      "anthropic/deepseek-v4-flash",
      "cline-pass/deepseek-v4-flash",
      "opencode-go/deepseek-v4-flash",
    ])
  })

  test("a door-set target composes with variant remaps: a leaf that cannot produce the remapped variant is pruned", () => {
    const withVariants = (providerID: Provider.ID, variants: string[]) =>
      new Map([
        [
          "deepseek-v4-flash",
          {
            ...Model.Info.default(providerID, Model.ID.make("deepseek-v4-flash")),
            variants: variants.map((variant) => ({ id: Model.VariantID.make(variant) })),
          },
        ] as const,
      ])
    const variantDoors = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
      [anthropic, withVariants(anthropic, ["high"])],
      [cline, withVariants(cline, [])],
    ])
    const { leaves } = expand(
      "r",
      doorRoute([
        { model: { providerID: "*", model: "deepseek-v4-flash", variant: "low" }, variants: { low: "high" } },
      ]),
      variantDoors,
    )
    expect(leaves.map((leaf) => `${leaf.ref.providerID}/${leaf.ref.id}#${leaf.ref.variant}`)).toEqual([
      "anthropic/deepseek-v4-flash#high",
    ])
  })
})


describe("pinned variants on suffixed-catalog providers (#985)", () => {
  const proxy = Provider.ID.make("proxy")
  // Definition-stage shape for proxy providers (Antigravity, Open Design): the
  // base model carries no variant list; its effort levels exist in the catalog
  // only as suffixed model ids.
  const defs = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
    [
      proxy,
      new Map([
        ["m", Model.Info.default(proxy, Model.ID.make("m"))],
        ["m-high", Model.Info.default(proxy, Model.ID.make("m-high"))],
      ]),
    ],
  ])
  const raw = (entries: [string, unknown][]) =>
    new Map(entries as [string, ConfigModelRoutes.Route][])

  test("a pinned variant the catalog exposes as a suffixed model does not prune the leaf", () => {
    const routes = raw([
      ["r", { targets: [{ model: { providerID: "proxy", model: "m", variant: "high" } }] }],
    ])
    const { leaves } = expand("r", routes, defs)
    expect(leaves.map((leaf) => `${leaf.ref.providerID}/${leaf.ref.id}#${leaf.ref.variant}`)).toEqual([
      "proxy/m#high",
    ])
  })

  test("a variant inherited through a nested route does not prune the leaf either", () => {
    const routes = raw([
      ["pool", { targets: [{ model: { providerID: "proxy", model: "m" } }] }],
      ["r", { targets: [{ model: { providerID: "opencode-route", model: "pool", variant: "high" } }] }],
    ])
    const { leaves } = expand("r", routes, defs)
    expect(leaves.map((leaf) => `${leaf.ref.providerID}/${leaf.ref.id}#${leaf.ref.variant}`)).toEqual([
      "proxy/m#high",
    ])
  })

  test("a pinned variant with no native, remapped, or suffixed evidence still prunes", () => {
    const routes = raw([
      ["r", { targets: [{ model: { providerID: "proxy", model: "m", variant: "ultra" } }] }],
    ])
    const { leaves } = expand("r", routes, defs)
    expect(leaves).toEqual([])
  })
})

describe("provider routes", () => {
  const main = Provider.ID.make("openai")
  const alt = Provider.ID.make("openai.alternate")
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
  ])
  const providerRoutes = (
    id: string,
    extra: Partial<ModelRoute.ProviderRoute> = {},
  ): ReadonlyMap<string, ModelRoute.ProviderRoute> =>
    new Map([
      [id, { providers: ["openai.alternate", "openai"], selection: "ordered" as const, weights: {}, ...extra }],
    ])
  const definitionOf = (expanded: ReturnType<typeof expand>): ModelRoute.Definition =>
    ({
      id: "r",
      targets: expanded.leaves.map((leaf) => leaf.ref),
      targetVariants: expanded.leaves.map(() => ({})),
      health: ModelRoute.policy(),
      nodes: expanded.nodes,
    }) as unknown as ModelRoute.Definition
  const refs = (expanded: ReturnType<typeof expand>) =>
    expanded.leaves.map((leaf) => `${leaf.ref.providerID}/${leaf.ref.id}`)

  test("a provider route target expands to a marked group of the members' leaves for the model, in member order", () => {
    const { leaves, nodes } = expand("r", route(["openai-plan/gpt-6.1-terra"]), both, new Map(), providerRoutes("openai-plan"))
    expect(refs({ leaves, nodes })).toEqual(["openai.alternate/gpt-6.1-terra", "openai/gpt-6.1-terra"])
    expect(nodes).toHaveLength(2)
    expect(nodes[0].children).toEqual([{ node: 1 }])
    expect(nodes[1]).toMatchObject({ routeID: "openai-plan", providerRoute: "openai-plan", selection: "ordered" })
    expect(nodes[1].children).toEqual([{ leaf: 0 }, { leaf: 1 }])
    expect(nodes[1].weights).toEqual([1, 1])
  })

  test("the group carries the provider route's weights, and the parent weights the group by the target as written", () => {
    const routes = route(["openai-plan/gpt-6.1-terra"], { weights: { "openai-plan/gpt-6.1-terra": 5 } })
    const { nodes } = expand(
      "r",
      routes,
      both,
      new Map(),
      providerRoutes("openai-plan", { weights: { "openai.alternate": 2, openai: 1 } }),
    )
    expect(nodes[0].weights).toEqual([5])
    expect(nodes[1].weights).toEqual([2, 1])
  })

  test("a member that does not offer the model is skipped, and a model no member offers leaves a leafless group node", () => {
    const partial = catalog([
      [main, ["gpt-6.1-terra"]],
      [alt, ["gpt-6.1-terra", "gpt-6.1-sol"]],
    ])
    const sol = expand("r", route(["openai-plan/gpt-6.1-sol"]), partial, new Map(), providerRoutes("openai-plan"))
    expect(refs(sol)).toEqual(["openai.alternate/gpt-6.1-sol"])
    expect(sol.nodes[1].children).toEqual([{ leaf: 0 }])

    const none = expand(
      "r",
      route(["openai-plan/gpt-6.1-luna", "openai.alternate/gpt-6.1-terra"]),
      partial,
      new Map(),
      providerRoutes("openai-plan"),
    )
    expect(refs(none)).toEqual(["openai.alternate/gpt-6.1-terra"])
    // The unservable group contributes no leaves, but it stays in the tree as a
    // leafless group node so the decision layer can exclude it with a reason
    // instead of the seat vanishing silently.
    expect(none.nodes).toHaveLength(2)
    expect(none.nodes[0].children).toEqual([{ node: 1 }, { leaf: 0 }])
    expect(none.nodes[1]).toMatchObject({ routeID: "openai-plan", providerRoute: "openai-plan" })
    expect(none.nodes[1].children).toEqual([])
  })

  test("a member that cannot produce the target's variant is skipped for that dispatch", () => {
    const withVariants = (providerID: Provider.ID, id: string, variants: string[]) =>
      [
        id,
        {
          ...Model.Info.default(providerID, Model.ID.make(id)),
          variants: variants.map((variant) => ({ id: Model.VariantID.make(variant) })),
        },
      ] as const
    const definitionsWithVariants = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
      [main, new Map([withVariants(main, "gpt-6.1-terra", [])])],
      [alt, new Map([withVariants(alt, "gpt-6.1-terra", ["high"])])],
    ])
    const routes = new Map<string, ConfigModelRoutes.Route>([
      [
        "r",
        {
          targets: [{ model: { providerID: "openai-plan", model: "gpt-6.1-terra", variant: "high" } }],
        } as unknown as ConfigModelRoutes.Route,
      ],
    ])
    const { leaves, nodes } = expand("r", routes, definitionsWithVariants, new Map(), providerRoutes("openai-plan"))
    expect(refs({ leaves, nodes })).toEqual(["openai.alternate/gpt-6.1-terra"])
    expect(leaves[0].ref.variant).toBe(Model.VariantID.make("high"))
    expect(nodes[1].children).toEqual([{ leaf: 0 }])
  })

  test("a glob model fans out into one provider route group per model, and a group never mixes models", () => {
    const expanded = expand("r", route(["openai-plan/gpt-6.1-*"]), both, new Map(), providerRoutes("openai-plan"))
    expect(refs(expanded)).toEqual([
      "openai.alternate/gpt-6.1-terra",
      "openai/gpt-6.1-terra",
      "openai.alternate/gpt-6.1-sol",
      "openai/gpt-6.1-sol",
    ])
    const groups = expanded.nodes.filter((node) => node.providerRoute === "openai-plan")
    expect(groups).toHaveLength(2)
    for (const group of groups) {
      const models = group.children.map((child) => expanded.leaves[child.leaf!].ref.id)
      expect(new Set(models).size).toBe(1)
    }
  })

  test("a fixed route sees the provider route group as ordered with unit weights", () => {
    const routes = route(["openai-plan/gpt-6.1-terra"], { autonomy: "fixed" })
    const { nodes } = expand(
      "r",
      routes,
      both,
      new Map(),
      providerRoutes("openai-plan", { selection: "round-robin", weights: { "openai.alternate": 2, openai: 1 } }),
    )
    expect(nodes[1].selection).toBe("ordered")
    expect(nodes[1].weights).toEqual([1, 1])
  })

  test("a concrete provider wins over a provider route with the same id", () => {
    const clash = providerRoutes("openai", { providers: ["openai.alternate"] })
    const expanded = expand("r", route(["openai/gpt-6.1-terra"]), both, new Map(), clash)
    expect(refs(expanded)).toEqual(["openai/gpt-6.1-terra"])
    expect(expanded.nodes.some((node) => node.providerRoute !== undefined)).toBe(false)
  })

  test("ordered provider route: the first ready member serves, and failover falls through to the next", () => {
    const definition = definitionOf(expand("r", route(["openai-plan/gpt-6.1-terra"]), both, new Map(), providerRoutes("openai-plan")))
    const all = new Set([0, 1])
    expect(ModelRoute.nextTarget(definition, all, new Set(), "s1", true)).toBe(0)
    expect(ModelRoute.nextTarget(definition, new Set([1]), new Set(), "s2", true)).toBe(1)
    expect(ModelRoute.orderTargets(definition, all, undefined, false)).toEqual([0, 1])
  })

  test("round-robin provider route rotates evenly across sessions", () => {
    const definition = definitionOf(
      expand("r", route(["plan-rr/gpt-6.1-terra"]), both, new Map(), providerRoutes("plan-rr", { selection: "round-robin" })),
    )
    const all = new Set([0, 1])
    const heads = ["s1", "s2", "s3", "s4"].map((session) => ModelRoute.nextTarget(definition, all, new Set(), session, true))
    expect(heads).toEqual([0, 1, 0, 1])
  })

  test("round-robin provider route tiers: the heavier member is the top tier until it cannot serve", () => {
    const definition = definitionOf(
      expand(
        "r",
        route(["plan-tier/gpt-6.1-terra"]),
        both,
        new Map(),
        providerRoutes("plan-tier", { selection: "round-robin", weights: { "openai.alternate": 2, openai: 1 } }),
      ),
    )
    const all = new Set([0, 1])
    expect(ModelRoute.nextTarget(definition, all, new Set(), "t1", true)).toBe(0)
    expect(ModelRoute.nextTarget(definition, all, new Set(), "t2", true)).toBe(0)
    expect(ModelRoute.orderTargets(definition, all, undefined, false)).toEqual([0, 1])
    expect(ModelRoute.nextTarget(definition, new Set([1]), new Set(), "t3", true)).toBe(1)
  })

  test("weighted provider route draws by member weights and sticks per session", () => {
    const definition = definitionOf(
      expand(
        "r",
        route(["plan-weighted/gpt-6.1-terra"]),
        both,
        new Map(),
        providerRoutes("plan-weighted", { selection: "weighted", weights: { "openai.alternate": 3, openai: 1 } }),
      ),
    )
    const all = new Set([0, 1])
    expect(ModelRoute.nextTarget(definition, all, new Set(), "w1", true, undefined, undefined, () => 0)).toBe(0)
    expect(ModelRoute.nextTarget(definition, all, new Set(), "w2", true, undefined, undefined, () => 0.99)).toBe(1)
    expect(ModelRoute.nextTarget(definition, all, new Set(), "w1", true, undefined, undefined, () => 0.99)).toBe(0)
  })
})

describe("configuredProviderRoutes", () => {
  const entriesWith = (providers: unknown) =>
    [{ type: "document", info: { experimental: { routes: { providers } } } }] as unknown as Entry[]
  const known = new Set(["openai", "openai.alternate", "anthropic"])
  const noRoutes = new Map<string, ConfigModelRoutes.Route>()

  test("a valid provider route is kept, with its defaults filled", () => {
    const parsed = configuredProviderRoutes(
      entriesWith({ "openai-plan": { providers: ["openai.alternate", "openai"] } }),
      known,
      noRoutes,
    )
    expect(parsed.get("openai-plan")).toEqual({
      providers: ["openai.alternate", "openai"],
      selection: "ordered",
      weights: {},
    })
  })

  test("an id naming a concrete provider, the routes provider, or a route is dropped with a warning", () => {
    const routes = new Map<string, ConfigModelRoutes.Route>([
      ["terra-plan", {} as unknown as ConfigModelRoutes.Route],
    ])
    let parsed: ReturnType<typeof configuredProviderRoutes> | undefined
    const messages = warnings(() => {
      parsed = configuredProviderRoutes(
        entriesWith({
          openai: { providers: ["openai.alternate"] },
          "opencode-route": { providers: ["openai"] },
          "terra-plan": { providers: ["openai"] },
          "openai-plan": { providers: ["openai.alternate", "openai"] },
        }),
        known,
        routes,
      )
    })
    expect([...(parsed?.keys() ?? [])]).toEqual(["openai-plan"])
    // Members resolve concrete-first too: openai-plan keeps its "openai" member even though a
    // rejected provider route claimed that id.
    expect(parsed?.get("openai-plan")?.providers).toEqual(["openai.alternate", "openai"])
    expect(messages).toHaveLength(3)
    expect(messages[0]).toContain('"openai"')
    expect(messages[1]).toContain('"opencode-route"')
    expect(messages[2]).toContain('"terra-plan"')
  })

  test("a member naming another provider route or the routes provider drops, duplicates drop, an unknown member stays with a warning", () => {
    let parsed: ReturnType<typeof configuredProviderRoutes> | undefined
    const messages = warnings(() => {
      parsed = configuredProviderRoutes(
        entriesWith({
          "openai-plan": { providers: ["openai.alternate", "openai"] },
          combo: { providers: ["openai-plan", "opencode-route", "openai", "openai", "mystery"] },
        }),
        known,
        noRoutes,
      )
    })
    expect(parsed?.get("combo")?.providers).toEqual(["openai", "mystery"])
    expect(messages).toHaveLength(4)
  })

  test("a provider route whose members all drop is itself dropped", () => {
    let parsed: ReturnType<typeof configuredProviderRoutes> | undefined
    const messages = warnings(() => {
      parsed = configuredProviderRoutes(entriesWith({ empty: { providers: ["opencode-route"] } }), known, noRoutes)
    })
    expect(parsed?.has("empty")).toBe(false)
    expect(messages.length).toBeGreaterThan(0)
  })
})

describe("provider routes with no ready member (observability)", () => {
  const main = Provider.ID.make("openai")
  const alt = Provider.ID.make("openai.alternate")
  const catalog = (entries: [Provider.ID, string[]][]) =>
    new Map<Provider.ID, ReadonlyMap<string, Model.Info>>(
      entries.map(
        ([id, ids]) =>
          [id, new Map(ids.map((model) => [model, Model.Info.default(id, Model.ID.make(model))] as const))] as const,
      ),
    )
  const providerRoutes: ReadonlyMap<string, ModelRoute.ProviderRoute> = new Map([
    ["openai-plan", { providers: ["openai.alternate", "openai"], selection: "ordered" as const, weights: {} }],
  ])

  test("a group no member offers the model for stays in the tree as a leafless group node", () => {
    const defs = catalog([
      [main, ["gpt-6.1-terra"]],
      [alt, ["gpt-6.1-terra"]],
    ])
    const { leaves, nodes } = expand(
      "r",
      route(["openai-plan/gpt-6-luna", "openai.alternate/gpt-6.1-terra"]),
      defs,
      new Map(),
      providerRoutes,
    )
    expect(leaves.map((leaf) => `${leaf.ref.providerID}/${leaf.ref.id}`)).toEqual(["openai.alternate/gpt-6.1-terra"])
    expect(nodes).toHaveLength(2)
    expect(nodes[0].children).toEqual([{ node: 1 }, { leaf: 0 }])
    expect(nodes[1]).toMatchObject({ routeID: "openai-plan", providerRoute: "openai-plan", selection: "ordered" })
    expect(nodes[1].children).toEqual([])
  })
})
