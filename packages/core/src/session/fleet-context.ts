export * as SessionFleetContext from "./fleet-context.js"

import type { SessionSchema } from "./schema.js"

const names = [
  "FLEET_CTX_ID",
  "FLEET_CTX_ORIGIN",
  "FLEET_CTX_HOST",
  "FLEET_CTX_USER",
  "FLEET_CTX_PID",
  "FLEET_CTX_ANCESTRY",
  "FLEET_CTX_TASK_ID",
  "FLEET_CTX_TASK_NAME",
  "FLEET_CTX_MUSE_SESSION",
  "FLEET_CTX_MODEL",
  "FLEET_CTX_OPENCODE_SESSION",
  "FLEET_CTX_OPENCODE_PARENT",
  "FLEET_CTX_SCHEDULED_JOB",
  "FLEET_CTX_MESSAGE_ID",
  "FLEET_CTX_GIT_HEADS",
  "FLEET_CTX_INVOCATION",
] as const

export type Environment = Readonly<Partial<Record<(typeof names)[number], string>>>

const sessions = new Map<SessionSchema.ID, Environment>()
const safeValue = /^[A-Za-z0-9._:@/+=,~-]{1,256}$/

export function capture(environment: NodeJS.ProcessEnv = process.env): Environment {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = environment[name]
      return value !== undefined && safeValue.test(value) ? [[name, value]] : []
    }),
  ) as Environment
}

/** Build the chain for a session without registering it. Registration happens
 * only after the session's creation event wins, so a concurrent create that
 * loses the projection race never overwrites the winner's registered context. */
export function build(input: {
  sessionID: SessionSchema.ID
  parentID?: SessionSchema.ID
  environment?: Environment
}): Environment {
  const parent = input.parentID ? sessions.get(input.parentID) : undefined
  const current = parent ?? input.environment ?? capture()
  const ancestry = current.FLEET_CTX_ANCESTRY?.split("/") ?? []
  return {
    ...current,
    FLEET_CTX_OPENCODE_SESSION: input.sessionID,
    ...(input.parentID ? { FLEET_CTX_OPENCODE_PARENT: input.parentID } : {}),
    FLEET_CTX_ANCESTRY: [...ancestry, "opencode"].join("/"),
  }
}

/** Register a prebuilt chain (see `build`). The caller must own the session. */
export function adopt(sessionID: SessionSchema.ID, chain: Environment): Environment {
  sessions.set(sessionID, chain)
  return chain
}

/** Snapshot the process context once, inherit it in children, and make this session the newest chain link. */
export function start(input: {
  sessionID: SessionSchema.ID
  parentID?: SessionSchema.ID
  environment?: Environment
}): Environment {
  return adopt(input.sessionID, build(input))
}

export function id(sessionID: SessionSchema.ID): string | undefined {
  return sessions.get(sessionID)?.FLEET_CTX_ID
}

export function stamp(sessionID: SessionSchema.ID) {
  const contextID = id(sessionID)
  return contextID === undefined ? {} : { fleetCtxID: contextID }
}

export function end(sessionID: SessionSchema.ID) {
  sessions.delete(sessionID)
}
