import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionEvent } from "../src/session-event.js"

const created = {
  sessionID: "ses_fleet",
  projectID: "global",
  location: { directory: "/tmp/fleet" },
  slug: "fleet",
  version: "0.0.0",
}

const executionStarted = { sessionID: "ses_fleet" }

const toolCalled = {
  sessionID: "ses_fleet",
  assistantMessageID: "msg_fleet",
  id: "call_1",
  input: {},
  executed: true,
}

const cases = [
  { name: "session.created", schema: SessionEvent.Created.data, base: created },
  { name: "session.execution.started", schema: SessionEvent.Execution.Started.data, base: executionStarted },
  { name: "session.tool.called", schema: SessionEvent.Tool.Called.data, base: toolCalled },
] as const

for (const { name, schema, base } of cases) {
  test(`${name} retains a present fleetCtxID and round trips`, () => {
    const decode = Schema.decodeUnknownSync(schema)
    const encode = Schema.encodeSync(schema)
    const input = { ...base, fleetCtxID: "task-23795" }

    expect(decode(input)).toMatchObject({ fleetCtxID: "task-23795" })
    expect(encode(decode(input))).toMatchObject({ fleetCtxID: "task-23795" })
  })

  test(`${name} accepts an absent fleetCtxID and omits it on encode`, () => {
    const decode = Schema.decodeUnknownSync(schema)
    const encode = Schema.encodeSync(schema)

    expect(decode(base)).not.toHaveProperty("fleetCtxID")
    // stamp() omits the key when there is no context, but a Type-side value
    // may still carry an explicit undefined: encoding must drop it.
    expect(encode({ ...decode(base), fleetCtxID: undefined })).not.toHaveProperty("fleetCtxID")
  })
}
