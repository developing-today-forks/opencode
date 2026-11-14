export * as SessionRunnerRenderCard from "./render-card.js"

import { ModelPlan } from "../../model-plan.js"

/**
 * The render-card seam (opencode#2384 slices 2–3, design A — agent-invoked,
 * recorded by triage task 16473 on the issue).
 *
 * When a session runs under OpenChamber hosting, the host provides an
 * `openchamber_render` tool (slice 1, openchamber PR #717): the agent calls
 * it with `render.page` + `awaitAnswer: true` and a card's HTML, and the
 * tool result *is* the user's submitted answer. This module is the client
 * half that lives in core:
 *
 * - tool detection — no host tool, no cards: routing and quota behavior
 *   are exactly as before (acceptance 3);
 * - the two cards' HTML, generating the same documents as the OpenChamber
 *   helper (`tier-chooser-card.js` in the OpenChamber repo): same tiles,
 *   same `openchamber.submit(payload, summary)` script, same answer
 *   payloads — `{ tier, model }` for the chooser, `{ action: "fallback",
 *   provider, tier }` for the quota fallback;
 * - answer parsing for the tool result the host returns, including the
 *   answered-in-chat abort (`RENDER_PAGE_CLOSED_IN_CHAT_NOTE` on the
 *   OpenChamber side; here the exact same note text);
 * - the trigger decisions (bare/ambiguous route at a step's start; a
 *   quota wall whose failover walk is exhausted) and the directive text
 *   the runner injects so the agent makes the call at the right moment;
 * - answer application through the model-plan store (`ModelPlan.setModel`
 *   records the chosen model's tier; a user-source note records the
 *   choice itself).
 *
 * The deep wiring — injecting the directives at step start and at the
 * quota-exhaustion fall-through in `step.ts`, and feeding tool results
 * back through the parsers — consumes exactly these functions; the
 * trigger/application logic itself is here so it is testable without a
 * live OpenChamber host (acceptance 4: a fake render tool stands in).
 */

/** The host-provided tool's name, as registered by the OpenChamber plugin. */
export const RENDER_TOOL_NAME = "openchamber_render"

/** The render action the cards are drawn through. */
export const RENDER_PAGE_ACTION = "render.page"

/**
 * The note the host returns when the user types in chat instead of
 * answering on the page. Verbatim from the OpenChamber render-page
 * protocol (`RENDER_PAGE_CLOSED_IN_CHAT_NOTE`): the wait aborts and the
 * turn continues from the user's text.
 */
export const RENDER_PAGE_CLOSED_IN_CHAT_NOTE =
  "The user did not answer on the page and wrote in the chat instead; their message follows this result. Continue from that message and don't ask the same question on a page again unless they want it."

/** True when the session's tool set includes the host render tool. */
export const hasRenderTool = (toolNames: Iterable<string>): boolean => {
  for (const name of toolNames) if (name === RENDER_TOOL_NAME) return true
  return false
}

// ---------------------------------------------------------------------------
// Card HTML — the OpenChamber helper's documents, generated in core.
// ---------------------------------------------------------------------------

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPE_MAP[char] ?? char)

const capitalizeTier = (tier: string): string => (tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : tier)

const cardStyle = () =>
  [
    "<style>",
    ".tier-card{background:var(--bg-base);color:var(--text-primary);border:1px solid var(--border-base);border-radius:12px;padding:16px;max-width:640px}",
    ".tier-card h1{font-size:1.1rem;margin:0 0 4px}",
    ".tier-card p{margin:0 0 12px}",
    ".tier-card .oc-options{display:grid;gap:8px}",
    ".tier-card .oc-option{display:block;width:100%;text-align:left;background:var(--bg-base);color:var(--text-primary);border:1px solid var(--border-base);border-radius:8px;padding:12px;cursor:pointer}",
    ".tier-card .oc-option:hover{border-color:var(--accent-primary)}",
    '.tier-card .oc-option[aria-pressed="true"]{border-color:var(--accent-primary)}',
    ".tier-card .tier-choose{display:inline-block;margin-top:8px;background:var(--accent-primary);border-radius:6px;padding:4px 10px}",
    "</style>",
  ].join("")

const answerScript = () =>
  [
    "<script>(function(){",
    'var buttons=document.querySelectorAll("[data-payload]");',
    "buttons.forEach(function(btn){",
    'btn.addEventListener("click",function(){',
    "if(btn.disabled)return;",
    'var payload;try{payload=JSON.parse(btn.getAttribute("data-payload"));}catch(e){return;}',
    'var summary=btn.getAttribute("data-summary")||(btn.textContent||"").trim();',
    "btn.disabled=true;",
    "window.openchamber.submit(payload,summary).then(function(){btn.setAttribute(\"aria-pressed\",\"true\");})",
    ".catch(function(){btn.disabled=false;});",
    "});});})();</script>",
  ].join("")

const buildDocument = (title: string, bodyHtml: string) =>
  [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    cardStyle(),
    `</head><body class="font-sans"><div class="tier-card"><h1>${escapeHtml(title)}</h1>${bodyHtml}</div>`,
    answerScript(),
    "</body></html>",
  ].join("")

/** One tier on the chooser card. Pricing is caller-supplied, rendered as given. */
export interface TierOption {
  readonly tier: ModelPlan.Tier
  readonly model: string
  readonly label?: string
  readonly description?: string
  readonly inputPerM?: number | string
  readonly outputPerM?: number | string
  readonly latency?: string
}

/**
 * The tier chooser card: one tile per tier, each submitting
 * `{ tier, model }`. Mirrors `buildTierChooserCard` in the OpenChamber
 * helper, including its validation and summary shape.
 */
export const tierChooserCard = (input: { readonly title?: string; readonly tiers: readonly TierOption[] }): string => {
  if (!input.tiers.length) throw new Error("tierChooserCard needs a non-empty tiers array")
  for (const entry of input.tiers) {
    if (!entry.tier || !entry.model) throw new Error("tierChooserCard needs { tier, model } for every tier")
  }
  const tiles = input.tiers
    .map((entry) => {
      const payload = JSON.stringify({ tier: entry.tier, model: entry.model })
      const summary = `Selected ${capitalizeTier(entry.tier)} Tier (${entry.model})`
      const heading = entry.label ?? `${capitalizeTier(entry.tier)} · ${entry.model}`
      const pricing =
        entry.inputPerM === undefined && entry.outputPerM === undefined
          ? ""
          : `<div class="tier-pricing">${[
              entry.inputPerM === undefined ? "" : `$${escapeHtml(entry.inputPerM)} in`,
              entry.outputPerM === undefined ? "" : `$${escapeHtml(entry.outputPerM)} out`,
            ]
              .filter(Boolean)
              .join(" / ")} per 1M</div>`
      const details = [
        entry.description ? `<div class="tier-desc">${escapeHtml(entry.description)}</div>` : "",
        pricing,
        entry.latency ? `<div class="tier-latency">${escapeHtml(entry.latency)}</div>` : "",
      ].join("")
      return [
        `<button type="button" class="oc-option" data-tier="${escapeHtml(entry.tier)}"`,
        ` data-model="${escapeHtml(entry.model)}"`,
        ` data-payload="${escapeHtml(payload)}" data-summary="${escapeHtml(summary)}">`,
        `<div class="tier-name">${escapeHtml(heading)}</div>`,
        `<div class="tier-model">${escapeHtml(entry.model)}</div>`,
        details,
        `<span class="tier-choose">Choose ${escapeHtml(capitalizeTier(entry.tier))}</span>`,
        "</button>",
      ].join("")
    })
    .join("")
  return buildDocument(input.title ?? "Select Execution Tier", `<div class="oc-options">${tiles}</div>`)
}

export const FALLBACK_KINDS = ["switch-provider", "downgrade-tier", "wait-for-reset"] as const
export type FallbackKind = (typeof FALLBACK_KINDS)[number]

/** One action on the quota fallback card. */
export interface FallbackAction {
  readonly kind: FallbackKind
  readonly provider: string
  readonly tier: ModelPlan.Tier
  readonly label?: string
  readonly detail?: string
  readonly summary?: string
}

const FALLBACK_LABELS: Record<FallbackKind, string> = {
  "switch-provider": "Switch provider",
  "downgrade-tier": "Downgrade tier",
  "wait-for-reset": "Wait for reset",
}

/**
 * The quota fallback card: tiles for switch-provider, downgrade-tier
 * and wait-for-reset (all three required, as in the helper), each
 * submitting `{ action: "fallback", provider, tier }`. Note the
 * helper's payload carries no kind: a wait-for-reset answer names the
 * *current* provider/tier, which is how `parseRenderAnswer` tells it
 * apart from a switch.
 */
export const quotaFallbackCard = (input: {
  readonly title?: string
  readonly message?: string
  readonly currentProvider?: string
  readonly currentTier?: string
  readonly actions: readonly FallbackAction[]
}): string => {
  if (!input.actions.length) throw new Error("quotaFallbackCard needs a non-empty actions array")
  const kinds = input.actions.map((action) => action.kind)
  for (const kind of FALLBACK_KINDS) {
    if (!kinds.includes(kind)) throw new Error(`quotaFallbackCard needs a ${kind} action`)
  }
  for (const action of input.actions) {
    if (!action.provider || !action.tier) throw new Error("quotaFallbackCard needs { provider, tier } for every action")
  }
  const context = [
    input.message ? `<p>${escapeHtml(input.message)}</p>` : "",
    input.currentProvider || input.currentTier
      ? `<p>Current: ${escapeHtml(input.currentProvider ?? "")} / ${escapeHtml(input.currentTier ?? "")}</p>`
      : "",
  ].join("")
  const tiles = input.actions
    .map((action) => {
      const payload = JSON.stringify({ action: "fallback", provider: action.provider, tier: action.tier })
      const summary = action.summary ?? action.label ?? `${FALLBACK_LABELS[action.kind]}: ${action.provider}/${action.tier}`
      const heading = action.label ?? FALLBACK_LABELS[action.kind]
      return [
        `<button type="button" class="oc-option" data-kind="${escapeHtml(action.kind)}"`,
        ` data-provider="${escapeHtml(action.provider)}" data-tier="${escapeHtml(action.tier)}"`,
        ` data-payload="${escapeHtml(payload)}" data-summary="${escapeHtml(summary)}">`,
        `<div class="tier-name">${escapeHtml(heading)}</div>`,
        `<div class="tier-model">${escapeHtml(action.provider)} / ${escapeHtml(action.tier)}</div>`,
        action.detail ? `<div class="tier-desc">${escapeHtml(action.detail)}</div>` : "",
        `<span class="tier-choose">${escapeHtml(heading)}</span>`,
        "</button>",
      ].join("")
    })
    .join("")
  return buildDocument(input.title ?? "Quota Limit Reached", `${context}<div class="oc-options">${tiles}</div>`)
}

/** The tool call the agent makes to draw a card and wait for its answer. */
export const renderCall = (input: { readonly title: string; readonly html: string }) => ({
  action: RENDER_PAGE_ACTION,
  title: input.title,
  html: input.html,
  awaitAnswer: true as const,
})

// ---------------------------------------------------------------------------
// Answer parsing — the host tool result's shapes (slice 1 protocol).
// ---------------------------------------------------------------------------

/** A submitted tier-chooser answer. */
export interface TierChoice {
  readonly tier: ModelPlan.Tier
  readonly model: string
}

/** A submitted quota-fallback answer, with the kind re-derived. */
export interface QuotaFallbackChoice {
  readonly provider: string
  readonly tier: ModelPlan.Tier
  /** `wait` when the answer names the walled provider/tier itself. */
  readonly kind: "switch" | "wait"
}

export type RenderAnswer =
  | { readonly type: "tier-choice"; readonly choice: TierChoice }
  | { readonly type: "quota-fallback"; readonly choice: QuotaFallbackChoice }
  | { readonly type: "chat"; readonly note: string }
  | { readonly type: "none" }

const isTier = (value: unknown): value is ModelPlan.Tier => value === "cheap" || value === "standard" || value === "frontier"

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined

/**
 * Parse a render tool result into the answer it carries.
 *
 * The host returns its result as JSON text:
 * `{ ok: true, action: "render.page", data: { answer, note? } }`, where
 * `answer` is the submitted payload object, or `{ answered: false,
 * reason: "chat" }` with the closed-in-chat note when the user typed
 * in chat instead. A bare answer object (what a fake render tool in
 * tests returns) is accepted too. Anything else — a failed call, an
 * unanswered page, a malformed payload — is `none`, never a guess.
 */
export const parseRenderAnswer = (
  result: unknown,
  context?: { readonly currentProvider?: string; readonly currentTier?: string },
): RenderAnswer => {
  const parsed = typeof result === "string" ? safeJson(result) : result
  const root = asRecord(parsed)
  if (!root) return { type: "none" }
  if (root.ok === false) return { type: "none" }
  const data = asRecord(root.data)
  const answer = asRecord(data?.answer) ?? (data === undefined && root.data === undefined ? root : undefined)
  if (!answer) return { type: "none" }
  if (answer.answered === false) {
    return { type: "chat", note: typeof data?.note === "string" ? data.note : RENDER_PAGE_CLOSED_IN_CHAT_NOTE }
  }
  if (answer.action === "fallback") {
    if (typeof answer.provider !== "string" || !answer.provider || !isTier(answer.tier)) return { type: "none" }
    const kind =
      context?.currentProvider === answer.provider && context?.currentTier === answer.tier ? "wait" : "switch"
    return { type: "quota-fallback", choice: { provider: answer.provider, tier: answer.tier, kind } }
  }
  if (typeof answer.model === "string" && answer.model && isTier(answer.tier)) {
    return { type: "tier-choice", choice: { tier: answer.tier, model: answer.model } }
  }
  return { type: "none" }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Triggers and directives — the routing layer's decisions, as data.
// ---------------------------------------------------------------------------

/**
 * Slice 2's trigger: at a step's start, the route is bare/ambiguous
 * when the step resolved without a route (`routing === undefined` on
 * the resolved model) — there is no configured candidate set to pick
 * from, so the choice belongs to the user. The chooser fires at most
 * once per session decision (`alreadyAsked` latches it), and only
 * when the host render tool is present.
 */
export const tierChooserTrigger = (input: {
  readonly hasRenderTool: boolean
  readonly routeBare: boolean
  readonly alreadyAsked: boolean
}): boolean => input.hasRenderTool && input.routeBare && !input.alreadyAsked

/** The structured quota-wall state a step ends in (slice 3). */
export interface QuotaWall {
  readonly providerID: string
  readonly modelID: string
  /** The known quota reset instant (epoch ms), when the wall states one. */
  readonly resetAt?: number
  /** The failure's own words, for the card's context line. */
  readonly message?: string
}

/**
 * Slice 3's trigger: the failover walk is exhausted for a quota-class
 * failure (the retry policy's `neverRetry` classes and the step's
 * quota classification agree the leg is walled, and neither a
 * credential switch nor a route fallback served). Without the render
 * tool the step simply fails as it does today.
 */
export const quotaFallbackTrigger = (input: {
  readonly hasRenderTool: boolean
  readonly quotaExhausted: boolean
  readonly failoverServed: boolean
}): boolean => input.hasRenderTool && input.quotaExhausted && !input.failoverServed

/**
 * The directive injected at a bare-route step start: it names the
 * tool, carries the card HTML to draw, and states how the answer is
 * applied — so the wait lives inside a normal tool call, the only
 * wait the protocol supports.
 */
export const tierChooserDirective = (tiers: readonly TierOption[]): string =>
  [
    "Routing decision needed: this step has no configured route, so the execution tier is the user's to choose.",
    `Call ${RENDER_TOOL_NAME} with action "${RENDER_PAGE_ACTION}", awaitAnswer: true, and the tier chooser card HTML below.`,
    "The tool result is the user's submitted { tier, model }: record it in the model plan (set the model's tier) and continue this turn on that model.",
    `If the result instead says the user answered in chat, continue from their message and do not ask again on a page.`,
    "",
    tierChooserCard({ tiers }),
  ].join("\n")

/** The directive injected after a quota wall: same shape, fallback card. */
export const quotaFallbackDirective = (wall: QuotaWall, actions: readonly FallbackAction[]): string =>
  [
    `Quota wall: ${wall.providerID}/${wall.modelID} is exhausted and the failover walk found no candidate.`,
    wall.resetAt === undefined ? "" : `The quota resets at ${new Date(wall.resetAt).toISOString()}.`,
    `Call ${RENDER_TOOL_NAME} with action "${RENDER_PAGE_ACTION}", awaitAnswer: true, and the quota fallback card HTML below.`,
    "The tool result is the user's submitted fallback: apply it in this same turn — switch provider/tier through the model plan, or wait for the stated reset.",
    `If the result instead says the user answered in chat, continue from their message and do not ask again on a page.`,
    "",
    quotaFallbackCard({
      message: wall.message,
      currentProvider: wall.providerID,
      actions,
    }),
  ]
    .filter((line) => line !== "")
    .join("\n")

// ---------------------------------------------------------------------------
// Answer application — through the model-plan store.
// ---------------------------------------------------------------------------

/**
 * Apply a submitted tier choice: the chosen model carries the chosen
 * tier in the plan store the resolver's quota gate reads, and the
 * choice itself is recorded as a user-source note input for the
 * caller to append (`ModelPlan.addNote`), so what the user picked
 * stays on record as they picked it.
 */
export const applyTierChoice = (
  store: ModelPlan.Store,
  choice: TierChoice,
  now: string,
): { readonly store: ModelPlan.Store; readonly note: ModelPlan.NoteInput } => ({
  store: ModelPlan.setModel(store, choice.model, { tier: choice.tier }, now),
  note: {
    kind: "plan-change",
    source: "user",
    modelID: choice.model,
    text: `Tier chooser answer: ${choice.model} runs at tier ${choice.tier}.`,
  },
})

/**
 * Apply a submitted quota fallback: a switch records the target
 * provider's model tier choice as a user note for the caller to
 * append and returns the routing instruction the runner acts on; a
 * wait returns the reset instant to wait for. The store is returned
 * unchanged — a fallback is a routing act for this turn, not a plan
 * edit, unless the user later makes it one.
 */
export const applyQuotaFallback = (
  choice: QuotaFallbackChoice,
  wall: QuotaWall,
): { readonly instruction: { readonly kind: "switch"; readonly providerID: string; readonly tier: ModelPlan.Tier } | { readonly kind: "wait"; readonly until?: number }; readonly note: ModelPlan.NoteInput } =>
  choice.kind === "wait"
    ? {
        instruction: { kind: "wait", until: wall.resetAt },
        note: {
          kind: "plan-change",
          source: "user",
          providerID: wall.providerID,
          modelID: wall.modelID,
          text: `Quota fallback answer: wait for reset on ${wall.providerID}/${wall.modelID}.`,
        },
      }
    : {
        instruction: { kind: "switch", providerID: choice.provider, tier: choice.tier },
        note: {
          kind: "plan-change",
          source: "user",
          providerID: choice.provider,
          text: `Quota fallback answer: switch to ${choice.provider} at tier ${choice.tier} (from ${wall.providerID}/${wall.modelID}).`,
        },
      }
