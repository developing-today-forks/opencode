/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill.js"

import { define, type Context } from "@opencode/plugin/effect/plugin"
import { Document } from "@opencode/schema/config"
import { Effect } from "effect"
import { AbsolutePath } from "../schema.js"
import { Skill } from "../skill.js"
import { Config } from "../config.js"
import os from "os"
import opencodeContent from "./skill/opencode.md" with { type: "text" }
import reportContent from "./skill/report.md" with { type: "text" }
import routingReviewContent from "./skill/routing-review.md" with { type: "text" }
import routingUsageContent from "./skill/routing-usage.md" with { type: "text" }
import planTrackingContent from "./skill/plan-tracking.md" with { type: "text" }
import routingConfigContent from "./skill/routing-config.md" with { type: "text" }

export const OpencodeContent = opencodeContent
export const ReportContent = reportContent
export const RoutingReviewContent = routingReviewContent
export const RoutingUsageContent = routingUsageContent
export const PlanTrackingContent = planTrackingContent
export const RoutingConfigContent = routingConfigContent

export const OpencodeDescription =
  "Use this skill for any question about OpenCode itself, including how OpenCode works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OpenCode SDK, clients, server, or API, and contributing to the OpenCode codebase. Also use it for OpenCode agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app."
const REPORT_DESCRIPTION =
  "Use when the user wants to report an opencode issue or bug. Collect standard diagnostics, add user-specific reproduction context, and publish the issue with GitHub CLI."
export const RoutingReviewDescription =
  "Use when the user asks to review, audit, tune or explain their model pools (opencode-route/*), pool weights, schedules or failover, OpenChamber categories and classification, which providers or models to use or turn off, cost tiers, or how to make their plans and quotas last. Reads route history, usage and plan records, recommends changes, and changes nothing without approval."
export const RoutingUsageDescription =
  "Use when the user asks what was used: tokens, requests, cost or quota per session, provider, model, pool or day, or which pool did or did not use a provider or model. Explains route_usage, what each figure means, and what the history cannot show."
export const PlanTrackingDescription =
  "Use when the user talks about their subscriptions, quotas, credits or plan limits: recording or updating a plan, how to find its current details, notes about running out or having quota left over, or what they expect from a plan or model. Reads and records plan records with plan_info."
export const RoutingConfigDescription =
  "Use when the user wants to change OpenCode configuration for models: hide or show a model, turn a provider on or off, add a custom model, or change pools, the patterns that pick their models, their effort levels, weights, schedules, budgets, autonomy or tuning. Gives the exact keys and a safe way to apply the change."

export const Plugin = define({
  id: "opencode.skill",
  effect: Effect.fn(function* (ctx) {
    const reportContent = yield* reportContentWithDiagnostics(ctx.app)
    yield* ctx.skill.transform((editor) => {
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("opencode"),
          name: Skill.Name.make("OpenCode"),
          description: OpencodeDescription,
          path: AbsolutePath.make("/builtin/opencode.md"),
          content: OpencodeContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("report"),
          name: Skill.Name.make("Report"),
          description: REPORT_DESCRIPTION,
          path: AbsolutePath.make("/builtin/report.md"),
          content: reportContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("routing-review"),
          name: Skill.Name.make("Routing Review"),
          description: RoutingReviewDescription,
          path: AbsolutePath.make("/builtin/routing-review.md"),
          content: RoutingReviewContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("routing-usage"),
          name: Skill.Name.make("Routing Usage"),
          description: RoutingUsageDescription,
          path: AbsolutePath.make("/builtin/routing-usage.md"),
          content: RoutingUsageContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("plan-tracking"),
          name: Skill.Name.make("Plan Tracking"),
          description: PlanTrackingDescription,
          path: AbsolutePath.make("/builtin/plan-tracking.md"),
          content: PlanTrackingContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("routing-config"),
          name: Skill.Name.make("Routing Config"),
          description: RoutingConfigDescription,
          path: AbsolutePath.make("/builtin/routing-config.md"),
          content: RoutingConfigContent,
        }),
      )
    })
  }),
})

const reportContentWithDiagnostics = Effect.fn("SkillPlugin.reportContentWithDiagnostics")(function* (
  app: Context["app"],
) {
  const plugins = yield* configuredPlugins()
  // Under emulation on Windows ARM64, os.arch() reads x64 but PROCESSOR_IDENTIFIER still names the ARM host.
  const emulated =
    process.platform === "win32" && os.arch() === "x64" && process.env.PROCESSOR_IDENTIFIER?.startsWith("ARM")
  return [
    ReportContent,
    "",
    "## Runtime Diagnostics Snapshot",
    "",
    "These values were captured when the built-in report skill was registered. Verify them before publishing.",
    "",
    `- opencode version: ${app.version}`,
    `- install/channel: ${app.channel}`,
    `- OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()}${emulated ? ", emulated on ARM64" : ""})`,
    `- Terminal: ${terminal()}`,
    `- Shell: ${shell()}`,
    `- Active plugins: ${plugins.length === 0 ? "None found in config" : plugins.join(", ")}`,
  ].join("\n")
})

const configuredPlugins = Effect.fn("SkillPlugin.configuredPlugins")(function* () {
  const config = yield* Config.Service
  return (yield* config.entries())
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) => entry.info.plugins ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry.package))
    .toSorted()
})

function terminal() {
  return (
    [
      process.env.TERM_PROGRAM ? `TERM_PROGRAM=${process.env.TERM_PROGRAM}` : undefined,
      process.env.TERM ? `TERM=${process.env.TERM}` : undefined,
      process.env.COLORTERM ? `COLORTERM=${process.env.COLORTERM}` : undefined,
    ]
      .filter((item): item is string => item !== undefined)
      .join(", ") || "Unavailable: terminal environment variables are not set"
  )
}

function shell() {
  return (
    process.env.SHELL ??
    process.env.ComSpec ??
    process.env.COMSPEC ??
    "Unavailable: shell environment variable is not set"
  )
}
