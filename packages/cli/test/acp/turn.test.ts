import { describe, expect, test } from "bun:test"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { ACPElicitation } from "../../src/acp/elicitation"
import {
  assistantMessage,
  childCreated,
  delivered,
  durableEvent,
  ephemeralEvent,
  makeSession,
  permissionAsked,
  startSession,
  startWire,
  succeeded,
  textDelta,
  toolCalled,
  toolStarted,
  toolSucceeded,
  turn,
} from "./wire-fixture"

const grandchild = {
  "opencode/child-session": { id: "ses_grandchild", parentID: "ses_child", depth: 2, title: "Deeper" },
}

describe("acp turn events over the wire", () => {
  test.each([
    {
      childSessionUpdates: false,
      parent: [
        {
          sessionUpdate: "tool_call",
          toolCallId: "ses_grandchild:call_read",
          title: "Deeper: read",
          _meta: grandchild,
        },
        { sessionUpdate: "tool_call_update", toolCallId: "ses_grandchild:call_read", status: "in_progress" },
        { sessionUpdate: "tool_call_update", toolCallId: "ses_grandchild:call_read", status: "completed" },
      ],
      child: [],
    },
    {
      childSessionUpdates: true,
      parent: [],
      child: [
        { childSessionId: "ses_child", depth: 1, type: "status", status: "created" },
        { childSessionId: "ses_child", type: "status", status: "running" },
        {
          childSessionId: "ses_grandchild",
          parentSessionId: "ses_child",
          depth: 2,
          title: "Deeper",
          status: "created",
        },
        {
          childSessionId: "ses_grandchild",
          update: { sessionUpdate: "tool_call", toolCallId: "ses_grandchild:call_read" },
        },
        { childSessionId: "ses_grandchild", update: { sessionUpdate: "tool_call_update", status: "in_progress" } },
        { childSessionId: "ses_grandchild", update: { sessionUpdate: "tool_call_update", status: "completed" } },
        { childSessionId: "ses_grandchild", type: "status", status: "completed" },
        { childSessionId: "ses_background", type: "status", status: "created" },
        { childSessionId: "ses_child", type: "status", status: "completed" },
        { childSessionId: "ses_background", type: "status", status: "running" },
        { childSessionId: "ses_background", type: "update", update: { sessionUpdate: "agent_message_chunk" } },
        { childSessionId: "ses_background", type: "status", status: "completed" },
      ],
    },
  ])(
    "shows nested and background child work and keeps routing its permissions after the prompt (child capability: $childSessionUpdates)",
    async (row) => {
      await using acp = await startSession({
        capabilities: { childSessionUpdates: row.childSessionUpdates },
        onPrompt: ({ sessionID, id }) =>
          acp.server.prompts.length > 1
            ? turn(sessionID, id)
            : turn(
                sessionID,
                id,
                childCreated("ses_child", sessionID, "Explore code"),
                durableEvent("session.execution.started", { sessionID: "ses_child" }),
                childCreated("ses_grandchild", "ses_child", "Deeper"),
                toolStarted("ses_grandchild", "call_read", "read"),
                toolCalled("ses_grandchild", "call_read", { path: "/workspace/src/index.ts" }),
                permissionAsked("ses_grandchild", "perm_child", {
                  action: "read",
                  source: { type: "tool", messageID: "msg_child", id: "call_read" },
                }),
                toolSucceeded("ses_grandchild", "call_read", {}, "source"),
                succeeded("ses_grandchild"),
                childCreated("ses_background", sessionID, "Research"),
                succeeded("ses_child"),
              ),
        permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
      })

      expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")
      const responded = turnUpdates(acp.updates).length
      acp.server.send(
        durableEvent("session.execution.started", { sessionID: "ses_background" }),
        permissionAsked("ses_background", "perm_background", {
          action: "read",
          metadata: { path: "/workspace/notes.md" },
        }),
        textDelta("ses_background", "msg_background", "late"),
        succeeded("ses_background"),
        // Woken again later, the child still asks the client.
        permissionAsked("ses_background", "perm_after_end", { action: "read" }),
      )
      await acp.until(() => acp.server.replies.length === 3, "child permission replies")
      expect(turnUpdates(acp.updates).slice(responded)).toEqual([])
      expect((await acp.prompt(acp.sessionId, "again")).stopReason).toBe("end_turn")

      expect(turnUpdates(acp.updates).map((item) => item.update)).toMatchObject(row.parent)
      expect(acp.childUpdates).toMatchObject(row.child)
      expect(acp.permissions).toMatchObject([
        {
          sessionId: acp.sessionId,
          toolCall: {
            toolCallId: "ses_grandchild:call_read",
            title: "Deeper: /workspace/src/index.ts",
            _meta: grandchild,
          },
        },
        {
          sessionId: acp.sessionId,
          toolCall: {
            toolCallId: "ses_background:perm_background",
            title: "Research: /workspace/notes.md",
            _meta: {
              "opencode/child-session": { id: "ses_background", parentID: acp.sessionId, depth: 1, title: "Research" },
            },
          },
        },
        {
          sessionId: acp.sessionId,
          toolCall: { toolCallId: "ses_background:perm_after_end", title: "Research" },
        },
      ])
      expect(acp.server.replies).toEqual([
        { sessionID: "ses_grandchild", requestID: "perm_child", decision: "once" },
        { sessionID: "ses_background", requestID: "perm_background", decision: "once" },
        { sessionID: "ses_background", requestID: "perm_after_end", decision: "once" },
      ])
    },
  )

<<<<<<< HEAD
  test("follows a child continued in a later prompt and the subagents it launches", async () => {
    await using acp = await startSession({
      onPrompt: ({ sessionID, id }) =>
        acp.server.prompts.length > 1
          ? turn(
              sessionID,
              id,
              // No `session.created` this time: the child exists from the first prompt.
              durableEvent("session.execution.started", { sessionID: "ses_child" }),
              childCreated("ses_grandchild", "ses_child", "Deeper"),
              toolStarted("ses_grandchild", "call_read", "read"),
              permissionAsked("ses_grandchild", "perm_deep", {
                action: "read",
                metadata: { path: "/workspace/deep.md" },
              }),
              permissionAsked("ses_child", "perm_child", { action: "read", metadata: { path: "/workspace/child.md" } }),
              succeeded("ses_grandchild"),
              succeeded("ses_child"),
            )
          : turn(sessionID, id, childCreated("ses_child", sessionID, "Explore code"), succeeded("ses_child")),
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
    })
    acp.server.sessions.set("ses_child", {
      ...makeSession("ses_child"),
      parentID: acp.sessionId,
      title: "Explore code",
    })

    expect((await acp.prompt(acp.sessionId, "start")).stopReason).toBe("end_turn")
    expect((await acp.prompt(acp.sessionId, "continue")).stopReason).toBe("end_turn")

    expect(turnUpdates(acp.updates).map((item) => item.update)).toContainEqual(
      expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "ses_grandchild:call_read" }),
    )
    expect(acp.permissions).toMatchObject([
      {
        toolCall: {
          toolCallId: "ses_grandchild:perm_deep",
          title: "Deeper: /workspace/deep.md",
          _meta: { "opencode/child-session": { id: "ses_grandchild", parentID: "ses_child", depth: 2 } },
        },
      },
      {
        toolCall: {
          toolCallId: "ses_child:perm_child",
          title: "Explore code: /workspace/child.md",
          _meta: {
            "opencode/child-session": { id: "ses_child", parentID: acp.sessionId, depth: 1, title: "Explore code" },
          },
        },
      },
    ])
    expect(acp.server.replies).toEqual([
      { sessionID: "ses_grandchild", requestID: "perm_deep", decision: "once" },
      { sessionID: "ses_child", requestID: "perm_child", decision: "once" },
    ])
  })

  test("asks the session's own permission when a background result wakes it after the prompt", async () => {
    await using acp = await startSession({ permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }) })

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")
    acp.server.send(
      durableEvent("session.execution.started", { sessionID: acp.sessionId }),
      permissionAsked(acp.sessionId, "perm_woken", { action: "read", metadata: { path: "/workspace/later.md" } }),
    )
    await acp.until(() => acp.server.replies.length === 1, "the woken session's permission reply")

    expect(acp.permissions).toMatchObject([
      { sessionId: acp.sessionId, toolCall: { toolCallId: "perm_woken", title: "/workspace/later.md" } },
    ])
    expect(acp.server.replies).toEqual([{ sessionID: acp.sessionId, requestID: "perm_woken", decision: "once" }])
  })

  test("asks an ask still open between prompts again when the next prompt starts, without answering it", async () => {
    await using acp = await startSession({
      // The first request stays open until OpenCode cancels it; the second is answered.
      permission: (_request, signal) =>
        acp.permissions.length > 1
          ? { outcome: { outcome: "selected", optionId: "once" } }
          : new Promise((resolve) =>
              signal.addEventListener("abort", () => resolve({ outcome: { outcome: "cancelled" } }), { once: true }),
            ),
    })

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")
    acp.server.send(permissionAsked(acp.sessionId, "perm_held", { action: "read" }))
    await acp.until(() => acp.permissions.length === 1, "the request between prompts")
    // Still pending on the server, so the next prompt lists it.
    acp.server.pending.permissions.push({ id: "perm_held", sessionID: acp.sessionId, action: "read", resources: ["*"] })

    expect((await acp.prompt(acp.sessionId, "again")).stopReason).toBe("end_turn")

    expect(acp.permissions.map((request) => request.toolCall.toolCallId)).toEqual(["perm_held", "perm_held"])
    expect(acp.server.replies).toEqual([{ sessionID: acp.sessionId, requestID: "perm_held", decision: "once" }])
  })

  test("asks pending permissions and questions from the tree when a prompt starts, and none from other trees", async () => {
    await using acp = await startSession({
      capabilities: { elicitation: true },
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
      elicitation: () => ({ action: "accept", content: { pm: "bun" } }),
    })
    acp.server.sessions.set("ses_child", {
      ...makeSession("ses_child"),
      parentID: acp.sessionId,
      title: "Explore code",
    })
    acp.server.sessions.set("ses_grandchild", {
      ...makeSession("ses_grandchild"),
      parentID: "ses_child",
      title: "Deeper",
    })
    acp.server.sessions.set("ses_other", makeSession("ses_other"))
    acp.server.pending.permissions.push(
      {
        id: "perm_deep",
        sessionID: "ses_grandchild",
        action: "read",
        resources: ["*"],
        metadata: { path: "/workspace/deep.md" },
      },
      { id: "perm_other", sessionID: "ses_other", action: "read", resources: ["*"] },
    )
    acp.server.pending.forms.push({
      id: "frm_pending",
      sessionID: "ses_child",
      title: "Which package manager?",
      metadata: { kind: "question" },
      fields: [{ key: "pm", title: "Package manager", type: "string", options: [{ value: "bun", label: "Bun" }] }],
    })

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")

    expect(acp.permissions).toMatchObject([
      {
        toolCall: {
          toolCallId: "ses_grandchild:perm_deep",
          title: "Deeper: /workspace/deep.md",
          _meta: {
            "opencode/child-session": { id: "ses_grandchild", parentID: "ses_child", depth: 2, title: "Deeper" },
          },
        },
      },
    ])
    expect(acp.elicitations).toMatchObject([
      { sessionId: acp.sessionId, message: "Explore code: Which package manager?" },
    ])
    // Its tool call was never sent, so the question names none.
    expect(acp.elicitations[0]).not.toHaveProperty("toolCallId")
    expect(acp.server.replies).toEqual([{ sessionID: "ses_grandchild", requestID: "perm_deep", decision: "once" }])
    expect(acp.server.repliedForms).toEqual([{ sessionID: "ses_child", formID: "frm_pending", answer: { pm: "bun" } }])
  })

  test("asks a loaded session's pending asks once its response is out", async () => {
    await using acp = await startWire({
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
      elicitation: () => ({ action: "accept", content: { pm: "bun" } }),
    })
    await acp.initialize({ elicitation: true })
    acp.server.sessions.set("ses_loaded", makeSession("ses_loaded"))
    acp.server.sessions.set("ses_child", { ...makeSession("ses_child"), parentID: "ses_loaded", title: "Explore code" })
    // The replay sends the running question's tool call before the load response.
    acp.server.messages.set("ses_loaded", [
      assistantMessage("msg_question", {
        content: [
          {
            type: "tool",
            id: "call_question",
            name: "question",
            time: { created: 2, ran: 2 },
            state: { status: "running", input: {}, metadata: {} },
          },
        ],
      }),
    ])
    acp.server.pending.permissions.push({
      id: "perm_waiting",
      sessionID: "ses_child",
      action: "read",
      resources: ["*"],
      metadata: { path: "/workspace/waiting.md" },
    })
    acp.server.pending.forms.push(pendingQuestion("ses_loaded", "frm_replayed", "call_question"))
    acp.server.pending.forms.push(pendingQuestion("ses_loaded", "frm_unseen", "call_unseen"))

    await acp.request("session/load", { sessionId: "ses_loaded", cwd: "/workspace", mcpServers: [] })
    await acp.until(
      () => acp.server.replies.length === 1 && acp.server.repliedForms.length === 2,
      "the pending permission and question replies",
    )

    expect(acp.permissions).toMatchObject([
      {
        sessionId: "ses_loaded",
        toolCall: { toolCallId: "ses_child:perm_waiting", title: "Explore code: /workspace/waiting.md" },
      },
    ])
    // Only the question whose tool call the replay sent points at it.
    expect(acp.elicitations).toMatchObject([{ sessionId: "ses_loaded", toolCallId: "call_question" }, {}])
    expect(acp.elicitations[1]).not.toHaveProperty("toolCallId")
  })

  test("names in an ask only a tool call the client received", async () => {
    await using acp = await startSession({
      capabilities: { elicitation: true },
      onPrompt: ({ sessionID, id }) => [
        // Before the prompt's delivery, so its tool call never reaches the client.
        toolStarted(sessionID, "call_early", "question"),
        delivered(sessionID, id),
        toolStarted(sessionID, "call_live", "question"),
        ephemeralEvent("form.created", { form: pendingQuestion(sessionID, "frm_early", "call_early") }),
        ephemeralEvent("form.created", { form: pendingQuestion(sessionID, "frm_live", "call_live") }),
        succeeded(sessionID),
      ],
      elicitation: () => ({ action: "accept", content: { pm: "bun" } }),
    })

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")

    expect(acp.elicitations).toMatchObject([{}, { toolCallId: "call_live" }])
    expect(acp.elicitations[0]).not.toHaveProperty("toolCallId")
  })

  test("links a pending permission to the tool call an earlier prompt sent", async () => {
    await using acp = await startSession({
      onPrompt: ({ sessionID, id }) =>
        acp.server.prompts.length > 1
          ? turn(sessionID, id)
          : turn(sessionID, id, toolStarted(sessionID, "call_shell", "shell")),
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
    })

    expect((await acp.prompt(acp.sessionId, "start")).stopReason).toBe("end_turn")
    acp.server.pending.permissions.push({
      id: "perm_listed",
      sessionID: acp.sessionId,
      action: "shell",
      resources: ["*"],
      source: { type: "tool", messageID: "msg_tools", id: "call_shell" },
    })
    expect((await acp.prompt(acp.sessionId, "again")).stopReason).toBe("end_turn")

    expect(acp.permissions).toMatchObject([{ toolCall: { toolCallId: "call_shell" } }])
  })

  test("retries a pending list and a parent lookup that fail once", async () => {
    const failed = new Set<string>()
    await using acp = await startSession({
      capabilities: { elicitation: true },
      fetch: (request) => {
        if (request.method !== "GET" || (request.path !== "/api/form" && request.path !== "/api/session/ses_child"))
          return undefined
        if (failed.has(request.path)) return undefined
        failed.add(request.path)
        return new Response(null, { status: 503 })
      },
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
      elicitation: () => ({ action: "accept", content: { pm: "bun" } }),
    })
    acp.server.sessions.set("ses_child", {
      ...makeSession("ses_child"),
      parentID: acp.sessionId,
      title: "Explore code",
    })
    acp.server.pending.permissions.push({ id: "perm_child", sessionID: "ses_child", action: "read", resources: ["*"] })
    acp.server.pending.forms.push(pendingQuestion(acp.sessionId, "frm_root", "call_question"))

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")

    expect(acp.server.replies).toEqual([{ sessionID: "ses_child", requestID: "perm_child", decision: "once" }])
    expect(acp.server.repliedForms).toEqual([{ sessionID: acp.sessionId, formID: "frm_root", answer: { pm: "bun" } }])
  })

  test("keeps scanning in the background for a pending ask it could not place", async () => {
    const failures = { left: 3 }
    await using acp = await startSession({
      // Every immediate retry fails; a later scan succeeds.
      fetch: (request) => {
        if (request.method !== "GET" || request.path !== "/api/session/ses_child" || failures.left === 0)
          return undefined
        failures.left--
        return new Response(null, { status: 503 })
      },
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
    })
    acp.server.sessions.set("ses_child", {
      ...makeSession("ses_child"),
      parentID: acp.sessionId,
      title: "Explore code",
    })
    acp.server.pending.permissions.push({ id: "perm_child", sessionID: "ses_child", action: "read", resources: ["*"] })

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")
    await acp.until(() => acp.server.replies.length === 1, "the rescanned permission reply")

    expect(acp.server.replies).toEqual([{ sessionID: "ses_child", requestID: "perm_child", decision: "once" }])
  })

  test("keeps following after a load replaces the attachment mid-prompt", async () => {
    await using acp = await startSession({
      // The prompt stays open until the test finishes it.
      onPrompt: ({ sessionID, id }) => [delivered(sessionID, id)],
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
    })

    const prompted = acp.prompt(acp.sessionId, "hello")
    await acp.until(() => acp.server.prompts.length === 1, "the prompt")
    await acp.request("session/load", { sessionId: acp.sessionId, cwd: "/workspace", mcpServers: [] })
    acp.server.send(succeeded(acp.sessionId))
    expect((await prompted).stopReason).toBe("end_turn")
    acp.server.send(permissionAsked(acp.sessionId, "perm_after_load", { action: "read" }))
    await acp.until(() => acp.server.replies.length === 1, "the permission reply after the load")

    expect(acp.server.replies).toEqual([{ sessionID: acp.sessionId, requestID: "perm_after_load", decision: "once" }])
  })

  test("a stale load finishing after a newer load does not stop the newer follower", async () => {
    let releaseMcp: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      releaseMcp = resolve
    })
    let mcpHeld = false
    await using acp = await startWire({
      // Hold load A's MCP registration so load B attaches and starts following first.
      fetch: async (request) => {
        if (request.method !== "PUT" || request.path !== "/api/experimental/mcp/tools" || mcpHeld) return undefined
        mcpHeld = true
        await held
        return undefined
      },
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
    })
    await acp.initialize()
    acp.server.sessions.set("ses_stale", makeSession("ses_stale"))

    const stale = acp.request("session/load", {
      sessionId: "ses_stale",
      cwd: "/workspace",
      mcpServers: [{ name: "tools", command: "bun", args: ["server.ts"], env: [] }],
    })
    // The fixture records the request before awaiting the fetch override, so its arrival is observable here.
    await acp.until(
      () => acp.server.requests.some((item) => item.method === "PUT" && item.path === "/api/experimental/mcp/tools"),
      "load A's held MCP registration",
    )
    await acp.request("session/load", { sessionId: "ses_stale", cwd: "/workspace", mcpServers: [] })
    releaseMcp!()
    await stale

    acp.server.send(permissionAsked("ses_stale", "perm_stale", { action: "read" }))
    await acp.until(() => acp.server.replies.length === 1, "the permission reply from the newer follower")

    expect(acp.server.replies).toEqual([{ sessionID: "ses_stale", requestID: "perm_stale", decision: "once" }])
  })

  test("does not name a tool call the follower tracked but never sent", async () => {
    await using acp = await startSession({ permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }) })

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")
    acp.server.send(
      durableEvent("session.execution.started", { sessionID: acp.sessionId }),
      toolStarted(acp.sessionId, "call_between", "shell"),
      permissionAsked(acp.sessionId, "perm_between", {
        source: { type: "tool", messageID: "msg_tools", id: "call_between" },
      }),
    )
    await acp.until(() => acp.server.replies.length === 1, "the permission reply between prompts")

    expect(acp.permissions).toMatchObject([{ toolCall: { toolCallId: "perm_between" } }])
  })

  test("asks the pending asks one list found when the other list fails", async () => {
    await using acp = await startSession({
      fetch: (request) => (request.path === "/api/form" ? new Response(null, { status: 500 }) : undefined),
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
    })
    acp.server.pending.permissions.push({
      id: "perm_listed",
      sessionID: acp.sessionId,
      action: "read",
      resources: ["*"],
    })

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")

    expect(acp.server.replies).toEqual([{ sessionID: acp.sessionId, requestID: "perm_listed", decision: "once" }])
=======
  test("streams resumed parent turns after background children report across prompts", async () => {
    await using acp = await startSession({
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
      onPrompt: ({ sessionID, id, text }) => {
        if (text === "launch")
          return turn(
            sessionID,
            id,
            childCreated("ses_first", sessionID, "First"),
            childCreated("ses_second", sessionID, "Second"),
          )
        if (text === "followup")
          return turn(sessionID, id, durableEvent("session.execution.started", { sessionID: "ses_first" }))
        return turn(
          sessionID,
          id,
          textDelta("ses_second", "msg_child_2", "older child during chat"),
          textDelta(sessionID, "msg_chat", "chat reply"),
        )
      },
    })
    const sessionID = acp.sessionId

    expect((await acp.prompt(sessionID, "launch")).stopReason).toBe("end_turn")
    acp.server.send(
      textDelta("ses_first", "msg_child", "child only"),
      succeeded("ses_first"),
      ...turn(sessionID, "msg_report_1", textDelta(sessionID, "msg_reaction_1", "first reaction")),
      textDelta(sessionID, "msg_stale", "stale"),
    )
    await acp.waitForUpdate(({ update }) => JSON.stringify(update).includes("first reaction"))

    expect((await acp.prompt(sessionID, "chat")).stopReason).toBe("end_turn")
    acp.server.send(
      permissionAsked("ses_second", "perm_second", { action: "read" }),
      succeeded("ses_second"),
      ...turn(sessionID, "msg_report_2", textDelta(sessionID, "msg_reaction_2", "second reaction")),
    )
    await acp.waitForUpdate(({ update }) => JSON.stringify(update).includes("second reaction"))
    await acp.until(() => acp.server.replies.length === 1, "second child permission reply")

    expect((await acp.prompt(sessionID, "followup")).stopReason).toBe("end_turn")
    acp.server.send(
      succeeded("ses_first"),
      ...turn(sessionID, "msg_report_3", textDelta(sessionID, "msg_reaction_3", "followup reaction")),
    )
    await acp.waitForUpdate(({ update }) => JSON.stringify(update).includes("followup reaction"))

    expect(acp.server.replies).toEqual([{ sessionID: "ses_second", requestID: "perm_second", decision: "once" }])
    expect(turnUpdates(acp.updates).map(({ update }) => update)).toMatchObject([
      { messageId: "msg_reaction_1", content: { text: "first reaction" } },
      { messageId: "msg_chat", content: { text: "chat reply" } },
      { messageId: "msg_reaction_2", content: { text: "second reaction" } },
      { messageId: "msg_reaction_3", content: { text: "followup reaction" } },
    ])
>>>>>>> upstream-anomalyco/dev
  })

  test("cancels unsupported session forms so execution can continue", async () => {
    await using acp = await startSession({
      onPrompt: ({ sessionID, id }) => [
        delivered(sessionID, id),
        ephemeralEvent("form.created", {
          form: {
            id: "frm_question",
            sessionID,
            title: "Questions",
            metadata: { kind: "question" },
            fields: [{ key: "q0", title: "Choice", type: "string" }],
          },
        }),
      ],
      onFormCancel: ({ sessionID, formID }) => [
        ephemeralEvent("form.cancelled", { sessionID, id: formID }),
        succeeded(sessionID),
      ],
    })

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")
    expect(acp.server.cancelledForms).toEqual([
      { sessionID: acp.sessionId, formID: "frm_question", message: ACPElicitation.UnshownQuestionMessage },
    ])
    expect(acp.elicitations).toEqual([])
  })

  test("steers a running session and leaves an idle one alone", async () => {
    await using acp = await startSession()
    const steer = () =>
      acp.requestExt("_session/steering", { sessionId: acp.sessionId, prompt: [{ type: "text", text: "redirect" }] })

    expect(await steer()).toEqual({ outcome: "promptRequired", reason: "noRunningTurn" })
    expect(acp.server.submissions).toEqual([])

    acp.server.active.add(acp.sessionId)
    expect(await steer()).toEqual({ outcome: "injected" })
    expect(acp.server.prompts).toEqual([expect.objectContaining({ text: "redirect", delivery: "steer", resume: false })])
  })
})

function turnUpdates(updates: readonly SessionNotification[]) {
  return updates.filter(
    (item) => item.update.sessionUpdate !== "available_commands_update" && item.update.sessionUpdate !== "usage_update",
  )
}

function pendingQuestion(sessionID: string, id: string, toolCallID: string) {
  return {
    id,
    sessionID,
    title: "Which package manager?",
    metadata: { kind: "question", tool: { id: toolCallID } },
    fields: [
      { key: "pm", title: "Package manager", type: "string", options: [{ value: "bun", label: "Bun" }] },
    ] as const,
  }
}
