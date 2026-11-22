import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import {
  isPermissionNotFoundError,
  type FormInfo,
  type JobInfo,
  type PermissionRequest,
} from "@opencode/client/promise"
import { abort } from "@opencode/util/abort"
import { useParams } from "@solidjs/router"
import { showToast } from "@/shell/notifications/toast"
import { useServerSDK } from "@/runtime/server/client"
import { useLanguage } from "@/runtime/i18n/language"
import { projectSettingsKey, useSettings } from "@/settings/model"
import { useWorkspaceLocation } from "@/workspaces/location"
import {
  sessionFormRequest,
  sessionMayHoldRequests,
  sessionPermissionRequest,
  sessionTreeIDs,
} from "@/session/requests/session-request-tree"
import { createWebSearchRequest } from "./websearch"
import { createSessionBackground, mergeJobList } from "@/session/requests/background"
import { createSteerBackground } from "@/session/requests/steer-background"
import { useData, useServer } from "@/runtime/server/current"
import { needsUser } from "./auto-approve-machine"
import {
  INITIAL_PERMISSION_REPLY_STATE,
  isPermissionReplied,
  isPermissionResponding,
  PERMISSION_REPLIED_LIMIT,
  transitionPermissionReply,
  type PermissionDecision,
  type PermissionReplyEffect,
  type PermissionReplyEvent,
  type PermissionReplyState,
} from "./permission-machine"

export function createSessionRequestModel() {
  const params = useParams()
  const sdk = useWorkspaceLocation()
  const serverSDK = useServerSDK()
  const data = useData()
  const autoApprove = useServer().ctx.autoApprove
  const language = useLanguage()
  const settings = useSettings()
  // Manual replies from the dock, by request. Requests nobody answered from this dock have no entry.
  const [replies, setReplies] = createSignal<Readonly<Record<string, PermissionReplyState>>>({})
  const runs = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>()
  const replyState = (requestID: string) => replies()[requestID] ?? INITIAL_PERMISSION_REPLY_STATE

  const stop = serverSDK.event.on("permission.replied", (event) => dispatch(event.data.requestID, { type: "resolved" }))

  onCleanup(() => {
    stop()
    Object.keys(untrack(replies)).forEach((id) => dispatch(id, { type: "disposed" }))
  })

  createEffect(() => {
    if (!params.id || serverSDK.connection.status() !== "connected") return
    void data.shell.sync({ directory: sdk().directory }).catch(() => undefined)
  })

  // Permissions and forms are per Session, so each one in the tree that may hold a request is read. Comparing by value
  // keeps every session update in a large subagent tree from re-requesting them.
  const requestSessions = createMemo(
    () =>
      sessionTreeIDs(data.session.list(), params.id).filter(
        (id) => id === params.id || sessionMayHoldRequests(data, id),
      ),
    [],
    { equals: (a, b) => a.join() === b.join() },
  )

  // Asks from subagents at any depth surface here, including ones raised before this client saw them.
  createEffect(() => {
    if (serverSDK.connection.status() !== "connected") return
    void Promise.all(
      requestSessions().flatMap((sessionID) => [
        data.session.permission.sync(sessionID),
        data.session.form.sync(sessionID),
      ]),
    ).catch(() => undefined)
  })

  const formRequest = createMemo((): FormInfo | undefined => {
    return sessionFormRequest(data.session.list(), data.session.form.list, params.id)
  })

  // MCP elicitations are owned by the Location rather than a Session, so they are listed per Location.
  const location = createMemo(() => {
    const id = params.id

    return id ? data.session.get(id)?.location : undefined
  })

  createEffect(() => {
    const ref = location()

    if (!ref || serverSDK.connection.status() !== "connected") return
    void data.session.form.sync("global", ref).catch(() => undefined)
  })

  const websearch = createWebSearchRequest({
    owner: () => params.id,
    connected: () => serverSDK.connection.status() === "connected",
    request: () => {
      const form = formRequest()

      return form?.metadata?.kind === "websearch.provider" ? form : undefined
    },
    providers: async (sessionID) => {
      const session = data.session.get(sessionID) ?? (await serverSDK.api.session.get({ sessionID }))

      const result = await serverSDK.api.websearch.providers({
        location: { directory: session.location.directory },
      })

      return result.data.map((provider) => ({ value: provider.id, label: provider.name }))
    },
    reply: (input) => data.session.form.reply(input),
    events: serverSDK.event,
  })

  const questionRequest = createMemo(() => {
    if (websearch.request()) return
    const form = formRequest()

    return form?.metadata?.kind === "question" ? form : undefined
  })

  const elicitationRequest = createMemo(() => {
    if (websearch.request() || questionRequest()) return
    const form = formRequest()

    if (form?.metadata?.kind === "mcp-elicitation") return form

    const ref = location()

    if (!ref) return

    return data.session.form.list("global", ref)?.find((item) => item.metadata?.kind === "mcp-elicitation")
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    const id = params.id

    const enabled = settings.permissions.autoApproves(
      projectSettingsKey(serverSDK.scope, id ? data.session.get(id)?.projectID : undefined),
    )

    return sessionPermissionRequest(
      data.session.list(),
      data.session.permission.list,
      id,
      (item) => needsUser(autoApprove.state(item.id), enabled) && !isPermissionReplied(replyState(item.id)),
    )
  })

  // A docked ask can come from any session in the viewed tree; name the asker when it is not the
  // viewed session itself, falling back to a generic label until that session has loaded.
  const requestSource = (sessionID: string) => {
    const id = params.id

    if (!id || sessionID === id) return undefined

    const title = data.session.get(sessionID)?.title

    return title ? language.t("session.request.from", { title }) : language.t("session.request.fromSubagent")
  }

  const permissionSource = createMemo(() => {
    const request = permissionRequest()

    return request ? requestSource(request.sessionID) : undefined
  })

  const questionSource = createMemo(() => {
    const request = questionRequest()

    return request ? requestSource(request.sessionID) : undefined
  })

  const blocked = createMemo(() => {
    const id = params.id

    if (!id) return false

    return !!permissionRequest() || !!questionRequest() || !!elicitationRequest() || !!websearch.request()
  })

  const primary = () => {
    const id = params.id

    return !!id && !data.session.get(id)?.parentID
  }

  // Running jobs in the session's tree: listed once when the session opens or the connection returns, then kept by
  // job.updated events.
  const [jobs, setJobs] = createSignal<ReadonlyMap<string, JobInfo>>(new Map())
  const runningJobs = createMemo(() => [...jobs().values()])
  // Events seen while the latest list request is in flight, applied over its response.
  let jobUpdates: Map<string, JobInfo> | undefined

  const stopJobs = serverSDK.event.on("experimental.job.updated", (event) => {
    const info = event.data.info

    jobUpdates?.set(info.id, info)

    setJobs((previous) => {
      if (info.status === "running") return new Map(previous).set(info.id, info)

      if (!previous.has(info.id)) return previous

      const next = new Map(previous)
      next.delete(info.id)

      return next
    })
  })

  onCleanup(stopJobs)

  // The running menu belongs to the whole tree: inside a subagent it is rooted at the tree's root, so a
  // grandchild still sees the root's other subagents, not only its parent's.
  const owner = createMemo(() => {
    const id = params.id

    if (!id) return

    return data.session.root(id)
  })

  // A subagent view needs the root's full session family and messages to render running work for the whole tree.
  createEffect(
    on(
      () => [params.id, serverSDK.connection.status()] as const,
      ([id, status]) => {
        if (!id || status !== "connected") return
        void data.session
          .sync(id, { children: true })
          .then(() => {
            const rootID = owner()
            if (!rootID || rootID === id) return
            return data.session
              .sync(rootID, { children: true })
              .then(() => data.session.sync(rootID, { children: true }))
              .then(() => data.session.message.sync(rootID))
          })
          .catch(() => undefined)
      },
    ),
  )

  // The running menu walks the owner's whole tree, so the owner's family loads whenever a subagent
  // view makes a different session the owner. Landing directly on a descendant otherwise syncs only
  // that session's own descendants plus the ancestors the titlebar walk fetches, and the root's other
  // subagents never arrive. This is separate from the message load above: that load's already-loaded
  // guard must not skip the family, and the family sync's own key dedupes repeat runs.
  createEffect(
    on(
      () => [owner(), params.id, serverSDK.connection.status()] as const,
      ([rootID, id, status]) => {
        if (!rootID || rootID === id || status !== "connected") return
        void data.session.sync(rootID, { children: true }).catch(() => undefined)
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const sessionID = owner()

    if (!sessionID || serverSDK.connection.status() !== "connected") return
    const updates = new Map<string, JobInfo>()
    jobUpdates = updates
    void serverSDK.api.experimental.job
      .list({ sessionID, descendants: true, status: "running" })
      .then((list) => {
        if (jobUpdates === updates && owner() === sessionID) setJobs(mergeJobList(list, updates))
      })
      .catch(() => undefined)
      .finally(() => {
        if (jobUpdates === updates) jobUpdates = undefined
      })
  })

  const running = createSessionBackground({
    sessionID: owner,
    messages: data.session.message.list,
    sessions: data.session.list,
    status: data.session.status,
    shells: () => data.shell.list({ directory: sdk().directory }),
    jobs: runningJobs,
  })

  // Moving to the background and the plugins' background list stay with the primary session's own work.
  const blocking = createMemo(() => (primary() ? running.blocking() : []))
  const tasks = createMemo(() => (primary() ? running.tasks() : []))
  const scripts = createMemo(() => (primary() ? running.scripts() : []))

  const cancelJob = (id: string) => serverSDK.api.experimental.job.cancel({ id })

  const moveToBackground = async () => {
    if (!primary()) return
    const sessionID = params.id

    if (!sessionID) return
    await serverSDK.api.session.background({ sessionID }).catch((error) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const steer = createSteerBackground({
    sessionID: () => params.id,
    blocking,
    move: (sessionID) => serverSDK.api.session.background({ sessionID }),
  })

  // The dock keeps the last request mounted while it closes, so its buttons follow that request's reply.
  const lastPermissionID = createMemo<string | undefined>((previous) => permissionRequest()?.id ?? previous)

  const permissionResponding = createMemo(() => {
    const id = lastPermissionID()

    return !!id && isPermissionResponding(replyState(id))
  })

  const decide = (decision: PermissionDecision) => {
    const perm = permissionRequest()

    if (!perm) return
    dispatch(perm.id, { type: "decide", sessionID: perm.sessionID, decision })
  }

  function dispatch(requestID: string, event: PermissionReplyEvent) {
    const state = untrack(() => replyState(requestID))
    const result = transitionPermissionReply(state, event)

    if (result.state !== state) setReplies((current) => pruneReplied({ ...current, [requestID]: result.state }))

    result.effects.forEach((effect) => execute(requestID, effect))
  }

  function execute(requestID: string, effect: PermissionReplyEffect) {
    if (effect.type === "toast-failed") {
      showToast({ title: language.t("common.requestFailed"), description: effect.error })

      return
    }

    if (effect.type === "abort") {
      const run = runs.get(requestID)
      runs.delete(requestID)
      clearTimeout(run?.timer)
      abort(run?.controller)

      return
    }

    const controller = new AbortController()

    runs.set(requestID, {
      controller,
      timer: setTimeout(
        () => dispatch(requestID, { type: "reply.timed-out", attempt: effect.attempt }),
        effect.timeoutMs,
      ),
    })
    // A request another client or the TUI already answered counts as replied.
    void serverSDK.api.permission
      .reply({ sessionID: effect.sessionID, requestID, decision: effect.decision }, { signal: controller.signal })
      .then(
        () => dispatch(requestID, { type: "reply.succeeded", attempt: effect.attempt }),
        (error) =>
          dispatch(
            requestID,
            isPermissionNotFoundError(error)
              ? { type: "reply.succeeded", attempt: effect.attempt }
              : {
                  type: "reply.failed",
                  attempt: effect.attempt,
                  error: error instanceof Error ? error.message : String(error),
                },
          ),
      )
  }

  return {
    blocked,
    questionRequest,
    questionSource,
    elicitationRequest,
    websearch,
    permissionRequest,
    permissionSource,
    permissionResponding,
    background: {
      blocking,
      tasks,
      scripts,
      cancelJob,
      move: moveToBackground,
      steer,
    },
    decide,
  }
}

export type SessionRequestModel = ReturnType<typeof createSessionRequestModel>

// Replied entries only hide requests until `permission.replied` removes them, so the oldest can go.
function pruneReplied(replies: Readonly<Record<string, PermissionReplyState>>) {
  const replied = Object.entries(replies).flatMap(([id, state]) => (isPermissionReplied(state) ? [id] : []))

  if (replied.length <= PERMISSION_REPLIED_LIMIT) return replies
  const drop = new Set(replied.slice(0, replied.length - PERMISSION_REPLIED_LIMIT))

  return Object.fromEntries(Object.entries(replies).filter(([id]) => !drop.has(id)))
}
