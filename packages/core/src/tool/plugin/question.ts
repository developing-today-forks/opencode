export * as QuestionTool from "./question.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import { Form } from "../../form.js"
import { Permission } from "../../permission.js"
import { Question } from "@opencode/schema/question"
import { Session } from "../../session.js"
import { McpxSubagent } from "../plugin/mcpx-subagent.js"

export const name = "question"

export const description = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- A "Type your own answer" option is added automatically; don't include a separate option for free form answers
- Set \`multiple: true\` to allow selecting more than one option
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label
- When running in a subsession, the parent session is automatically notified that a question is pending`

export const Input = Schema.Struct({
  questions: Schema.Array(Question.Prompt).check(Schema.isNonEmpty()).annotate({ description: "Questions to ask" }),
})

export const Output = Schema.Struct({
  answers: Schema.Array(Question.Answer),
})
export type Output = typeof Output.Type

export class CancelledError extends Schema.TaggedError<CancelledError>()("QuestionTool.CancelledError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export const toModelContent = (questions: ReadonlyArray<Question.Prompt>, answers: ReadonlyArray<Question.Answer>) => {
  const formatted = questions
    .map(
      (question, index) =>
        `"${question.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`,
    )
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

export const Plugin = {
  id: "opencode.tool.question",
  effect: Effect.fn("QuestionTool.Plugin")(function* (ctx: Context) {
    const forms = yield* Form.Service
    const permission = yield* Permission.Service
    const session = yield* Session.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            permission
              .assert({
                action: "question",
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Permission denied: question", error })),
                Effect.tap(() => {
                  // Notify parent session that a question is pending when running in a subsession
                  return Effect.sync(() => {
                    const lease = McpxSubagent.getLease(context.sessionID)
                    if (lease) {
                      session.synthetic({
                        sessionID: lease.parentSessionID,
                        description: "Question pending in subsession",
                        text: `<question-pending in-subsession="${context.sessionID}">
A question is pending in a subsession. Please answer it to unblock progress.
</question-pending>`,
                        metadata: {
                          source: "subsession-question",
                          childSessionID: context.sessionID,
                          parentSessionID: lease.parentSessionID,
                        },
                      }).pipe(Effect.catch(() => Effect.void))
                    }
                  })
                }),
                Effect.andThen(
                  forms
                    .ask({
                      sessionID: context.sessionID,
                      title: "Questions",
                      metadata: {
                        kind: "question",
                        tool: { messageID: context.messageID, id: context.id },
                      },
                      fields: [
                        toField(input.questions[0], 0),
                        ...input.questions.slice(1).map((question, index) => toField(question, index + 1)),
                      ],
                    })
                    .pipe(Effect.orDie),
                ),
                Effect.flatMap((state) => {
                  // Deliberate defect tunnel (see Permission.assert): a dismissal must dodge
                  // leaf `mapError` blankets so it never becomes model-facing tool output; it
                  // resurfaces as a typed failure at SessionModelRequest.executeTool.
                  // A dismissal with a message (e.g. from a non-interactive client) is ordinary
                  // model-facing feedback: the model continues instead of the step ending.
                  if (state.status === "cancelled" && state.message !== undefined)
                    return Effect.fail(new ToolFailure({ message: state.message }))
                  if (state.status === "cancelled") return Effect.die(new CancelledError())
                  const output = {
                    answers: input.questions.map((_, index): Question.Answer => {
                      const value = state.answer[`q${index}`]
                      if (value === undefined) return []
                      if (typeof value === "object") return Array.from(value)
                      return [String(value)]
                    }),
                  }
                  return Effect.succeed({
                    output,
                    content: toModelContent(input.questions, output.answers),
                    metadata: { answers: output.answers },
                  })
                }),
              ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

function toField(question: Question.Prompt, index: number): Form.Field {
  return {
    key: `q${index}`,
    title: question.header,
    description: question.question,
    type: question.multiple === true ? "multiselect" : "string",
    options: question.options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description,
    })),
    custom: true,
  }
}
