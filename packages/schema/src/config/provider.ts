export * as ConfigProvider from "./provider.js"

import { Schema, Struct } from "effect"
import { Money } from "../money.js"
import { Capabilities, Compatibility, Family, ID, Model, Type, VariantID } from "../model.js"
import { ProviderCompatibility } from "../model-compatibility.js"
import { Provider } from "../provider.js"
import { optional } from "../schema.js"

export const Settings = Schema.StructWithRest(Schema.Struct(Provider.Settings.schema.fields), [
  Schema.Record(Schema.String, Schema.UndefinedOr(Schema.Json)),
]).annotate({ identifier: "Config.Provider.Settings" })
export type Settings = typeof Settings.Type

export const ModelSettings = Schema.StructWithRest(Schema.Struct(Model.Settings.schema.fields), [
  Schema.Record(Schema.String, Schema.UndefinedOr(Schema.Json)),
]).annotate({ identifier: "Config.Model.Settings" })
export type ModelSettings = typeof ModelSettings.Type

const JsonRecord = Schema.Record(Schema.String, Schema.Json)

export const Overlays = {
  settings: Settings.pipe(optional),
  headers: Schema.Record(Schema.String, Schema.String).pipe(optional),
  body: JsonRecord.pipe(optional),
}

const ModelOverlays = {
  settings: ModelSettings.pipe(optional),
  headers: Schema.Record(Schema.String, Schema.String).pipe(optional),
  body: JsonRecord.pipe(optional),
}

export class Request extends Schema.Class<Request>("Config.Provider.Request")({
  headers: Overlays.headers,
  body: Overlays.body,
}) {}

class Cache extends Schema.Class<Cache>("Config.Model.Cost.Cache")({
  read: Money.USDPerMillionTokens.pipe(optional),
  write: Money.USDPerMillionTokens.pipe(optional),
}) {}

class Cost extends Schema.Class<Cost>("Config.Model.Cost")({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(optional),
  input: Money.USDPerMillionTokens,
  output: Money.USDPerMillionTokens,
  cache: Cache.pipe(optional),
}) {}

class Limit extends Schema.Class<Limit>("Config.Model.Limit")({
  context: Schema.Int.pipe(optional),
  input: Schema.Int.pipe(optional),
  output: Schema.Int.pipe(optional),
}) {}

// models.dev v2's `capabilities.reasoning`. OpenCode builds the model's variants from it; no control means none.
export const Reasoning = Schema.Union([
  Schema.Struct({ supported: Schema.Literal(false) }),
  Schema.Struct({
    supported: Schema.Literal(true),
    toggle: Schema.Boolean.pipe(optional),
    effort: Schema.String.pipe(Schema.Array, optional),
    budget: Schema.Struct({
      min: Schema.Int.pipe(optional),
      max: Schema.Int.pipe(optional),
    }).pipe(optional),
  }),
]).annotate({ identifier: "Config.Model.Reasoning" })
export type Reasoning = typeof Reasoning.Type

class ModelConfig extends Schema.Class<ModelConfig>("Config.Model")({
  modelID: ID.pipe(optional),
  type: Type.pipe(optional),
  family: Family.pipe(optional),
  name: Schema.String.pipe(optional),
  releaseDate: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}(-\d{2})?$/u))
    .annotate({ description: "Release date as YYYY-MM-DD or YYYY-MM" })
    .pipe(optional),
  compatibility: Compatibility.pipe(optional),
  package: Schema.String.pipe(optional),
  ...ModelOverlays,
  // Partial: unset fields fall back to the base model's capabilities, then the defaults.
  capabilities: Capabilities.mapFields((fields) => ({
    tools: optional(fields.tools),
    freeform: fields.freeform,
    input: optional(fields.input),
    output: optional(fields.output),
    temperature: fields.temperature,
    reasoning: Reasoning.pipe(optional),
  }))
    .annotate({ identifier: "Config.Model.Capabilities" })
    .pipe(optional),
  variants: Schema.Struct({
    id: VariantID,
    ...ModelOverlays,
    // The prompt cache belongs to the model, so a variant can't change it.
    settings: Schema.StructWithRest(
      Schema.Struct(Struct.omit(ModelSettings.schema.fields, ["cache"])),
      ModelSettings.records,
    )
      .annotate({ identifier: "Config.Model.VariantSettings" })
      .pipe(optional),
  }).pipe(Schema.Array, optional),
  cost: Schema.Union([Cost, Cost.pipe(Schema.Array)]).pipe(optional),
  disabled: Schema.Boolean.pipe(optional),
  /** Hide this model from the picker while keeping it routable (#230): unlike
   * `disabled`, a hidden model stays enabled for route pools and direct
   * resolution; it is only absent from the picker list. */
  hidden: Schema.Boolean.pipe(optional),
  defaultVariant: VariantID.annotate({
    description:
      "The variant (effort) a request runs at when it names none or asks for the default, e.g. high. A request that names a variant still runs at it unless lockVariant is set. Ignored when the model does not offer the variant.",
  }).pipe(optional),
  lockVariant: Schema.Boolean.annotate({
    description:
      "Run every request at defaultVariant, whatever variant it names, including inside model routes. Has no effect without defaultVariant.",
  }).pipe(optional),
  limit: Limit.pipe(optional),
}) {}

export const WallScope = Schema.Literals(["per-model", "provider", "account"])
export type WallScope = typeof WallScope.Type

export class Info extends Schema.Class<Info>("Config.Provider")({
  wallScope: WallScope.annotate({
    description: "Override gathered quota wall scope; when absent, infer scope from the reading.",
  }).pipe(optional),
  canonical: Provider.ID.pipe(optional),
  instanceOf: Provider.ID.annotate({
    description:
      "Make this provider a copy of another provider with its own sign-in, such as `openai.work` with `openai`, so both accounts can be used at the same time",
  }).pipe(optional),
  name: Schema.String.pipe(optional),
  env: Schema.String.pipe(Schema.Array, optional),
  package: Schema.String.pipe(optional),
  // Defaults for every model of this provider; model compatibility overrides individual fields.
  compatibility: ProviderCompatibility.pipe(optional),
  ...Overlays,
  models: Schema.Record(Schema.String, ModelConfig).pipe(optional),
}) {}
