export * as ConfigAgent from "./agent.js"

import { Effect, Schema } from "effect"
import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { NonNegativeInt, optional, PositiveInt } from "../schema.js"
import { ConfigModel } from "./model.js"
import { ConfigProvider } from "./provider.js"

export const Color = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/u))

export class Info extends Schema.Class<Info>("Config.Agent")({
  model: ConfigModel.Selection.pipe(optional),
  models: Schema.Array(Model.Selector).pipe(optional),
  excluded_models: Schema.Array(Model.Selector).pipe(optional),
  subagent_models: Schema.Array(Model.Selector).pipe(optional),
  subagent_excluded_models: Schema.Array(Model.Selector).pipe(optional),
  max_depth: NonNegativeInt.pipe(optional),
  request: ConfigProvider.Request.pipe(optional),
  system: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mode: Schema.Literals(["subagent", "primary", "all"]).pipe(optional),
  hidden: Schema.Boolean.pipe(optional),
  // An unsupported color, such as a V1 theme name, should not drop the whole agent.
  color: Color.pipe(
    Schema.catchDecoding(() => Effect.succeedNone),
    optional,
  ),
  steps: PositiveInt.pipe(optional),
  disabled: Schema.Boolean.pipe(optional),
  permissions: Permission.Ruleset.pipe(optional),
}) {}
