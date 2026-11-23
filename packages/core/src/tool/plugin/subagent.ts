export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Predicate, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Job } from "../../job.js"
import { Model } from "../../model.js"
import { ModelAlias } from "../../model-alias.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SubagentDepth } from "../../session/subagent-depth.js"
import { FSUtil } from "@opencode/util/fs-util"
import { SubagentJob } from "../../session/subagent-job.js"
import { McpxSubagent } from "./mcpx-subagent.js"

export const name = "subagent"

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will receive a <background-result kind="subagent"> message when it goes idle, and again after each later round of work.`,
    "DO NOT sleep, poll, proactively check on its progress, or duplicate this subagent's work.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
    "To send it follow-ups or change its instructions while it runs, call subagent again with this sessionID.",
  ].join("\n"),
})

export const Input = Schema.Struct({
  agent: Schema.String.annotate({
    description:
      "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
  }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'Set this when the user asks for a particular model or the task clearly warrants a different one. It must be a chat model; image and decision models can\'t run subagents. The value is a model ref ("providerID/modelID", or "providerID/modelID#variant" to include a variant), a configured alias or route name, or "auto" for the default chain (the agent\'s configured model, then the inherited model). Do not guess the ID: look unfamiliar models up with the models tool.',
  }),
  force: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Set true only to explicitly override the agent definition's model lists for this call. Ancestor session policies still apply and cannot be forced past.",
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description: "Send a follow-up to an existing subagent, running or finished. Omit to start a new one.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.",
  }),
  stopPolicy: Schema.optionalKey(Job.StopPolicy).annotate({
    description:
      "What interrupting the parent does to a background subagent: independent (default) keeps running, cascade stops with the parent, detached survives plain and cascade stops and needs force-stop.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})
export const description = [
  "Spawns an agent in a child session to work on the specified task.",
  "Spawn subagents only when the user or applicable AGENTS.md/skill instructions explicitly ask for subagents, delegation, or parallel agent work.",
  "A subagent may itself launch subagents, subject to the depth limit and to model governance; governance failures name the allowed models, so pick a permitted one and retry.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Pass the returned sessionID to continue that specific child conversation. A follow-up to a running child joins its current run.",
  "Foreground (default) runs the subagent to completion and returns its final response.",
  'Background mode (background=true) returns immediately with a sessionID, and you receive a `<background-result kind="subagent">` message each time the child goes idle, including after later work. Keep working on non-overlapping tasks, or briefly tell the user what you launched and end your response. Do not sleep, poll, or proactively check on the child\'s progress.',
  "Use background only for independent work that can run while you continue elsewhere.",
  "Background launches accept stopPolicy: independent (default) keeps running when the parent is interrupted, cascade stops with the parent, detached survives plain and cascade stops until force-stopped.",
  "Children inherit your working directory: a child runs in the same directory as the session that launched it.",
  "Children inherit your model and route when you pass no model argument, unless the chosen agent definition configures its own model, which then wins; pass model to override either. The child result confirms only the sessionID, so rely on this inheritance rule, not on the result, for the directory and model a child actually got.",
  "Nesting depth is capped by experimental.subagent_depth (default 5): a top-level session is depth 0 and can nest 5 levels deep, and a max_depth on an agent definition can lower the cap for its subtree. The section appended below states your current depth and how many nesting levels remain from your session.",
  "Warning: a child that calls the question tool blocks until an external actor answers. A foreground subagent call waits on that answer, and in a detached or background context nobody may ever answer, stalling the child and its caller. Tell children in their prompt to record open questions and keep working with a documented default instead of calling question.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const permission = yield* Permission.Service
    const models = yield* Model.Service
    const subagents = yield* SubagentJob.Service

    const resolveModel = Effect.fn("SubagentTool.resolveModel")(function* (input: string) {
      const aliases = Config.latest(yield* config.entries(), "aliases")
      // An explicit subagent model request is execution, not discovery (#230): a
      // hidden model stays selectable here; only the picker list hides it.
      const catalog = yield* models.catalog()
      const exists = ({ providerID, modelID }: { providerID: string; modelID: string }) =>
        catalog.some((m) => m.providerID === providerID && m.id === modelID)
      let resolved = input
      try {
        resolved = ModelAlias.resolve(aliases, input, exists)
      } catch {}
      const ref = yield* Effect.try({
        try: () => Model.Ref.parse(resolved),
        catch: () =>
          new ToolFailure({
            message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
          }),
      })
      const model = catalog.find((model) => model.providerID === ref.providerID && model.id === ref.id)
      if (model === undefined) {
        const other = (yield* models.available(["image", "video", "decision"])).find(
          (model) => model.providerID === ref.providerID && model.id === ref.id,
        )
        return yield* new ToolFailure({
          message: other
            ? `Model "${ref.providerID}/${ref.id}" is ${other.type === "image" ? "an image" : other.type === "video" ? "a video" : "a decision"} model; subagents need a chat model. Use the models tool to find one.`
            : `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
        })
      }
      if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant))
        return yield* new ToolFailure({
          message:
            model.variants.length === 0
              ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
              : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
        })
      return ref
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                  ),
                )
              yield* SubagentDepth.assertWithinLimit(sessions, config, parent, fs).pipe(
                Effect.mapError((error) => new ToolFailure({ message: error.message })),
              )
              const agent = yield* agents.resolve(input.agent)
              if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              if (agent.mode === "primary")
                return yield* new ToolFailure({ message: `Agent ${input.agent} cannot run as a subagent` })
              yield* permission
                .assert({
                  action: name,
                  resources: [agent.id],
                  save: [agent.id],
                  ...Permission.invocation(context),
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

              const existing =
                input.sessionID === undefined
                  ? undefined
                  : yield* sessions
                      .get(input.sessionID)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                        ),
                      )
              if (existing !== undefined && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${existing.id} is not a child of the current session`,
                })
              // `auto` means no explicit choice: the default chain decides, and
              // that model is what governance checks at creation.
              const override =
                input.model === undefined || input.model === "auto" ? undefined : yield* resolveModel(input.model)
              // Continuing with a different agent switches the child, mirroring create semantics
              // where an explicit model wins over the agent's configured model, which wins over the inherited one.
              if (existing !== undefined) {
                const switched = existing.agent !== agent.id
                const model = override ?? (switched ? agent.model : undefined)
                // Sequential, agent first: the agent switch judges the model
                // the child will run against the incoming agent, and the
                // model switch that follows is then judged against that
                // incoming agent too, not the outgoing one.
                yield* Effect.gen(function* () {
                  if (switched)
                    yield* sessions.switchAgent({
                      sessionID: existing.id,
                      agent: agent.id,
                      ...(model === undefined ? {} : { model }),
                    })
                  if (model !== undefined) yield* sessions.switchModel({ sessionID: existing.id, model })
                }).pipe(
                  Effect.mapError((error) =>
                    error._tag === "ModelGovernance.DeniedError"
                      ? new ToolFailure({ message: error.message })
                      : new ToolFailure({ message: `Failed to switch subagent session: ${existing.id}`, error }),
                  ),
                )
              }

              const model = override ?? agent.model ?? parent.model
              const child =
                existing ??
                (yield* sessions
                  .create({
                    parentID: context.sessionID,
                    title: input.description,
                    agent: agent.id,
                    model,
                    ...(override !== undefined || input.force !== undefined
                      ? {
                          subagentOverride: {
                            ...(override !== undefined ? { model: override } : {}),
                            ...(input.force !== undefined ? { force: input.force } : {}),
                          },
                        }
                      : {}),
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      error._tag === "ModelGovernance.DeniedError"
                        ? new ToolFailure({ message: error.message })
                        : new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                    ),
                  ))

              yield* McpxSubagent.initializeSubagentSession({
                parentSessionID: context.sessionID,
                childID: child.id,
              }).pipe(Effect.catch(() => Effect.void))

              // A child that is not draining yet must be admitted without waking: the job's resume
              // owns the start, so the period cannot run before its boundary is registered.
              const running =
                existing !== undefined &&
                ((yield* sessions.active).has(existing.id) || (yield* jobs.get(existing.id))?.status === "running")
              yield* context.progress({ sessionID: child.id, status: "running" })

              yield* sessions
                .prompt({
                  sessionID: child.id,
                  text:
                    existing === undefined
                      ? ["You are a subagent spawned by another session.", input.prompt].join("\n")
                      : input.prompt,
                  ...(running ? {} : { resume: false }),
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error }),
                  ),
                )

              const recovery = {
                kind: "subagent" as const,
                parentSessionID: context.sessionID,
                childSessionID: child.id,
                agent: agent.name,
                description: input.description,
                stopPolicy: input.stopPolicy ?? ("independent" as const),
              }
              // Background launches are allowed at any depth; each background child
              // reports to its direct parent, so nested background work reports back
              // to the subagent that launched it.
              if (input.background === true) {
                yield* subagents.start(recovery)
                return backgroundResult(child.id)
              }

              // Foreground: the call blocks until the child finishes. A job moved to the background meanwhile reports
              // like a background launch.
              yield* subagents.start(recovery, { background: false })
              const result = yield* jobs.block({ id: child.id, sessionID: context.sessionID }).pipe(
                Effect.onInterrupt(() =>
                  Effect.all(
                    [
                      sessions.interrupt(child.id),
                      jobs.cancel(child.id),
                      McpxSubagent.releaseSubagentSession(child.id).pipe(Effect.catch(() => Effect.void)),
                    ],
                    { discard: true },
                  ),
                ),
              )
              if (result?.type === "backgrounded") return backgroundResult(child.id)
              yield* McpxSubagent.releaseSubagentSession(child.id).pipe(Effect.catch(() => Effect.void))
              // Failure surfaces keep the sessionID visible so the model can continue the child.
              if (result?.info.status === "error")
                return yield* new ToolFailure({
                  message: `Subagent failed (sessionID: ${child.id}): ${result.info.error ?? "unknown error"}`,
                })
              if (result?.info.status === "cancelled")
                return yield* new ToolFailure({ message: `Subagent cancelled (sessionID: ${child.id})` })
              const messages = yield* sessions
                .messages({ sessionID: child.id, order: "desc", limit: 20 })
                .pipe(Effect.orElseSucceed(() => []))
              const assistant = messages.find(
                (message) =>
                  message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
              )
              return {
                sessionID: child.id,
                status: "completed" as const,
                output: SubagentCompletion.text(assistant) || SubagentCompletion.NO_TEXT,
              }
            }).pipe(
              Effect.map((output) => ({
                output,
                content:
                  output.status === "completed"
                    ? `<subagent sessionID="${output.sessionID}" state="completed">\n${output.output}\n</subagent>`
                    : output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        if (event.tool !== name || !Predicate.isObject(event.input)) return
        if (event.input.model !== "" && event.input.sessionID !== "") return
        const input = { ...event.input }
        if (input.model === "") delete input.model
        if (input.sessionID === "") delete input.sessionID
        event.input = input
      }),
    )

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        const selected = yield* agents.resolve(event.agent)
        if (!selected) return
        const available = (yield* agents.list())
          .filter(
            (agent) =>
              agent.mode !== "primary" &&
              !agent.hidden &&
              Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        if (available.length === 0) return
        const depthLine = yield* Effect.gen(function* () {
          const current = yield* sessions.get(event.sessionID)
          return SubagentDepth.formatDepthLine(yield* SubagentDepth.readout(sessions, config, current, fs))
        }).pipe(Effect.orElseSucceed(() => undefined))
        tool.description = [
          tool.description,
          "",
          "Available subagents:",
          ...available.map(
            (agent) =>
              `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
          ),
          ...(depthLine === undefined ? [] : ["", depthLine]),
        ].join("\n")
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
