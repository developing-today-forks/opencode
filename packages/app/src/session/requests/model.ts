import { createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"
import type { FormInfo, PermissionRequest } from "@opencode/client/promise"
import { useParams } from "@solidjs/router"
import { showToast } from "@/shell/notifications/toast"
import { useServerSDK } from "@/runtime/server/client"
import { useLanguage } from "@/runtime/i18n/language"
import { projectSettingsKey, useSettings } from "@/settings/model"
import { useWorkspaceLocation } from "@/workspaces/location"
import { sessionPermissionRequest, sessionFormRequest, sessionTreeIDs } from "@/session/requests/session-request-tree"
import { createWebSearchRequest } from "./websearch"
import { createSessionBackground } from "@/session/requests/background"
import { useData } from "@/runtime/server/current"

export function createSessionRequestModel() {
  const params = useParams()
  const sdk = useWorkspaceLocation()
  const serverSDK = useServerSDK()
  const data = useData()
  const language = useLanguage()
  const settings = useSettings()
  createEffect(() => {
    if (!params.id || serverSDK.connection.status() !== "connected") return
    void data.shell.sync({ directory: sdk().directory }).catch(() => undefined)
  })
  // Asks from subagents at any depth surface here, including ones raised before this client saw them.
  createEffect(() => {
    const id = params.id

    if (!id || serverSDK.connection.status() !== "connected") return
    void Promise.all(
      sessionTreeIDs(data.session.list(), id).flatMap((sessionID) => [
        data.session.permission.sync(sessionID),
        data.session.form.sync(sessionID),
      ]),
    ).catch(() => undefined)
  })

  const formRequest = createMemo((): FormInfo | undefined => {
    return sessionFormRequest(data.session.list(), data.session.form.list, params.id)
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

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    const id = params.id

    const project = projectSettingsKey(serverSDK.scope, id ? data.session.get(id)?.projectID : undefined)

    if (settings.permissions.autoApproves(project)) return

    return sessionPermissionRequest(data.session.list(), data.session.permission.list, id)
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

    return !!permissionRequest() || !!questionRequest() || !!websearch.request()
  })

  const primary = () => {
    const id = params.id

    return !!id && !data.session.get(id)?.parentID
  }

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

  const running = createSessionBackground({
    sessionID: owner,
    messages: data.session.message.list,
    sessions: data.session.list,
    status: data.session.status,
    shells: () => data.shell.list({ directory: sdk().directory }),
  })

  // Moving to the background and the extensions' background list stay with the primary session's own work.
  const blocking = createMemo(() => (primary() ? running.blocking() : []))
  const tasks = createMemo(() => (primary() ? running.tasks() : []))

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

  const [store, setStore] = createStore<{ responding: string | undefined }>({ responding: undefined })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()

    if (!perm) return false

    return store.responding === perm.id
  })

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()

    if (!perm) return

    if (store.responding === perm.id) return

    setStore("responding", perm.id)
    serverSDK.api.permission
      .reply({ sessionID: perm.sessionID, requestID: perm.id, decision: response })
      .catch((error) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        setStore("responding", (id) => (id === perm.id ? undefined : id))
      })
  }

  return {
    blocked,
    questionRequest,
    questionSource,
    websearch,
    permissionRequest,
    permissionSource,
    permissionResponding,
    background: {
      blocking,
      tasks,
      running: { sessionID: owner, blocking: running.blocking, tasks: running.tasks },
      move: moveToBackground,
    },
    decide,
  }
}

export type SessionRequestModel = ReturnType<typeof createSessionRequestModel>
