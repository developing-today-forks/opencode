import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Info } from "@opencode/schema/config"
import { Agent } from "@opencode/core/agent"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { NotFoundError } from "@opencode/core/session"
import { SessionSchema } from "@opencode/core/session/schema"
import { SubagentDepth } from "@opencode/core/session/subagent-depth"
import { Money } from "@opencode/schema/money"

const decodeInfo = Schema.decodeUnknownSync(Info)

const info = (id: string, options: { parentID?: string; agent?: string } = {}): SessionSchema.Info =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.make(id),
    parentID: options.parentID ? SessionSchema.ID.make(options.parentID) : undefined,
    projectID: Project.ID.global,
    agent: options.agent ? Agent.ID.make(options.agent) : undefined,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
  })

const sessions = (list: SessionSchema.Info[]) => {
  const byID = new Map(list.map((session) => [session.id, session]))
  return {
    get: (sessionID: SessionSchema.ID) => {
      const session = byID.get(sessionID)
      return session ? Effect.succeed(session) : Effect.fail(new NotFoundError({ sessionID }))
    },
  }
}

const config = (input: Record<string, unknown> = {}) => ({
  entries: () =>
    Effect.succeed([
      {
        type: "document" as const,
        info: decodeInfo(input),
      } as never,
    ]),
})

const run = (all: SessionSchema.Info[], parent: SessionSchema.Info, configInput: Record<string, unknown> = {}) =>
  Effect.runPromise(SubagentDepth.assertWithinLimit(sessions(all), config(configInput), parent))

const runDenied = async (
  all: SessionSchema.Info[],
  parent: SessionSchema.Info,
  configInput: Record<string, unknown> = {},
) => {
  const error = await Effect.runPromise(
    SubagentDepth.assertWithinLimit(sessions(all), config(configInput), parent).pipe(Effect.flip),
  )
  expect(error).toBeInstanceOf(SubagentDepth.LimitError)
  return (error as SubagentDepth.LimitError).message
}

/** root (depth 0) -> capped (depth 1) -> mid (depth 2) -> leaf (depth 3) */
const chain = [
  info("ses_root"),
  info("ses_capped", { parentID: "ses_root", agent: "capped" }),
  info("ses_mid", { parentID: "ses_capped" }),
  info("ses_leaf", { parentID: "ses_mid" }),
]

describe("SubagentDepth.assertWithinLimit", () => {
  test("a depth-1 launcher with max_depth 2 caps its subtree at depth 3 (global 5)", async () => {
    const configInput = { experimental: { subagent_depth: 5 }, agents: { capped: { max_depth: 2 } } }
    // Launching from depth 2 creates depth 3: allowed, and the returned depth is the launcher's.
    expect(await run(chain, chain[2], configInput)).toBe(2)
    // Launching from depth 3 would create depth 4: denied by the per-agent cap, not the global 5.
    const message = await runDenied(chain, chain[3], configInput)
    expect(message).toContain("(3)")
    expect(message).toContain("capped")
    expect(message).toContain("max_depth")
  })

  test("max_depth 0 on a root agent disables launches from it", async () => {
    const root = info("ses_root", { agent: "capped" })
    const message = await runDenied([root], root, { agents: { capped: { max_depth: 0 } } })
    expect(message).toContain("max_depth")
    expect(message).toContain("(0)")
  })

  test("global subagent_depth 0 still disables launches from a top-level session (#89)", async () => {
    const root = info("ses_root")
    const message = await runDenied([root], root, { experimental: { subagent_depth: 0 } })
    expect(message).toContain("experimental.subagent_depth")
    expect(message).toContain("(0)")
  })

  test("without max_depth the global limit behaves exactly as before", async () => {
    const configInput = { experimental: { subagent_depth: 2 } }
    expect(await run(chain, chain[1], configInput)).toBe(1)
    const message = await runDenied(chain, chain[2], configInput)
    expect(message).toContain("experimental.subagent_depth")
    expect(message).toContain("(2)")
  })

  test("a shallower ancestor's max_depth binds deeper launches", async () => {
    // Root agent allows 1 level: children at depth 1 launch nothing.
    const rooted = [
      info("ses_root", { agent: "shallow" }),
      info("ses_child", { parentID: "ses_root" }),
    ]
    const configInput = { agents: { shallow: { max_depth: 1 } } }
    expect(await run(rooted, rooted[0], configInput)).toBe(0)
    const message = await runDenied(rooted, rooted[1], configInput)
    expect(message).toContain("shallow")
    expect(message).toContain("(1)")
  })
})

describe("SubagentDepth.readout / formatDepthLine (#2245)", () => {
  const runReadout = (
    all: SessionSchema.Info[],
    session: SessionSchema.Info,
    configInput: Record<string, unknown> = {},
  ) => Effect.runPromise(SubagentDepth.readout(sessions(all), config(configInput), session))

  const runReadoutDenied = async (
    all: SessionSchema.Info[],
    session: SessionSchema.Info,
    configInput: Record<string, unknown> = {},
  ) => {
    const error = await Effect.runPromise(
      SubagentDepth.readout(sessions(all), config(configInput), session).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(SubagentDepth.LimitError)
    return (error as SubagentDepth.LimitError).message
  }

  test("top-level session: depth 0, global cap, all levels remain", async () => {
    const root = info("ses_root")
    const readout = await runReadout([root], root)
    expect(readout).toEqual({ depth: 0, cap: 5, remaining: 5 })
    expect(SubagentDepth.formatDepthLine(readout)).toBe(
      "Your session is at depth 0 of the subagent depth cap 5: 5 nesting level(s) remain from here.",
    )
  })

  test("nested session: depth counts ancestors, remaining shrinks", async () => {
    const readout = await runReadout(chain, chain[2])
    expect(readout).toEqual({ depth: 2, cap: 5, remaining: 3 })
    expect(SubagentDepth.formatDepthLine(readout)).toContain("depth 2 of the subagent depth cap 5: 3 nesting")
  })

  test("max_depth-bound subtree: depth-1 child of a max_depth 1 root has 0 remaining, not 4", async () => {
    const rooted = [info("ses_root", { agent: "shallow" }), info("ses_child", { parentID: "ses_root" })]
    const configInput = { agents: { shallow: { max_depth: 1 } } }
    expect(await runReadout(rooted, rooted[0], configInput)).toEqual({ depth: 0, cap: 1, remaining: 1 })
    const child = await runReadout(rooted, rooted[1], configInput)
    expect(child).toEqual({ depth: 1, cap: 1, remaining: 0 })
    expect(SubagentDepth.formatDepthLine(child)).toContain("cap 1: 0 nesting level(s) remain")
  })

  test("parent cycle: readout fails so the caller omits the line", async () => {
    const cyclic = [info("ses_a", { parentID: "ses_b" }), info("ses_b", { parentID: "ses_a" })]
    const message = await runReadoutDenied(cyclic, cyclic[0])
    expect(message).toContain("Session parent cycle")
  })

  test("session-lookup failure: readout fails so the caller omits the line", async () => {
    const orphan = info("ses_child", { parentID: "ses_missing" })
    const message = await runReadoutDenied([orphan], orphan)
    expect(message).toContain("Parent session not found: ses_missing")
  })
})
