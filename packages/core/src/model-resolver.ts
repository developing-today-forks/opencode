export * as ModelResolver from "./model-resolver.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { HttpOptions, LanguageModel, mergeHttpOptions, ProviderConfigurationError } from "@opencode/ai"
import { Auth } from "@opencode/ai/route"
import type { CacheFormat } from "@opencode/schema/model-compatibility"
import { Context, Effect, Layer, Option, Result, Schema, Struct } from "effect"
import { AISDK } from "./aisdk.js"
import { Credential } from "./credential.js"
import { Integration } from "./integration.js"
import { Capabilities, ID, Info, Model, Ref, VariantID } from "./model.js"
import type { RuntimeInfo } from "./model.js"
import { Npm } from "@opencode/util/npm"
import { Provider } from "./provider.js"
import { Config } from "./config.js"
import { ModelAlias } from "./model-alias.js"
import { Location } from "./location.js"
import { ModelRoute } from "./model-route.js"
import { ModelRouteAutonomy } from "./model-route-autonomy.js"
import { ModelRouteLog } from "./model-route-log.js"
import { ModelPlan } from "./model-plan.js"
import { QuotaCurrent } from "./quota-current.js"
import { ModelUsage } from "./model-usage.js"
import { QuotaSnapshot } from "./quota-snapshot.js"
import { Global } from "@opencode/util/global"
import { ownValue } from "./util/record.js"

export class VariantUnavailableError extends Schema.TaggedError<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: Provider.ID,
    modelID: ID,
    variant: VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedPackageError extends Schema.TaggedError<UnsupportedPackageError>()(
  "SessionRunnerModel.UnsupportedPackageError",
  {
    providerID: Provider.ID,
    modelID: ID,
    package: Schema.String,
  },
) {
  override get message() {
    return `Unsupported package for ${this.providerID}/${this.modelID}: ${this.package}`
  }
}

export const InitializationPhase = Schema.Literals(["load", "init", "construct"])
export type InitializationPhase = typeof InitializationPhase.Type

/** Provider settings are missing, conflicting, or unsupported; the provider's own message tells the user what to fix. */
export class ModelConfigurationError extends Schema.TaggedError<ModelConfigurationError>()(
  "SessionRunnerModel.ModelConfigurationError",
  {
    providerID: Provider.ID,
    modelID: ID,
    package: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `Cannot initialize ${this.providerID}/${this.modelID}: ${this.detail}`
  }
}

/** A supported package failed unexpectedly while loading or constructing the model. */
export class ModelInitializationError extends Schema.TaggedError<ModelInitializationError>()(
  "SessionRunnerModel.ModelInitializationError",
  {
    providerID: Provider.ID,
    modelID: ID,
    package: Schema.String,
    phase: InitializationPhase,
    detail: Schema.String,
  },
) {
  override get message() {
    return `Cannot initialize ${this.providerID}/${this.modelID}: ${this.detail}`
  }
}

export class UnresolvedProviderVariablesError extends Schema.TaggedError<UnresolvedProviderVariablesError>()(
  "SessionRunnerModel.UnresolvedProviderVariablesError",
  {
    providerID: Provider.ID,
    modelID: ID,
    variables: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `Cannot initialize ${this.providerID}/${this.modelID}: ${this.variables.join(", ")} ${this.variables.length === 1 ? "is" : "are"} required to resolve the provider endpoint`
  }
}

export class UnsupportedCompactionError extends Schema.TaggedError<UnsupportedCompactionError>()(
  "SessionRunnerModel.UnsupportedCompactionError",
  {
    providerID: Provider.ID,
    modelID: ID,
    route: Schema.String,
  },
) {
  override get message() {
    return `Provider compaction is not supported by ${this.providerID}/${this.modelID} (${this.route})`
  }
}

export class RouteUnavailableError extends Schema.TaggedError<RouteUnavailableError>()(
  "SessionRunnerModel.RouteUnavailableError",
  { routeID: ID, providerID: Schema.optional(Provider.ID) },
) {
  override get message() {
    return `No model is available for route ${this.providerID ?? ModelRoute.PROVIDER_ID}/${this.routeID}`
  }
}

export type Error =
  | VariantUnavailableError
  | UnsupportedPackageError
  | ModelConfigurationError
  | ModelInitializationError
  | UnresolvedProviderVariablesError
  | UnsupportedCompactionError
  | RouteUnavailableError
  | Integration.AuthorizationError

export interface Resolved {
  /** Route-level model for provider requests; its id is the provider API model id, which may differ from the catalog id. */
  readonly model: LanguageModel
  /** Selected catalog identity. Durable records and displays must use this, never the API model id. */
  readonly ref: Ref
  /** Catalog capabilities used to shape requests before provider lowering. */
  readonly capabilities: Capabilities
  /** Catalog pricing in dollars per million tokens. */
  readonly cost: Info["cost"]
  /** Catalog token limits used by Core for context management. */
  readonly limit: Info["limit"]
  /** Model policy overrides the provider policy; omitted means summary compaction. */
  readonly compaction?: Provider.Compaction
  /** Provider transport policy; omitted means HTTP. */
  readonly transport?: Provider.Transport
  /** Milliseconds without streamed data before a WebSocket exchange fails; `false` disables the limit. */
  readonly chunkTimeout?: number | false
  /** The stored credential that served this resolution, captured by load() from the connection it
   * built the request from (#6): present on direct resolutions as well as routed ones, so attempt
   * records attribute usage to the credential that actually served (#1106). Absent when an env
   * connection served. For routed resolutions it matches `routing.credentialID`. */
  readonly servingCredentialID?: Credential.ID
  /** The membership account this resolution draws from (#2253), present only when the
   * provider declares membership caps on its definition: the provider id and its
   * canonical provider when it declares one. Every consumer that starts a request
   * against this resolution — the session runner, the generation façade — meters
   * the start against the one shared account accumulator before dispatching. */
  readonly membership?: { readonly providerID: string; readonly canonical?: string }
  /** The integration method that minted the serving credential (#1119), captured from the same
   * active connection as `servingCredentialID`. Error classification uses it to gate
   * method-specific diagnoses on the method that actually served, instead of guessing
   * the method from an error body. Absent when an env connection served or the
   * credential carries no method (key credentials). */
  readonly servingMethodID?: Integration.MethodID
  /** Selection and health data for a configured OpenCode model route. */
  readonly routing?: {
    readonly routeID: ID
    readonly target: Ref
    /** The addressed route's carried system prompt (#1413), when it declares one. */
    readonly system?: string
    readonly policy: ModelRoute.Policy
    /** Requests per target before failing over. */
    readonly attempts: number
    /** Start the next target if this one is silent after this long. */
    readonly hedgeAfterMs?: number
    /** The route's autonomy level: a route races its next target once a target keeps giving up only at `adaptive` and up. */
    readonly autonomy?: ModelRouteAutonomy.Level
    /** The active stored credential for the target's integration, when there is one (#6). */
    readonly credentialID?: Credential.ID
    /** The half-open bench probe this resolution claimed at pick time (#1123), when it claimed
     * one (#1478): the claim is spent before any request runs, so a consumer that resolves a
     * model it never attempts must hand the claim back with
     * `ModelRoute.releaseBenchProbe(target, credentialID, claimedAt, token)` — the credential named
     * here is the one the claim was spent on, which may differ from the serving credential
     * above. A consumer that does attempt the model settles the claim through
     * `ModelRoute.completed` / `ModelRoute.failed` like the session runner does. The token
     * names the pick's spend (#1486): every scope the pick claimed shares it. */
    readonly probeClaim?: {
      readonly claimedAt: number
      readonly token: number
      readonly credentialID?: Credential.ID
    }
    /**
     * Activates the next eligible stored credential on the target's own integration and
     * re-resolves the same target on it (#6 credential failover). Eligibility is the Phase A
     * gate: not credential-cooling, not quota-known-full, not credential-demoted. The
     * credential that served this resolution is the one excluded, even if another session
     * has since activated a different credential. Returns undefined when no other stored
     * credential is eligible.
     */
    readonly credentialFallback?: () => Effect.Effect<Resolved | undefined, Error>
    readonly fallback: () => Effect.Effect<Resolved | undefined, Error>
    /** Set just after a session failed over: the target it came from, which a hedge races instead of
     * the next fallback while the session is still new on the alternate. */
    readonly origin?: () => Effect.Effect<Resolved | undefined, Error>
  }
}

export interface Interface {
  /** `requestTokens` has the same meaning as on `resolveModel`: it also sizes the
   * default selection, so a session with no explicit model still filters route
   * targets by their per-target ceilings (#891). */
  readonly resolve: (requested?: Ref, requestTokens?: number) => Effect.Effect<Resolved | undefined, Error>
  /** `sessionID` enables per-session target stickiness for routes with a non-ordered selection mode.
   * `requestTokens` is the request's context size in tokens, when known: a route target whose ceiling
   * the request does not fit is skipped like any other ineligible target. */
  readonly resolveModel: (
    model: Info,
    variant?: VariantID,
    sessionID?: string,
    requestTokens?: number,
  ) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelResolver") {}

// Variant resolution adds request-local overlays without changing the committed model snapshot.
export const withVariant = (
  model: Info,
  variantID: VariantID | undefined,
): Effect.Effect<Info, VariantUnavailableError> => {
  const id = variantID === "default" ? undefined : variantID
  const variant = model.variants?.find((item) => item.id === id)
  if (!variant && id !== undefined)
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: id,
      }),
    )
  return Effect.succeed(
    variant
      ? {
          ...model,
          settings: Provider.mergeOverlay(model.settings, Provider.modelSettings(variant.settings)),
          headers: Provider.mergeHeaders(model.headers, variant.headers),
          body: Provider.mergeOverlay(model.body, variant.body),
        }
      : model,
  )
}

export interface Dependencies {
  readonly loadPackage?: (specifier: string) => Effect.Effect<Provider.ProviderPackage, Provider.LoadError>
  readonly loadAISDK?: (model: RuntimeInfo) => Effect.Effect<LanguageModel, AISDK.InitError>
}

export const fromCatalogModel = (
  model: RuntimeInfo,
  credential?: Credential.Value,
  dependencies?: Dependencies,
): Effect.Effect<
  LanguageModel,
  | UnsupportedPackageError
  | ModelConfigurationError
  | ModelInitializationError
  | UnresolvedProviderVariablesError
  | UnsupportedCompactionError
> =>
  resolveCatalogModel(model, credential, dependencies).pipe(
    Effect.flatMap((resolved) => validateProviderVariables(model, resolved)),
    Effect.flatMap((resolved) => {
      // Reject provider compaction policies up front so the misconfiguration surfaces before any step runs.
      if (
        model.settings?.compaction?.type !== "native" ||
        resolved.route.compact?.trigger ||
        resolved.route.compact?.endpoint
      )
        return Effect.succeed(resolved)
      return Effect.fail(
        new UnsupportedCompactionError({ providerID: model.providerID, modelID: model.id, route: resolved.route.id }),
      )
    }),
  )

const resolveCatalogModel = Effect.fn("ModelResolver.resolveCatalogModel")(function* (
  model: RuntimeInfo,
  credential?: Credential.Value,
  dependencies?: Dependencies,
) {
  const resolved = prepareRuntimeModel(model)
  const configuration = credential?.type === "key" ? credential.configuration : undefined
  const configured = { ...resolved.settings, ...credential?.metadata, ...configuration }
  if (Provider.isAISDK(resolved.package)) {
    const loadAISDK = dependencies?.loadAISDK
    if (!loadAISDK) return yield* unsupported(resolved)
    const settings = yield* prepareProviderSettings(
      resolved,
      Provider.mergeOverlay(resolved.settings, {
        ...nativeCredentialSettings(resolved, resolved.package ?? "", credential),
        ...credential?.metadata,
        ...configuration,
      }) ?? {},
    )
    return yield* loadAISDK({ ...resolved, settings }).pipe(
      Effect.mapError((error) => initialization(resolved, "init", error.cause)),
    )
  }
  const specifier = Provider.packageName(resolved.package)
  if (!specifier) return yield* unsupported(resolved)
  const mapped = yield* prepareProviderSettings(resolved, Provider.nativeSettings(configured))
  const module = yield* (dependencies?.loadPackage ?? Provider.loadPackage)(specifier).pipe(
    Effect.mapError((error) => initialization(resolved, "load", error.cause)),
  )
  const settings = {
    ...(credential ? Struct.omit(mapped, ["accessToken", "apiKey", "authToken"]) : mapped),
    ...(resolved.canonical === undefined ? {} : { provider: resolved.canonical }),
    ...nativeCredentialSettings(resolved, specifier, credential),
    headers: resolved.headers,
    body: resolved.body,
  }
  return yield* Effect.try({
    try: () => {
      const runtime = module.model(resolved.modelID ?? resolved.id, settings)
      return LanguageModel.update(runtime, {
        provider: resolved.canonical ?? resolved.providerID,
        compatibility: resolved.compatibility
          ? Object.assign({}, runtime.compatibility, resolved.compatibility)
          : runtime.compatibility,
        // Timeouts and body encoding are transport policy, so they land on the route's HTTP defaults instead of package settings.
        defaults: {
          ...runtime.defaults,
          http: mergeHttpOptions(
            runtime.defaults?.http,
            new HttpOptions({ ...Provider.timeouts(configured), encoding: Provider.encoding(configured) }),
          ),
        },
      })
    },
    catch: (cause) =>
      cause instanceof ProviderConfigurationError
        ? new ModelConfigurationError({
            providerID: resolved.providerID,
            modelID: resolved.id,
            package: resolved.package ?? "unknown",
            detail: cause.message,
          })
        : initialization(resolved, "construct", cause),
  })
})

function prepareRuntimeModel(model: RuntimeInfo) {
  if (model.settings?.apiKey !== "") return model
  return { ...model, settings: Struct.omit(model.settings, ["apiKey"]) }
}

function validateProviderVariables(
  model: RuntimeInfo,
  resolved: LanguageModel,
): Effect.Effect<LanguageModel, UnresolvedProviderVariablesError> {
  const baseURL = resolved.route.endpoint.baseURL
  if (typeof baseURL !== "string") return Effect.succeed(resolved)
  const failure = unresolvedProviderVariables(model, baseURL)
  return failure ? Effect.fail(failure) : Effect.succeed(resolved)
}

function prepareProviderSettings(
  model: RuntimeInfo,
  settings: Readonly<Record<string, unknown>>,
): Effect.Effect<Readonly<Record<string, unknown>>, UnresolvedProviderVariablesError> {
  const baseURL = settings.baseURL
  if (typeof baseURL !== "string") return Effect.succeed(settings)
  return prepareProviderURL(model, baseURL).pipe(
    Effect.map((prepared) => (prepared === baseURL ? settings : { ...settings, baseURL: prepared })),
  )
}

function prepareProviderURL(
  model: RuntimeInfo,
  baseURL: string,
): Effect.Effect<string, UnresolvedProviderVariablesError> {
  if (!baseURL.includes("${")) return Effect.succeed(baseURL)
  const prepared = baseURL.replace(/\$\{([^}]+)\}/g, (placeholder, name: string) => ownValue(process.env, name) ?? placeholder)
  const failure = unresolvedProviderVariables(model, prepared)
  return failure ? Effect.fail(failure) : Effect.succeed(prepared)
}

function unresolvedProviderVariables(model: RuntimeInfo, baseURL: string) {
  const variables = new Set(Array.from(baseURL.matchAll(/\$\{([^}]+)\}/g), (match) => match[1]))
  if (variables.size === 0) return
  return new UnresolvedProviderVariablesError({
    providerID: model.providerID,
    modelID: model.id,
    variables: Array.from(variables),
  })
}

const nativeCredentialSettings = (model: RuntimeInfo, specifier: string, credential: Credential.Value | undefined) => {
  if (!credential) return {}
  if (credential.type === "key") return { apiKey: credential.key }
  if (credential.type === "oauth") return tokenSettings(specifier, credential.access)
  // The saved profile reaches the package through metadata; SigV4 keeps an ambient bearer token from taking over.
  if (specifier.startsWith("@opencode/ai/providers/amazon-bedrock")) return { auth: "sigv4" }
  // The Azure plugin's request hooks replace this with an Entra ID token from the Azure CLI; it only gets the
  // request past the package's own credential check.
  if (model.providerID === Provider.ID.azure) return tokenSettings(specifier, "azure-cli")
  return {}
}

const tokenSettings = (specifier: string, token: string) => {
  if (specifier === "@opencode/ai/providers/anthropic" || specifier === "@opencode/ai/providers/anthropic-compatible")
    return { authToken: token }
  if (
    specifier === "@opencode/ai/providers/google-vertex" ||
    specifier.startsWith("@opencode/ai/providers/google-vertex/")
  )
    return { accessToken: token }
  return { apiKey: token }
}

const unsupported = (model: RuntimeInfo) =>
  new UnsupportedPackageError({
    providerID: model.providerID,
    modelID: model.id,
    package: model.package ?? "unknown",
  })

const initialization = (model: RuntimeInfo, phase: InitializationPhase, cause: unknown) =>
  new ModelInitializationError({
    providerID: model.providerID,
    modelID: model.id,
    package: model.package ?? "unknown",
    phase,
    detail: causeMessage(cause) ?? `${phase} failed for ${model.package ?? "unknown"}`,
  })

// Unexpected throws still carry the most useful diagnosis in their message; a stack or an unknown value does not.
const causeMessage = (cause: unknown): string | undefined => {
  if (typeof cause === "string") return cause.trim() || undefined
  if (!(cause instanceof globalThis.Error)) return undefined
  const message = cause.message.trim()
  if (message) return message
  return causeMessage(cause.cause)
}

export const resolveModel = (
  model: Info,
  variant: VariantID | undefined,
  credential?: Credential.Value,
  dependencies?: Dependencies,
) => withVariant(model, variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential, dependencies)))

export const hasPackage = (model: Info) => Boolean(model.package) || ModelRoute.definition(model) !== undefined

const refreshQuotaGate = (
  targets: readonly Model.Ref[],
  credentialByProvider: Map<string, Credential.ID>,
  dataDir: string | undefined,
  now: number,
  location?: string,
) =>
  Effect.gen(function* () {
    const targetProviders = new Set<string>(
      targets
        .map((target) => target.providerID)
        .filter((providerID) => ModelRoute.shouldFeedQuota(now, location, providerID)),
    )
    if (targetProviders.size === 0) return
    const dueTargets = targets.filter((target) => targetProviders.has(target.providerID))
    let plans: readonly ModelPlan.Plan[] = []
    try {
      plans = ModelPlan.readStore(dataDir).plans
    } catch {
      return
    }
    // Only plans that still feed the gate (#1340): ended plans are store history, not capacity.
    const relevantPlans = plans.filter((plan) => targetProviders.has(plan.providerID) && ModelPlan.feedsGate(plan))
    // Ended plans derive no replacement snapshot, so reconcile the retained gate state
    // against the plans that still feed it before any early return below (#1340).
    for (const providerID of targetProviders)
      ModelRoute.reconcileQuotaGate(
        providerID,
        new Set(relevantPlans.filter((plan) => plan.providerID === providerID).map((plan) => plan.id)),
      )
    if (relevantPlans.length === 0) return

    const windows = relevantPlans.flatMap((plan) =>
      plan.quotas
        .filter((window) => window.windowHours !== undefined || (plan.coverage === "credits" && window.unit === "usd"))
        .map((window) => ({ plan, window })),
    )
    if (windows.length === 0) return

    yield* ModelRouteLog.withDb((db) =>
      Effect.gen(function* () {
        const rowsByWindow = new Map<string, readonly (ModelUsage.TargetRow & { credentialID: string | null })[]>()
        for (const { plan, window } of windows) {
          const key = `${plan.id}:${window.name}`
          if (rowsByWindow.has(key)) continue
          rowsByWindow.set(key, yield* ModelRouteLog.targetUsage(db, QuotaSnapshot.usageSince(plan, window, now)))
        }
        for (const target of dueTargets) {
          const activeCredentialID = credentialByProvider.get(target.providerID)
          // Held credentials keep being fed after failover activates a sibling: their fresh
          // balance observations are the only way a balance hold on an inactive credential
          // can ever reach its release check.
          const heldCredentialIDs = ModelRoute.heldCredentialIDs(target.providerID)
            .map((id) => Credential.ID.make(id))
            .filter((id) => id !== activeCredentialID)
          const feed = (credentialID: Credential.ID | undefined) => {
            // Snapshots stay plan/provider-scoped, but the totals they are derived from are scoped
            // to what they will gate (#1106): a credential's snapshot sums only that credential's
            // rows, so one credential's usage can never mark another known-full. Unattributed rows
            // (credentialID null: env-served, or recorded before the column existed) never feed a
            // credential's totals; they feed only the provider scope, whose totals keep the
            // provider-wide sum this gate always used.
            const snapshots = QuotaSnapshot.deriveAll(
              relevantPlans.filter((plan) => plan.providerID === target.providerID),
              (plan, window) =>
                ModelUsage.sum(
                  (rowsByWindow.get(`${plan.id}:${window.name}`) ?? []).filter(
                    (row) =>
                      row.providerID === plan.providerID &&
                      (credentialID === undefined || row.credentialID === credentialID),
                  ),
                ),
              now,
              { now, balanceDeadThreshold: ModelRoute.currentConstants(location).quotaGate.balanceDeadThreshold },
            )
            if (snapshots.length === 0) return
            const snapshot = QuotaSnapshot.gatingSnapshot(
              snapshots,
              now,
              ModelRoute.currentConstants(location).quotaGate.balanceDeadThreshold,
            )
            if (!snapshot) return
            if (credentialID) {
              ModelRoute.observeCredentialQuota(target, credentialID, snapshot, now, location)
            } else {
              ModelRoute.observeProviderQuota(target, snapshot, now, location)
            }
          }
          feed(activeCredentialID)
          for (const held of heldCredentialIDs) feed(held)
        }
      }),
    ).pipe(Effect.orDie)
  })

/** The attempt-reported half of the quota gate's re-judgement (#1974): a reactive
 * quota skip is a judgement from one attempt's error, and the fleet's measured quota
 * snapshot — the gatherer's `quota-current.json` (code#1151), rewritten every ~15
 * minutes from the providers' own endpoints — outranks it. On the same feed cadence
 * as the plan-derived gate above — but on this pass's OWN feed stamps (code#8086: a stamp shared
 * with the gate is consumed by the gate's earlier run in the same resolution, which
 * starved this pass in production), each due target's skips are re-judged against the
 * freshest gathered reading for its model: headroom lifts the skip, a full reading
 * leaves it standing, and a provider the snapshot does not carry is left alone.
 * Nothing here spends an attempt to learn the answer; the reading is the evidence.
 *
 * The plant half rides the same pass (code#8086): the re-judgement above only
 * ever LIFTS holds, so a leg whose window the gatherer already reads at 100%
 * kept absorbing attempts until one of its own failures happened to plant a
 * reactive skip — the plant now comes from the reading itself, before any
 * attempt: `plantGatheredQuotaWall` holds the target out while the freshest
 * reading shows its window full, and lifts the plant on the first later
 * reading that shows room. A stale or missing snapshot plants nothing, and
 * selection falls back to attempt + bench exactly as before. */
const refreshQuotaSkips = (targets: readonly Model.Ref[], now: number, location?: string) =>
  Effect.sync(() => {
    const due = targets.filter((target) => ModelRoute.shouldFeedGatheredQuota(now, location, target.providerID))
    if (due.length === 0) return
    const readings = QuotaCurrent.readSnapshot(Global.Path.state)
    if (readings.length === 0) return
    for (const target of due) {
      ModelRoute.releaseQuotaSkipsForCurrent(target, readings, now, location)
      ModelRoute.plantGatheredQuotaWall(target, readings, now, location)
    }
  })

/** Resolves catalog selections into runtime models for the current Location. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    const models = yield* Model.Service
    const integrations = yield* Integration.Service
    const npm = yield* Npm.Service
    const aisdk = yield* AISDK.Service
    const location = yield* Effect.serviceOption(Location.Service)
    const locationDirectory = Option.match(location, {
      onNone: () => undefined,
      onSome: (value) => value.directory as string,
    })
    const config = yield* Effect.serviceOption(Config.Service)
    const global = yield* Effect.serviceOption(Global.Service)
    const dataDir = Option.match(global, { onNone: () => undefined, onSome: (g) => g.data })
    const load = Effect.fn("ModelResolver.resolveModel")(function* (
      selected: Info,
      variant?: VariantID,
      cacheFormat?: CacheFormat,
    ) {
      const provider = yield* providers.get(selected.providerID)
      const integrationID = provider?.integrationID ?? Integration.ID.make(selected.providerID)
      const connection = yield* integrations.connection.active(integrationID)
      const credential = connection ? yield* integrations.connection.resolve(connection) : undefined
      const selectedVariant = yield* withVariant(selected, variant)
      const runtimeInfo: RuntimeInfo = {
        ...selectedVariant,
        // A route target's declared cache format overrides the model's own compatibility for this
        // resolution only; the catalog model stays as configured.
        ...(cacheFormat === undefined ? {} : { compatibility: { ...selectedVariant.compatibility, cacheFormat } }),
        settings: Provider.mergeOverlay(provider?.settings, Provider.modelSettings(selectedVariant.settings)),
      }
      const model = yield* fromCatalogModel(runtimeInfo, credential, {
        loadPackage: (specifier) => Provider.loadPackage(specifier, npm),
        loadAISDK: (model) => aisdk.model(model),
      })
      const runtime =
        provider?.activation === "enabled" &&
        credential === undefined &&
        !hasConfiguredAuth(runtimeInfo) &&
        usesAPIKeyAuth(runtimeInfo.package)
          ? LanguageModel.update(model, { route: model.route.with({ auth: Auth.none }) })
          : model
      return {
        resolved: {
          model: runtime,
          ref: Ref.make({
            id: selected.id,
            providerID: selected.providerID,
            ...(variant === undefined ? {} : { variant }),
          }),
          capabilities: selected.capabilities,
          cost: selected.cost,
          limit: selected.limit,
          compaction: runtimeInfo.settings?.compaction,
          transport: provider?.settings?.transport,
          chunkTimeout: Provider.timeout(provider?.settings?.chunkTimeout),
          // Membership caps declared on the provider definition (#2253): a direct
          // resolution meters against the same shared account as a routed one.
          ...(provider &&
          ModelRoute.membershipLimits(
            selected.providerID,
            provider.canonical === undefined ? undefined : String(provider.canonical),
            locationDirectory,
          )
            ? {
                membership: {
                  providerID: selected.providerID,
                  ...(provider.canonical === undefined ? {} : { canonical: String(provider.canonical) }),
                },
              }
            : {}),
          ...(connection?.type === "credential" ? { servingCredentialID: connection.id } : {}),
          ...(connection?.type === "credential" && connection.methodID !== undefined
            ? { servingMethodID: connection.methodID }
            : {}),
        } satisfies Resolved,
        // #6: the credential that actually served this load, captured from the same active
        // connection the request was built from. Callers must use this — never a snapshot of
        // the active credential taken earlier — for serving attribution and failover
        // exclusion: a concurrent session may have activated a different credential in
        // between, and benching or excluding the wrong one is the failure this prevents.
        servingCredentialID: connection?.type === "credential" ? connection.id : undefined,
      }
    })
    // Cross-route cascade (#1014, PR2): when a route exhausts, the session re-enters
    // through a parent route that nests it instead of dying on the sub-route. Tried
    // targets are tracked by provider/model ref across definitions — per-definition
    // index sets cannot seed a parent's tried set — and visited routes keep the
    // upward walk from re-entering a route the chain already exhausted. `chain`
    // holds every route the cascade has stood on, nearest last, so a parent that
    // itself exhausts continues to its own parents and then to the remaining
    // parents of the routes below it, in proximity order.
    interface CascadeState {
      readonly triedRefs: Set<string>
      readonly visitedRoutes: Set<string>
      readonly chain: Array<{
        readonly definition: ModelRoute.Definition
        readonly tried: ReadonlySet<number>
      }>
      // Typed load failures recorded at cascade boundaries, in attempt order.
      // When no route in the cascade resolves, the first one surfaces instead
      // of a bare RouteUnavailableError, so configuration and authorization
      // failures keep their identity for session error classification.
      readonly loadErrors: Array<Error>
    }
    const cascadeRefKey = (target: ModelRoute.Target) => `${target.providerID}/${target.id}`
    const resolveRouteWithin = (
      selected: Info,
      definition: ModelRoute.Definition,
      requestedVariant: VariantID | undefined,
      triedTargets: Set<number>,
      allowCooling: boolean,
      sessionID: string | undefined,
      requestTokens: number | undefined,
      cascade: CascadeState,
      // Whether the last-resort set may seat a quota-dead target when nothing
      // undead remains. Initial resolution allows it (code#8086); the fallback
      // cascade's last-resort pass does not — a quota-dead target stays
      // unseated there so a walled route still stops cleanly (#1806, #7073).
      allowQuotaDeadLastResort = true,
    ): Effect.Effect<Resolved | undefined, Error> =>
      Effect.gen(function* () {
        const now = Date.now()
        let lastError: Error | undefined
        // The active stored credential per target provider (#6): the ready filter gates on the
        // credential that would actually serve the target, not only on the target itself.
        // This snapshot is gate input only — serving attribution comes from load() itself,
        // because the active credential can change between this read and the load.
        const credentialByProvider = new Map<string, Credential.ID>()
        // Each target provider's canonical provider (#2253): membership caps are
        // declared on the canonical account and shared by its aliases, so the
        // ready filter and the Resolved both name it.
        const canonicalByProvider = new Map<string, string>()
        // Every stored credential per target provider, active first (#1806): the ready
        // filter below gates a leaf on its *effective* credential — the first stored
        // credential that could actually serve it — not on the active one alone. The
        // active-only snapshot judged a multi-credential leaf by a credential that
        // would never serve it, stranding leaves whose active credential was
        // credential-cooling or quota-blocked while a sibling credential was healthy.
        const credentialsByProvider = new Map<string, Array<Credential.ID>>()
        for (const target of definition.targets) {
          if (credentialByProvider.has(target.providerID)) continue
          const provider = yield* providers.get(target.providerID)
          if (provider?.canonical !== undefined)
            canonicalByProvider.set(target.providerID, String(provider.canonical))
          const integrationID = provider?.integrationID ?? Integration.ID.make(target.providerID)
          const connection = yield* integrations.connection.active(integrationID)
          if (connection?.type === "credential") {
            credentialByProvider.set(target.providerID, connection.id)
            const info = yield* Effect.suspend(() => integrations.get(integrationID)).pipe(
              Effect.catchCause(() => Effect.succeed(undefined)),
            )
            const stored = (info?.connections ?? []).flatMap((item) =>
              item.type === "credential" && item.id !== connection.id ? [item.id] : [],
            )
            credentialsByProvider.set(target.providerID, [connection.id, ...stored])
          }
        }
        yield* refreshQuotaGate(definition.targets, credentialByProvider, dataDir, now, locationDirectory)
        yield* refreshQuotaSkips(definition.targets, now, locationDirectory)
        // The credential a target's eligibility is judged by at `at`: the active one
        // when it can serve, else the first stored sibling that can (not credential-
        // cooling beyond a due probe, not quota-blocked). `activate` is set only in
        // that sibling case — the pick then activates it before load, the same switch
        // credentialFallback performs after a served failure (#6). When every stored
        // credential is blocked, the active one is returned, so the exclusion reasons
        // and the last-resort known-full handling below behave exactly as before.
        const effectiveCredential = (
          target: ModelRoute.Target,
          at: number,
        ): { readonly id: Credential.ID; readonly activate: boolean } | undefined => {
          const candidates = credentialsByProvider.get(target.providerID)
          if (!candidates || candidates.length === 0) return undefined
          for (const id of candidates) {
            const cooling =
              ModelRoute.credentialCooldownUntil(target, id, at) > at && !ModelRoute.probeDue(target, id, at)
            if (cooling) continue
            if (ModelRoute.credentialQuotaBlocked(id, at, locationDirectory) !== undefined) continue
            return { id, activate: id !== candidates[0] }
          }
          return { id: candidates[0], activate: false }
        }
        const makeResolved = (
          current: Resolved,
          origin: (() => Effect.Effect<Resolved | undefined, Error>) | undefined,
          credentialFallback: (() => Effect.Effect<Resolved | undefined, Error>) | undefined,
          // The credential load() actually served this resolution with (#6), authoritative
          // even when undefined (an env connection served): the credentialByProvider
          // snapshot is only the ready filter's gate input, never serving attribution.
          servingCredentialID: Credential.ID | undefined,
          // The bench probe claim the pick spent (#1478), when it spent one: only the
          // resolution that walked away with the pick carries it — credential-fallback
          // re-resolutions of the same target spend no new claim and pass none.
          probeClaim?: { readonly claimedAt: number; readonly token: number; readonly credentialID?: Credential.ID },
        ): Resolved => {
          const branch = {
            tried: new Set(triedTargets),
            triedRefs: new Set(cascade.triedRefs),
            visitedRoutes: new Set(cascade.visitedRoutes),
            chain: [...cascade.chain],
            loadErrors: [...cascade.loadErrors],
          }
          return {
          ...current,
          // The membership caps the picked target's provider declares (#2253),
          // resolved at pick time so the runner's gate needs nothing else. An
          // uncapped provider carries none.
          ...(ModelRoute.membershipLimits(current.ref.providerID, canonicalByProvider.get(current.ref.providerID), locationDirectory)
            ? {
                membership: {
                  providerID: current.ref.providerID,
                  ...(canonicalByProvider.get(current.ref.providerID)
                    ? { canonical: canonicalByProvider.get(current.ref.providerID) }
                    : {}),
                },
              }
            : {}),
          // The alias advertises the safest shared request shape. Pricing and provider metadata stay
          // tied to the concrete target that answered.
          capabilities: selected.capabilities,
          limit: selected.limit,
          // A native provider checkpoint is not portable across the route's targets.
          compaction: undefined,
          routing: {
            routeID: definition.id,
            target: current.ref,
            ...(definition.system ? { system: definition.system } : {}),
            policy: definition.health,
            // Two requests by default: a single transient failure on a steady target is retried before the
            // route moves on. Rate limits skip the retry (see the runner). Set 1 to fail over at once.
            attempts: definition.attempts ?? 2,
            ...(definition.hedgeAfterMs ? { hedgeAfterMs: definition.hedgeAfterMs } : {}),
            autonomy: definition.autonomy,
            ...(servingCredentialID ? { credentialID: servingCredentialID } : {}),
            ...(probeClaim ? { probeClaim } : {}),
            fallback: () => {
              // Branch-local cascade state (#1014 Codex P2): a fallback call is a
              // speculative branch as often as it is the primary's next step — a
              // hedge explores it before the primary settles. Each call starts
              // from the state as of this resolution, so a hedge exploration
              // cannot consume the parent route (visited marks, tried refs) the
              // primary's own fallback still needs; progression continues
              // through the Resolved each call returns and its own fallback.
              const branchTried = new Set(branch.tried)
              const branchState: CascadeState = {
                triedRefs: new Set(branch.triedRefs),
                visitedRoutes: new Set(branch.visitedRoutes),
                chain: [...branch.chain],
                loadErrors: [...branch.loadErrors],
              }
              return resolveRouteWithin(
                selected,
                definition,
                requestedVariant,
                branchTried,
                false,
                sessionID,
                requestTokens,
                branchState,
              ).pipe(
                // An exhausted-with-load-failures route is a cascade boundary,
                // not a fatal error (#1014 Codex P2): record the typed failure
                // and let the parents try; it re-surfaces below if nothing in
                // the cascade resolves. Defects still propagate (Effect.catch
                // only handles typed failures).
                Effect.catch((error) => {
                  branchState.loadErrors.push(error)
                  return Effect.succeed(undefined)
                }),
                Effect.flatMap((next) =>
                  next
                    ? Effect.succeed(next)
                    : cascadeToParent(definition, branchTried, requestedVariant, sessionID, requestTokens, branchState),
                ),
                // Last resort, last (#7073): when no ready candidate remains
                // anywhere in the cascade — every untried target cooling or
                // quota-walled — seat the least-bad remaining target of this
                // route instead of refusing, exactly as initial resolution
                // does (allowCooling). Case (b) died here: the 404's fallback
                // found popesdrew credential-cooling and the luna credential
                // ~57s from recovery, and the turn ended even though the
                // cascade still had candidates. The pass runs only after the
                // parents' ready candidates, so a healthy parent seat always
                // wins over a cooling in-route one; the tried set keeps
                // progression terminating through the usable set. The pass
                // seats only targets that are not quota-dead in any scope:
                // cooling targets (a credential bench minutes or hours
                // deep, like the incident's) are seatable, quota-dead ones
                // stay unseated so a quota-walled route still stops
                // cleanly (#1806).
                Effect.flatMap((resolved) =>
                  resolved
                    ? Effect.succeed(resolved)
                    : resolveRouteWithin(
                        selected,
                        definition,
                        requestedVariant,
                        new Set(branchTried),
                        true,
                        sessionID,
                        requestTokens,
                        branchState,
                        false,
                      ).pipe(
                        Effect.catch((error) => {
                          branchState.loadErrors.push(error)
                          return Effect.succeed(undefined)
                        }),
                      ),
                ),
                Effect.flatMap((resolved) =>
                  resolved
                    ? Effect.succeed(resolved)
                    : branchState.loadErrors.length > 0
                      ? Effect.fail(branchState.loadErrors[0])
                      : Effect.succeed(undefined),
                ),
              )
            },
            ...(origin ? { origin } : {}),
            ...(credentialFallback ? { credentialFallback } : {}),
          },
          }
        }
        while (triedTargets.size < definition.targets.length) {
          const indexes = definition.targets.flatMap((_, index) => (triedTargets.has(index) ? [] : [index]))
          const unavailable = new Map<number, string>()
          const overLimit = new Set<number>()
          const ready = indexes.filter((index) => {
            const target = definition.targets[index]
            const until = ModelRoute.cooldownUntil(target, now, locationDirectory)
            // A fixed route only fails over: provider holds, skips and budgets are rules and above.
            const rules = ModelRouteAutonomy.usesRules(definition.autonomy)
            const scope = ModelRoute.scopeOf(definition, [], locationDirectory)
            // A user's "avoid" holds on every route; learned skips and budgets are rules the route opted into.
            // The two are reported distinctly (#1976): "user-skip" is only the operator's own
            // override; a learned reactive quota skip is "quota-skip" — the shared label sent
            // one diagnosis hunting for an operator record that never existed.
            const isUserSkipped = ModelRoute.userSkipped(target, now, scope)
            const isSkipped = isUserSkipped || (rules && ModelRoute.skipped(target, now, scope))
            const isOverBudget = rules && ModelRoute.overBudget(target, definition.budgets?.[index], now, scope)
            // A target whose ceiling the request does not fit is skipped at every level, like a
            // cooldown or a provider hold rather than a soft budget: the request cannot be served
            // there. It is checked last so a target excluded for any existing reason keeps that
            // reason, and only a limit-only exclusion is attributed to the limit.
            const isOverLimit = ModelRoute.overLimit(definition, index, requestTokens)
            if (isOverLimit) overLimit.add(index)
            const credentialID = effectiveCredential(target, now)?.id
            const limited = rules ? ModelRoute.limitedUntil(target, now, credentialID) : 0
            // An upstream tier-limit answer holds the provider's whole membership
            // account out (#2253 backstop): every target of the account is excluded
            // until the stated reset, whatever its own per-target holds say.
            const membershipHeld = ModelRoute.membershipHeldUntil(
              target.providerID,
              canonicalByProvider.get(target.providerID),
              now,
            )
            // A burst hold steers new sessions away but leaves a session on the target it is already using.
            const kept =
              limited > now && ModelRoute.keepsThrough(definition.id, sessionID, target, now, credentialID, locationDirectory)
            const credentialUntil = credentialID ? ModelRoute.credentialCooldownUntil(target, credentialID, now) : 0
            const quotaBlock = credentialID ? ModelRoute.credentialQuotaBlocked(credentialID, now, locationDirectory) : undefined
            const providerBlock = ModelRoute.providerQuotaBlocked(target, now, locationDirectory)
            // Half-open probe (#1123): a bench whose known quota window reset has passed admits
            // one probe attempt instead of excluding the leaf until the ladder expires. This
            // admission is tentative — the claim is spent only when selection actually picks
            // the target, below — so a probe is never consumed by a target the route passed over.
            const targetProbe = until > now && ModelRoute.probeDue(target, undefined, now)
            const credentialProbe =
              credentialUntil > now && credentialID !== undefined && ModelRoute.probeDue(target, credentialID, now)
            if (until > now && !targetProbe) unavailable.set(index, `cooldown-until:${until}`)
            else if (credentialUntil > now && !credentialProbe)
              unavailable.set(index, `credential-cooldown-until:${credentialUntil}`)
            else if (quotaBlock) unavailable.set(index, `quota-known-full-until:${quotaBlock.until ?? "unknown"}`)
            else if (providerBlock)
              unavailable.set(index, `provider-quota-known-full-until:${providerBlock.until ?? "unknown"}`)
            else if (membershipHeld > now) unavailable.set(index, `membership-held-until:${membershipHeld}`)
            else if (limited > now && !kept) unavailable.set(index, `provider-limit-until:${limited}`)
            else if (isSkipped) unavailable.set(index, isUserSkipped ? "user-skip" : "quota-skip")
            else if (isOverBudget) unavailable.set(index, "soft-budget")
            else if (isOverLimit) unavailable.set(index, "over-limit")
            return (
              (until <= now || targetProbe) &&
              (credentialUntil <= now || credentialProbe) &&
              quotaBlock === undefined &&
              providerBlock === undefined &&
              membershipHeld <= now &&
              (limited <= now || kept) &&
              !isSkipped &&
              !isOverBudget &&
              !isOverLimit
            )
          })
          // Budgets and skips are soft limits: if every remaining target is excluded, try the
          // configured tree as a last resort rather than refusing a turn. A known-full
          // credential is not a soft limit (#6): the last resort excludes one while any
          // remaining target's credential is not known-full. Context ceilings are
          // hard limits — the request cannot be served over a target's ceiling — so over-limit
          // targets stay excluded even in the last resort, and they are filtered out
          // before the non-full choice so an over-limit target cannot mask a
          // known-full-but-fitting target as the last resort.
          const usable = indexes.filter((index) => !overLimit.has(index))
          const nonFull = usable.filter((index) => {
            const target = definition.targets[index]
            const credentialID = effectiveCredential(target, now)?.id
            // Quota-dead in any scope counts as full for this preference (code#8086):
            // a credential-less leaf’s exhaustion lives only in its target bench, and
            // a provider gate or a quota bench on the serving credential is the same
            // answer in another scope. Consulting the credential gate alone let the
            // last resort seat legs whose quota was exhausted for weeks over legs
            // that were merely benched and about to serve again.
            if (ModelRoute.quotaCoolingDown(target, now)) return false
            if (ModelRoute.providerQuotaBlocked(target, now, locationDirectory) !== undefined) return false
            if (credentialID === undefined) return true
            if (ModelRoute.credentialQuotaBlocked(credentialID, now, locationDirectory) !== undefined) return false
            return !ModelRoute.credentialQuotaCoolingDown(target, credentialID, now)
          })
          // No pool-level hard exclusion (Drew, 2026-11-07): a pool cannot run out —
          // only a leaf’s own model, credential, or provider can — so the last resort
          // is the usable set itself, preferring targets that are not quota-dead in
          // any scope while any such target remains.
          const lastResort = allowQuotaDeadLastResort ? (nonFull.length > 0 ? nonFull : usable) : nonFull
          const eligible = ready.length > 0 ? ready : allowCooling ? lastResort : []
          const index = ModelRoute.nextTarget(
            definition,
            new Set(eligible),
            triedTargets,
            sessionID,
            sessionID !== undefined,
            requestedVariant,
            unavailable,
            Math.random,
            (index) => effectiveCredential(definition.targets[index], now)?.id,
            locationDirectory,
          )
          if (index === undefined) break
          triedTargets.add(index)
          const target = definition.targets[index]
          const probeToken = ModelRoute.nextProbeClaimToken()
          // Spend a due bench's probe claim on the target selection actually picked (#1123):
          // exactly one resolution walks away with it, and its outcome (completed/failed in
          // the runner) is what ends or renews the bench. Claims on scopes that are not due
          // — an ordinary eligible target — are refused and change nothing. One token
          // names the pick's spend on every scope it claims (#1486).
          const targetClaimed = ModelRoute.claimBenchProbe(target, undefined, now, probeToken)
          const probeCredential = effectiveCredential(target, now)?.id
          const credentialClaimed = probeCredential
            ? ModelRoute.claimBenchProbe(target, probeCredential, now, probeToken)
            : false
          // The claim this pick walked away with (#1478): stamped on the Resolved below so a
          // consumer that never attempts the model can release it, and one that does attempt
          // it knows the claim is its to settle. The release is token-guarded, so naming
          // both scopes is safe — a scope this pick did not claim does not match and no-ops.
          const probeClaim =
            targetClaimed || credentialClaimed
              ? { claimedAt: now, token: probeToken, ...(probeCredential ? { credentialID: probeCredential } : {}) }
              : undefined
          const source = yield* models.get(target.providerID, target.id)
          if (!source?.enabled) {
            // This pick spent a probe claim but will never be attempted: hand it back
            // (#1486, review follow-up) instead of stranding it until the bench expires.
            if (probeClaim) {
              ModelRoute.releaseBenchProbe(target, undefined, probeClaim.claimedAt, probeClaim.token)
              if (probeClaim.credentialID)
                ModelRoute.releaseBenchProbe(target, probeClaim.credentialID, probeClaim.claimedAt, probeClaim.token)
            }
            continue
          }
          // The pick was judged on its effective credential (#1806): when that is a
          // stored sibling of the blocked active credential, activate it before the
          // load so the load actually serves on it — the same switch
          // credentialFallback performs after a served failure (#6).
          const effective = effectiveCredential(target, now)
          if (effective?.activate) {
            yield* Effect.suspend(() => integrations.connection.activate(effective.id)).pipe(
              Effect.catchCause(() => Effect.void),
            )
          }
          const targetVariants = definition.targetVariants[index]
          // A requested route variant runs the target at its remap, else at the same variant when the
          // target has it natively: the route only offers variants every target can produce one of
          // those two ways (config/plugin/model-routes.ts routeVariants).
          const mapped =
            requestedVariant !== undefined
              ? (ownValue(targetVariants?.map ?? {}, requestedVariant) ??
                (source.variants.some((item) => item.id === requestedVariant) ? requestedVariant : undefined))
              : targetVariants?.default
          const resolved = yield* Effect.result(
            load(source, target.variant ?? mapped, definition.targetCacheFormats?.[index]?.cacheFormat),
          )
          if (Result.isFailure(resolved)) {
            // The pick's probe claim settles here too (#1486): the target scope benches as
            // before, and a credential-scope claim from the same pick renews with it.
            ModelRoute.failed(target, definition.health, now, undefined, undefined, locationDirectory, probeClaim)
            lastError = resolved.failure
            // A request never went out, but the reason a configured target could not be used is
            // worth its own record: this is where a broken target shows up as resolution failures.
            const reason = resolved.failure as { _tag?: string; message?: string }
            ModelRouteLog.record({
              kind: "attempt",
              row: {
                time_started: now,
                time_ended: Date.now(),
                session_id: sessionID,
                route_id: definition.id,
                provider_id: target.providerID,
                model_id: target.id,
                variant: target.variant,
                outcome: "resolution-failure",
                error_tag: reason._tag,
                error_message: reason.message,
                retryable: false,
                output_started: false,
              },
            })
            continue
          }
          const current = resolved.success.resolved
          // The credential that served this resolution, as captured by load() itself (#6):
          // attribution and failover exclusion use this, never the credentialByProvider
          // snapshot — a concurrent session may have switched the active credential
          // between the snapshot and this load, and the two can name different credentials.
          const servingCredentialID = resolved.success.servingCredentialID
          // #6 credential failover for this target: activate the next eligible stored credential
          // on the target's own integration and re-resolve the same target on it. The opencode-go
          // Lab -> Personal fall-through is this same path; there is no special case.
          // The fallback excludes the credential that served this resolved target, captured
          // at resolution time — not whatever happens to be active when the fallback runs:
          // another session may already have activated a healthy credential after this one
          // resolved, and that credential stays an eligible candidate (#6).
          // The chain also carries every credential it has already served (`attempted`):
          // eligibility is health-based, so a credential whose short cooldown expires
          // mid-chain would otherwise become a candidate again and the walk could cycle
          // between two credentials indefinitely instead of reaching route fallback.
          // Each credential is tried at most once per chain; a fresh resolution starts
          // a fresh chain (#1379, Codex review on PR #1392).
          const credentialFallback =
            (servingID: Credential.ID | undefined, attempted?: ReadonlySet<Credential.ID>) =>
            (): Effect.Effect<Resolved | undefined, Error> =>
              Effect.gen(function* () {
                const tried: ReadonlySet<Credential.ID> =
                  attempted ?? new Set(servingID === undefined ? [] : [servingID])
                const provider = yield* providers.get(target.providerID)
                const integrationID = provider?.integrationID ?? Integration.ID.make(target.providerID)
                const info = yield* integrations.get(integrationID)
                const at = Date.now()
                const candidates = (info?.connections ?? []).filter(
                  (connection) =>
                    connection.type === "credential" &&
                    connection.id !== servingID &&
                    !tried.has(connection.id) &&
                    ModelRoute.credentialCooldownUntil(target, connection.id, at) <= at &&
                    ModelRoute.credentialQuotaBlocked(connection.id, at, locationDirectory) === undefined &&
                    !ModelRoute.demoted(target, at, connection.id, locationDirectory),
                )
                for (const candidate of candidates) {
                  if (candidate.type !== "credential") continue
                  yield* integrations.connection.activate(candidate.id)
                  // The catalog source still carries the previous credential's account-scoped
                  // headers (the OpenAI plugin bakes chatgpt-account-id into the catalog
                  // headers at load time): re-derive them from the credential just activated,
                  // or the retry pairs the new credential's token with the old account (#870).
                  const value = yield* integrations.connection
                    .resolve(candidate)
                    .pipe(Effect.orElseSucceed(() => undefined))
                  const account = value?.metadata?.accountID
                  const sourceEntries = Object.entries(source.headers ?? {})
                  // Only a catalog that already carries the account header gets it rewritten:
                  // other providers' credentials can also expose an accountID metadata value
                  // (the OpenCode provider stores user.id there), and it must not leak into a
                  // chatgpt-account-id header on a non-ChatGPT catalog (#870).
                  const hadAccountHeader = sourceEntries.some(
                    ([name]) => name.toLowerCase() === "chatgpt-account-id",
                  )
                  const headers = Object.fromEntries(
                    sourceEntries.filter(([name]) => name.toLowerCase() !== "chatgpt-account-id"),
                  )
                  const refreshed =
                    hadAccountHeader && typeof account === "string"
                      ? { ...source, headers: { ...headers, "chatgpt-account-id": account } }
                      : { ...source, headers }
                  const retried = yield* Effect.result(
                    load(refreshed, target.variant ?? mapped, definition.targetCacheFormats?.[index]?.cacheFormat),
                  )
                  if (Result.isFailure(retried)) continue
                  // Attribution follows the credential load() actually served on, which is
                  // the candidate just activated unless a concurrent session switched again
                  // mid-load (#6).
                  const nextTried = new Set(tried)
                  nextTried.add(candidate.id)
                  if (retried.success.servingCredentialID !== undefined)
                    nextTried.add(retried.success.servingCredentialID)
                  return makeResolved(
                    retried.success.resolved,
                    undefined,
                    credentialFallback(retried.success.servingCredentialID, nextTried),
                    retried.success.servingCredentialID,
                  )
                }
                return undefined
              })
          // A session that just moved off its origin races that origin rather than the next fallback.
          const home = sessionID === undefined ? undefined : ModelRoute.hedgeHome(definition.id, sessionID, locationDirectory)
          const homeIndex =
            home === undefined ? -1 : definition.targets.findIndex((item) => `${item.providerID}/${item.id}` === home)
          const origin =
            homeIndex >= 0 && homeIndex !== index
              ? () =>
                  resolveRouteWithin(
                    selected,
                    definition,
                    requestedVariant,
                    new Set(definition.targets.flatMap((_, position) => (position === homeIndex ? [] : [position]))),
                    false,
                    sessionID,
                    requestTokens,
                    cascade,
                  )
              : undefined
          return makeResolved(current, origin, credentialFallback(servingCredentialID), servingCredentialID, probeClaim)
        }
        if (lastError) return yield* Effect.fail(lastError)
        return undefined
      })

    // Re-enter through the nearest route that nests an exhausted route (#1014, PR2).
    // A parent nests the exhausted route when one of its expanded groups carries the
    // route's id; the parent's tried set is seeded by target ref, so every leaf the
    // chain already attempted — including the whole nested subtree — stays excluded,
    // and the parent's remaining leaves answer in the parent's own proximity order.
    // Nesting distance from a candidate ancestor down to the exhausted route:
    // the longest chain of node route references that reaches it (1 = nests it
    // directly). A grandparent whose expanded groups also carry the exhausted
    // route's id still reaches it through the parent as well, so the longest
    // chain — not catalog order — decides proximity (#1014 Codex P2).
    const nestingDepth = (
      definitions: ReadonlyMap<string, ModelRoute.Definition>,
      from: ModelRoute.Definition,
      targetID: string,
      cache: Map<string, number | undefined>,
      seen: ReadonlySet<string> = new Set(),
    ): number | undefined => {
      // Expanded node lists already contain every descendant, so an uncached
      // recursion re-traverses each descendant per ancestor and blows up
      // exponentially on deep hierarchies: memoize per (route, target).
      const key = `${String(from.id)}>${targetID}`
      if (cache.has(key)) return cache.get(key)
      let depth: number | undefined
      for (const node of from.nodes) {
        if (!node.routeID) continue
        if (node.routeID === targetID) depth = Math.max(depth ?? 0, 1)
        else if (!seen.has(node.routeID)) {
          const child = definitions.get(node.routeID)
          if (!child) continue
          const below = nestingDepth(definitions, child, targetID, cache, new Set([...seen, String(from.id), node.routeID]))
          if (below !== undefined) depth = Math.max(depth ?? 0, below + 1)
        }
      }
      cache.set(key, depth)
      return depth
    }

    const cascadeToParent = (
      from: ModelRoute.Definition,
      fromTried: ReadonlySet<number>,
      requestedVariant: VariantID | undefined,
      sessionID: string | undefined,
      requestTokens: number | undefined,
      cascade: CascadeState,
    ): Effect.Effect<Resolved | undefined, Error> =>
      Effect.gen(function* () {
        for (const index of fromTried) {
          const target = from.targets[index]
          if (target) cascade.triedRefs.add(cascadeRefKey(target))
        }
        if (!cascade.chain.some((entry) => String(entry.definition.id) === String(from.id)))
          cascade.chain.push({ definition: from, tried: fromTried })
        // Fallback discovery is execution, not picker discovery (#230): a hidden
        // parent route still cascades, so candidates are the enabled records.
        const available = yield* models
          .all()
          .pipe(
            Effect.map((list) => list.filter((model) => model.enabled)),
            Effect.catchCause(() => Effect.succeed([] as readonly Info[])),
          )
        const definitions = new Map<string, ModelRoute.Definition>()
        for (const candidate of available) {
          if (candidate.providerID !== ModelRoute.PROVIDER_ID) continue
          const definition = ModelRoute.definition(candidate)
          if (definition) definitions.set(String(definition.id), definition)
        }
        const depthCache = new Map<string, number | undefined>()
        for (let position = cascade.chain.length - 1; position >= 0; position--) {
          const nested = cascade.chain[position].definition
          const parents = available
            .flatMap((candidate, order) => {
              if (candidate.providerID !== ModelRoute.PROVIDER_ID) return []
              const parent = ModelRoute.definition(candidate)
              if (!parent || cascade.visitedRoutes.has(String(parent.id))) return []
              // A parent that does not offer the requested variant must not be
              // entered: its leaves would silently run at their default
              // settings. The selected route's variant gate applies to every
              // route the cascade re-enters through (#1014 Codex P2).
              if (requestedVariant && !candidate.variants.some((item) => item.id === requestedVariant)) return []
              const depth = nestingDepth(definitions, parent, String(nested.id), depthCache)
              return depth === undefined ? [] : [{ candidate, parent, depth, order }]
            })
            .sort((a, b) => a.depth - b.depth || a.order - b.order)
          for (const { candidate, parent } of parents) {
            if (cascade.visitedRoutes.has(String(parent.id))) continue
            cascade.visitedRoutes.add(String(parent.id))
            const seed = new Set(
              parent.targets.flatMap((target, index) =>
                cascade.triedRefs.has(cascadeRefKey(target)) ? [index] : [],
              ),
            )
            // A parent whose remaining targets all fail to load is exhausted,
            // not fatal: the cascade continues upward instead of dying on the
            // failure (#1014 Codex P2).
            const resolved = yield* resolveRouteWithin(
              candidate,
              parent,
              requestedVariant,
              seed,
              false,
              sessionID,
              requestTokens,
              cascade,
            ).pipe(
              Effect.catch((error) => {
                cascade.loadErrors.push(error)
                return Effect.succeed(undefined)
              }),
            )
            if (resolved) return resolved
            const above = yield* cascadeToParent(parent, seed, requestedVariant, sessionID, requestTokens, cascade)
            if (above) return above
          }
        }
        return undefined
      })

    // Direct-model route attachment (#7073): a session launched on a bare
    // provider model carries no routing, so the runner's failover cascade —
    // gated on `model.routing` — can never engage and a startup provider
    // error (auth 401, routing 404, expired credential) is terminal even
    // when a configured route already lists that exact model as a target
    // with candidates behind it. When such a route exists, attach its
    // routing to the direct resolution: the selected model still serves
    // first (it is this resolution's target), and `fallback` enters the
    // route's own cascade with the direct target seeded as tried, then
    // continues to parent routes exactly like a routed resolution's
    // fallback. No containing route (or a route whose only target is the
    // selected model) leaves the resolution unrouted, unchanged.
    const attachDirectRoute = (
      selected: Info,
      variant: VariantID | undefined,
      sessionID: string | undefined,
      requestTokens: number | undefined,
    ): Effect.Effect<Resolved, Error> =>
      Effect.gen(function* () {
        const loaded = yield* load(selected, variant)
        const available = yield* models.all().pipe(
          Effect.map((list) => list.filter((model) => model.enabled)),
          Effect.catchCause(() => Effect.succeed([] as readonly Info[])),
        )
        const containing = available.flatMap((candidate) => {
          if (candidate.providerID !== ModelRoute.PROVIDER_ID) return []
          const route = ModelRoute.definition(candidate)
          if (!route || route.targets.length < 2) return []
          const index = route.targets.findIndex(
            (target) => target.providerID === selected.providerID && target.id === selected.id,
          )
          return index < 0 ? [] : [{ candidate, route, index }]
        })
        const first = containing[0]
        if (!first) return loaded.resolved
        const { candidate, route, index } = first
        const requestedVariant = variant === "default" ? undefined : variant
        const cascade: CascadeState = {
          triedRefs: new Set([cascadeRefKey(route.targets[index])]),
          visitedRoutes: new Set([String(route.id)]),
          chain: [],
          loadErrors: [],
        }
        const seed = new Set([index])
        return {
          ...loaded.resolved,
          routing: {
            routeID: route.id,
            target: loaded.resolved.ref,
            ...(route.system ? { system: route.system } : {}),
            policy: route.health,
            attempts: route.attempts ?? 2,
            ...(route.hedgeAfterMs ? { hedgeAfterMs: route.hedgeAfterMs } : {}),
            autonomy: route.autonomy,
            ...(loaded.servingCredentialID ? { credentialID: loaded.servingCredentialID } : {}),
            fallback: () => {
              const branchTried = new Set(seed)
              const branchState: CascadeState = {
                triedRefs: new Set(cascade.triedRefs),
                visitedRoutes: new Set(cascade.visitedRoutes),
                chain: [...cascade.chain],
                loadErrors: [...cascade.loadErrors],
              }
              return resolveRouteWithin(
                candidate,
                route,
                requestedVariant,
                branchTried,
                false,
                sessionID,
                requestTokens,
                branchState,
              ).pipe(
                Effect.catch((error) => {
                  branchState.loadErrors.push(error)
                  return Effect.succeed(undefined)
                }),
                Effect.flatMap((next) =>
                  next
                    ? Effect.succeed(next)
                    : cascadeToParent(route, branchTried, requestedVariant, sessionID, requestTokens, branchState),
                ),
                Effect.flatMap((resolved) =>
                  resolved
                    ? Effect.succeed(resolved)
                    : branchState.loadErrors.length > 0
                      ? Effect.fail(branchState.loadErrors[0])
                      : Effect.succeed(undefined),
                ),
              )
            },
          },
        } satisfies Resolved
      })

    const resolveSelected = (selected: Info, variant?: VariantID, sessionID?: string, requestTokens?: number) => {
      const definition = ModelRoute.definition(selected)
      if (selected.providerID !== ModelRoute.PROVIDER_ID && !definition)
        return attachDirectRoute(selected, variant, sessionID, requestTokens)
      if (!definition || definition.targets.length === 0)
        return Effect.fail(new RouteUnavailableError({ routeID: selected.id, providerID: selected.providerID }))
      const requestedVariant = variant === "default" ? undefined : variant
      if (requestedVariant && !selected.variants.some((item) => item.id === requestedVariant))
        return Effect.fail(
          new VariantUnavailableError({
            providerID: selected.providerID,
            modelID: selected.id,
            variant: requestedVariant,
          }),
        )
      const cascade: CascadeState = {
        triedRefs: new Set(),
        visitedRoutes: new Set([String(definition.id)]),
        chain: [],
        loadErrors: [],
      }
      const initialTried = new Set<number>()
      return resolveRouteWithin(
        selected,
        definition,
        requestedVariant,
        initialTried,
        true,
        sessionID,
        requestTokens,
        cascade,
      ).pipe(
        // Exhausted through load failures is a cascade boundary too (#1014
        // Codex P2): the parents still get their chance, and the typed
        // failure is recorded so it — not a bare RouteUnavailableError —
        // surfaces when no ancestor can serve the request either.
        Effect.catch((error) => {
          cascade.loadErrors.push(error)
          return Effect.succeed(undefined)
        }),
        Effect.flatMap((resolved) =>
          resolved
            ? Effect.succeed(resolved)
            : cascadeToParent(definition, initialTried, requestedVariant, sessionID, requestTokens, cascade),
        ),
        Effect.flatMap((resolved) =>
          resolved
            ? Effect.succeed(resolved)
            : cascade.loadErrors.length > 0
              ? Effect.fail(cascade.loadErrors[0])
              : Effect.fail(new RouteUnavailableError({ routeID: selected.id, providerID: selected.providerID })),
        ),
      )
    }

    return Service.of({
      resolve: Effect.fn("ModelResolver.resolve")(function* (requested, requestTokens) {
        let target = requested
        if (target && Option.isSome(config)) {
          const cfg = config.value
          const entries = yield* cfg.entries()
          const aliases = Config.latest(entries, "aliases")
          if (aliases) {
            // Alias precedence is execution semantics (#230): a real model keeps
            // precedence over an alias whether or not it is picker-hidden.
            const availableModels = (yield* models.all()).filter((model) => model.enabled)
            const exists = ({ providerID, modelID }: { providerID: string; modelID: string }) =>
              availableModels.some((m) => m.providerID === providerID && m.id === modelID)
            const refStr = ModelAlias.refString(target)
            try {
              const res = ModelAlias.resolveRef(aliases, refStr, exists)
              target = Ref.make({
                providerID: Provider.ID.make(res.providerID),
                id: ID.make(res.id),
                ...(res.variant ? { variant: VariantID.make(res.variant) } : {}),
              })
            } catch {}
          }
        }
        const selected = target
          ? yield* models.get(target.providerID, target.id)
          : yield* models
              .default()
              .pipe(
                Effect.flatMap((model) =>
                  model && hasPackage(model)
                    ? Effect.succeed(model)
                    : Effect.map(models.available(), (models) =>
                        models.find((model) => hasPackage(model) && Model.supportsText(model)),
                      ),
                ),
              )
        if (!selected) return undefined
        return yield* resolveSelected(selected, target?.variant, undefined, requestTokens)
      }),
      resolveModel: (selected, variant, sessionID, requestTokens) =>
        resolveSelected(selected, variant, sessionID, requestTokens),
    })
  }),
)

function hasConfiguredAuth(model: RuntimeInfo) {
  return [model.settings?.apiKey, model.settings?.authToken, model.settings?.accessToken].some(
    (value) => typeof value === "string" && value !== "",
  )
}

function usesAPIKeyAuth(packageName: string | undefined) {
  const name = Provider.packageName(packageName)
  return (
    name === "@ai-sdk/openai" ||
    name === "@ai-sdk/anthropic" ||
    name === "@ai-sdk/cerebras" ||
    name === "@ai-sdk/deepinfra" ||
    name === "@ai-sdk/openai-compatible" ||
    name === "@ai-sdk/google" ||
    name === "@ai-sdk/groq" ||
    name === "@ai-sdk/mistral" ||
    name === "@ai-sdk/togetherai" ||
    name === "@ai-sdk/xai" ||
    name === "@openrouter/ai-sdk-provider" ||
    name === "@ai-sdk/azure" ||
    name === "@opencode/ai/providers/openai" ||
    name?.startsWith("@opencode/ai/providers/openai/") === true ||
    name === "@opencode/ai/providers/anthropic" ||
    name === "@opencode/ai/providers/anthropic-compatible" ||
    name === "@opencode/ai/providers/baseten" ||
    name === "@opencode/ai/providers/cerebras" ||
    name === "@opencode/ai/providers/cloudflare-ai-gateway" ||
    name === "@opencode/ai/providers/cloudflare-workers-ai" ||
    name === "@opencode/ai/providers/deepinfra" ||
    name === "@opencode/ai/providers/deepseek" ||
    name === "@opencode/ai/providers/fireworks" ||
    name === "@opencode/ai/providers/openai-compatible" ||
    name === "@opencode/ai/providers/google" ||
    name === "@opencode/ai/providers/google/interactions" ||
    name === "@opencode/ai/providers/groq" ||
    name === "@opencode/ai/providers/mistral" ||
    name === "@opencode/ai/providers/togetherai" ||
    name === "@opencode/ai/providers/vercel-ai-gateway" ||
    name === "@opencode/ai/providers/xai" ||
    name === "@opencode/ai/providers/openrouter" ||
    name === "@opencode/ai/providers/azure" ||
    name?.startsWith("@opencode/ai/providers/azure/") === true
  )
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Provider.node, Model.node, Integration.node, Npm.node, AISDK.node, ModelRouteLog.node],
})
