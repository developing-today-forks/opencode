export * as RouteAdjustTool from "./route-adjust.js"

import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { ToolFailure } from "@opencode/ai/effect"
import { Effect, Schema } from "effect"
import type { Permission } from "../../permission.js"
import { ModelRoute } from "../../model-route.js"
import { ModelRouteSchedule } from "../../model-route-schedule.js"

export const name = "route_adjust"

export const description = `Record what the user told you about model availability so routed models (opencode-route/*) adapt for a while.

Use it when the user says things like "my Anthropic promo credits expire in 3 days, favor Claude", "OpenAI is out of quota until tomorrow", "skip glm, it's too slow today", or "during peak hours, weekdays 9 to 5, downweight deepseek".
Translate the statement into one adjustment:
- action "weight" with a factor above 1 to favor matching targets, or below 1 to downplay them; use weight instead of factor to set the target's weight outright
- action "skip" to avoid matching targets unless nothing else is available
- match is a case-insensitive substring of provider/model, e.g. "anthropic", "claude" or "openai/gpt-6-luna"
- hours is how long the adjustment lasts, when the user gives a duration
- for a recurring time of day, pass a window of daysOfWeek (mon..sun), daysOfMonth (1..31, -1 is the last day), start and end as "HH:mm", and timezone as an IANA name such as "America/Chicago". "Weekdays" is mon..fri and "weekends" is sat..sun. A window with no hours recurs indefinitely; hours, when given, still ends the whole adjustment. Never invent which hours "peak" means: use the times the user stated.
Use action "list" to show active adjustments and "remove" with an id to cancel one. Only act on what the user actually said.`

export const Input = Schema.Struct({
  action: Schema.Literals(["add", "list", "remove"]),
  id: Schema.String.pipe(Schema.optional).annotate({
    description: "Adjustment id; generated when adding without one.",
  }),
  match: Schema.String.pipe(Schema.optional).annotate({ description: "Substring of provider/model to match." }),
  effect: Schema.Literals(["weight", "skip"]).pipe(Schema.optional),
  factor: Schema.Finite.check(Schema.isBetween({ minimum: 0.01, maximum: 100 })).pipe(Schema.optional),
  weight: Schema.Finite.check(Schema.isBetween({ minimum: 0.01, maximum: 100 })).pipe(Schema.optional),
  hours: Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 24 * 30 })).pipe(Schema.optional),
  daysOfWeek: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: 'Days the window recurs on, e.g. ["mon","tue"] or ["sat","sun"].',
  }),
  daysOfMonth: Schema.Array(Schema.Finite).pipe(Schema.optional).annotate({
    description: "Days of the month the window recurs on, 1-31, or -1 for the last day.",
  }),
  start: Schema.String.pipe(Schema.optional).annotate({ description: 'Window start, local time "HH:mm".' }),
  end: Schema.String.pipe(Schema.optional).annotate({ description: 'Window end, local time "HH:mm", exclusive.' }),
  timezone: Schema.String.pipe(Schema.optional).annotate({
    description: 'IANA timezone such as "America/Chicago"; omit for the host\'s local time.',
  }),
  note: Schema.String.pipe(Schema.optional).annotate({
    description: "The user's words or reason, kept for later review.",
  }),
})

export const Output = Schema.Struct({ adjustments: Schema.Array(Schema.Unknown) })

const describe = (item: ModelRoute.Adjustment) =>
  `${item.id}: ${item.action}${item.weight !== undefined ? ` =${item.weight}` : item.action === "weight" ? ` x${item.factor ?? 1}` : ""} "${item.match}"${
    item.schedule ? ` during ${ModelRouteSchedule.describe(item.schedule)}` : ""
  }${item.until ? ` until ${new Date(item.until).toISOString()}` : ""}${item.note ? ` (${item.note})` : ""}`

export type Input = typeof Input.Type

/** The window from the tool's day and time fields, or undefined when none was asked for. */
const windowOf = (input: Input) => {
  const fields = {
    ...(input.daysOfWeek && input.daysOfWeek.length > 0 ? { daysOfWeek: input.daysOfWeek } : {}),
    ...(input.daysOfMonth && input.daysOfMonth.length > 0 ? { daysOfMonth: input.daysOfMonth } : {}),
    ...(input.start ? { start: input.start } : {}),
    ...(input.end ? { end: input.end } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
  }
  if (Object.keys(fields).length === 0) return undefined
  return ModelRouteSchedule.parse(fields)
}

/** The tool's effect, separate from permission handling so it can be exercised directly. */
export const apply = (input: Input) => {
  if (input.action === "remove") {
    const removed = input.id !== undefined && ModelRoute.removeAdjustment(input.id)
    return {
      output: { adjustments: ModelRoute.activeAdjustments() },
      content: removed ? `Removed ${input.id}` : "No such adjustment",
    }
  }
  if (input.action === "add") {
    if (!input.match || !input.effect)
      return {
        output: { adjustments: ModelRoute.activeAdjustments() },
        content: "Adding needs match and effect.",
      }
    const asked = input.daysOfWeek !== undefined || input.daysOfMonth !== undefined || input.start || input.end || input.timezone
    const schedule = windowOf(input)
    if (asked && schedule === undefined)
      return {
        output: { adjustments: ModelRoute.activeAdjustments() },
        content: "That window could not be read; check the day names, HH:mm times and IANA timezone.",
      }
    if (!input.hours && !schedule)
      return {
        output: { adjustments: ModelRoute.activeAdjustments() },
        content: "Adding needs hours, a recurring window, or both.",
      }
    const item: ModelRoute.Adjustment = {
      id: input.id ?? `${input.effect}-${input.match}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"),
      match: input.match,
      action: input.effect,
      ...(input.effect === "weight" && input.weight !== undefined ? { weight: input.weight } : {}),
      ...(input.effect === "weight" && input.weight === undefined ? { factor: input.factor ?? 2 } : {}),
      ...(schedule ? { schedule } : {}),
      ...(input.hours ? { until: Date.now() + input.hours * 3_600_000 } : {}),
      note: input.note,
    }
    ModelRoute.addAdjustment(item, input.note)
    return { output: { adjustments: ModelRoute.activeAdjustments() }, content: `Recorded ${describe(item)}` }
  }
  const active = ModelRoute.activeAdjustments()
  return {
    output: { adjustments: active },
    content: active.length ? active.map(describe).join("\n") : "No active adjustments.",
  }
}

/** Registered only while model routes are configured, so other setups carry no extra tool. Changing
 * adjustments needs the same approval as any other tool that alters behaviour. */
export const add = (editor: ToolEditor, permission: Permission.Interface) =>
  editor.add({
    name,
    options: { codemode: false },
    description,
    input: Input,
    output: Output,
    execute: (input, context) =>
      (input.action === "list"
        ? Effect.void
        : permission
            .assert({
              action: name,
              resources: [input.match ?? input.id ?? "*"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            .pipe(Effect.mapError((error) => new ToolFailure({ message: `Permission denied: ${name}`, error })))
      ).pipe(Effect.andThen(Effect.sync(() => apply(input)))),
  })
