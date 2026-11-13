export * as OptimizePlugin from "./optimize.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import { SessionSystemPrompt } from "../session/system-prompt.js"
import DELEGATION_PROMPT from "../session/runner/prompt/delegation.txt"

import PROMPT_GPT from "./system-prompt/gpt.txt"
import PROMPT_ASTRA from "./system-prompt/gpt-astra.txt"
import PROMPT_KIMI from "./system-prompt/kimi.txt"
import PROMPT_META from "./system-prompt/meta.txt"
import PROMPT_TRINITY from "./system-prompt/trinity.txt"
import PROMPT_ANTHROPIC from "./system-prompt/anthropic.txt"

export const OpenAIPlugin = make("opencode.prompt.openai", (model) => {
  const id = model.id.toLowerCase()
  if (!id.includes("gpt")) return undefined
  return id.includes("astra") ? PROMPT_ASTRA : PROMPT_GPT
})

export const AnthropicPlugin = make(
  "opencode.prompt.anthropic",
  (model) => {
    const id = model.id.toLowerCase()
    if (!id.includes("claude")) return undefined
    return PROMPT_ANTHROPIC
  },
  "append",
)

// Both OpenAIToolsPlugin and AnthropicToolsPlugin are disabled intentionally until we can figure out a good ux for displaying
// heavy grep/glob usage done via shell or other mechanisms

export const OpenAIToolsPlugin = make("opencode.optimize.openai.tools", (model, tools) => {
  const ids = [model.id, model.modelID, model.family].join(" ").toLowerCase()
  if (!ids.includes("gpt")) return undefined
  delete tools.grep
  delete tools.glob
  return undefined
})

export const AnthropicToolsPlugin = make("opencode.optimize.anthropic.tools", (model, tools) => {
  const ids = [model.id, model.modelID, model.family].join(" ").toLowerCase()
  if (!ids.includes("claude")) return undefined
  delete tools.grep
  delete tools.glob
  return undefined
})

export const KimiPlugin = make("opencode.prompt.kimi", (model) =>
  model.id.toLowerCase().includes("kimi") ? PROMPT_KIMI : undefined,
)
export const ArceePlugin = make("opencode.prompt.arcee", (model) =>
  model.id.toLowerCase().includes("trinity") ? PROMPT_TRINITY : undefined,
)
export const MetaPlugin = make("opencode.prompt.meta", (model) => {
  if (!model.id.toLowerCase().includes("muse")) return undefined
  return PROMPT_META.replaceAll("{{MODEL_NAME}}", model.name)
})

// DeepSeek has no family prompt file of its own (#1888): it serves under the
// generic Kimi template, which carries the shared delegation stance, instead of
// matching no family at all and getting no family prompt.
export const DeepSeekPlugin = make("opencode.prompt.deepseek", (model) =>
  model.id.toLowerCase().includes("deepseek") ? PROMPT_KIMI : undefined,
)

// The shared delegation guidance (#1887/#1888), rendered by the base and family prompts.
export const DELEGATION_GUIDANCE = DELEGATION_PROMPT.trim()

const FAMILY_MATCHES = ["gpt", "claude", "kimi", "trinity", "muse", "deepseek"] as const

// Fallback for models no family matches (#1888): they keep the base system
// prompt, with the delegation stance appended — the base policy, never nothing.
export const fallbackDelegationPrompt = (model: Model.Info): string | undefined => {
  const id = model.id.toLowerCase()
  if (FAMILY_MATCHES.some((family) => id.includes(family))) return undefined
  return DELEGATION_GUIDANCE
}

export const FallbackPlugin = make(
  "opencode.prompt.fallback",
  (model) => fallbackDelegationPrompt(model),
  "append",
)

export const Plugins = [OpenAIPlugin, AnthropicPlugin, KimiPlugin, ArceePlugin, MetaPlugin, DeepSeekPlugin, FallbackPlugin] as const

function make(
  id: string,
  optimize: (model: Model.Info, tools: SessionHooks["context"]["tools"]) => string | undefined,
  mode: "override" | "append" = "override",
) {
  return define({
    id,
    effect: Effect.fn(`OptimizePlugin.${id}`)(function* (ctx) {
      const hook = (event: SessionHooks["context"]) =>
        Effect.gen(function* () {
          const model =
            (yield* ctx.model.list()).data.find(
              (model) => model.providerID === event.model.providerID && model.id === event.model.id,
            ) ?? Model.Info.default(event.model.providerID, event.model.id)
          // Curate tools before rendering their guidance, including for agents with a custom system prompt.
          const template = optimize(model, event.tools)
          if (!template) return
          if ((yield* ctx.agent.get({ agentID: event.agent })).data.system) return
          const system = event.system[0]
          if (!system) return
          const rendered = SessionSystemPrompt.render(template, Object.keys(event.tools))
          // Append is idempotent: the base prompt already carries the shared delegation
          // guidance (system.txt placeholder, 28212ab2a2), so an append-mode plugin whose
          // rendered text is already present must not duplicate it at the end.
          const text = mode === "append" ? (system.text.includes(rendered) ? system.text : `${system.text}\n\n${rendered}`) : rendered
          event.system[0] = { ...system, text }
        }).pipe(Effect.catch(() => Effect.void))
      yield* ctx.session.hook("context", hook)
      yield* ctx.session.hook("compaction", hook)
      yield* ctx.session.hook("generate", hook)
    }),
  })
}
