import { describe, expect, test } from "bun:test"
import { SessionFleetContext } from "../src/session/fleet-context.js"
import { SessionSchema } from "../src/session/schema.js"

describe("session fleet context", () => {
  test("captures only allowlisted safe env values and represents absence", () => {
    const captured = SessionFleetContext.capture({
      FLEET_CTX_ID: "task-23795",
      FLEET_CTX_TASK_ID: "23795",
      FLEET_CTX_MODEL: "model key is rejected",
      API_KEY: "secret",
    })

    expect(captured).toEqual({ FLEET_CTX_ID: "task-23795", FLEET_CTX_TASK_ID: "23795" })
    expect(SessionFleetContext.capture({})).toEqual({})
  })

  test("carries the id into a child and extends the session chain", () => {
    const parentID = SessionSchema.ID.make("ses_parent")
    const childID = SessionSchema.ID.make("ses_child")
    SessionFleetContext.start({
      sessionID: parentID,
      environment: { FLEET_CTX_ID: "task-23795", FLEET_CTX_ANCESTRY: "muse" },
    })

    const child = SessionFleetContext.start({ sessionID: childID, parentID })

    expect(SessionFleetContext.id(childID)).toBe("task-23795")
    expect(child).toMatchObject({
      FLEET_CTX_ID: "task-23795",
      FLEET_CTX_OPENCODE_SESSION: childID,
      FLEET_CTX_OPENCODE_PARENT: parentID,
      FLEET_CTX_ANCESTRY: "muse/opencode/opencode",
    })
  })

  test("stamps session records and clears in-memory context at session end", () => {
    const sessionID = SessionSchema.ID.make("ses_end")
    SessionFleetContext.start({ sessionID, environment: { FLEET_CTX_ID: "task-23795" } })
    expect(SessionFleetContext.stamp(sessionID)).toEqual({ fleetCtxID: "task-23795" })

    SessionFleetContext.end(sessionID)

    expect(SessionFleetContext.stamp(sessionID)).toEqual({})
  })

  test("build defers registration until adopt, so a race loser never clobbers the winner", () => {
    const sessionID = SessionSchema.ID.make("ses_race")
    const winner = SessionFleetContext.start({ sessionID, environment: { FLEET_CTX_ID: "winner" } })

    // The loser builds its chain but never registers it: the map still holds the winner.
    const loser = SessionFleetContext.build({ sessionID, environment: { FLEET_CTX_ID: "loser" } })
    expect(SessionFleetContext.id(sessionID)).toBe("winner")

    SessionFleetContext.adopt(sessionID, winner)
    expect(SessionFleetContext.id(sessionID)).toBe("winner")
    expect(loser.FLEET_CTX_ID).toBe("loser")

    SessionFleetContext.end(sessionID)
  })
})
