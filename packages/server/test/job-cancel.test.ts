import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Database } from "@opencode/core/database/database"
import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Deferred, Effect, Layer } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("job.cancel answers 404 for an unknown job and 204 for running and settled jobs", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-job-cancel-")).path
    const global = path.join(dir, "global")
    const project = path.join(dir, "project")
    yield* Effect.promise(() => Promise.all([global, project].map((item) => fs.mkdir(item, { recursive: true }))))

    const captured = yield* Deferred.make<Job.Interface>()
    const jobNode = makeGlobalNode({
      service: Job.Service,
      layer: Layer.effect(Job.Service, Job.make.pipe(Effect.tap((service) => Deferred.succeed(captured, service)))),
      deps: [Database.node],
    })
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test" },
        database: { path: path.join(dir, "opencode.db") },
        config: { directory: global, project: false, claude: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      },
      { overrides: [Job.node.replace(jobNode)] },
    )
    const jobs = yield* Deferred.await(captured)

    const call = (path: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: "POST",
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        return response
      })

    const createdResponse = yield* call("/api/session", { location: { directory: project } })
    expect(createdResponse.status).toBe(200)
    const created = (yield* Effect.promise(() => createdResponse.json())) as { data: { id: string } }
    const sessionID = Session.ID.make(created.data.id)

    // Unknown ID: no live-tracked job matches, so the cancel is a 404, not an empty success.
    const unknown = yield* call("/api/experimental/job/job_cancel_probe_unknown/cancel")
    expect(unknown.status).toBe(404)
    const unknownBody = (yield* Effect.promise(() => unknown.json())) as { _tag?: string }
    expect(unknownBody._tag).toBe("JobNotFoundError")

    // Running job: cancel succeeds with 204 and the job's status becomes cancelled.
    const runningGate = yield* Deferred.make<string>()
    yield* jobs.start({
      id: "sh_cancel_running",
      type: "shell",
      title: "sleep",
      recovery: { kind: "shell", sessionID, shellID: "sh_cancel_running", command: "sleep" },
      run: Deferred.await(runningGate),
    })
    yield* jobs.background("sh_cancel_running")
    const running = yield* call("/api/experimental/job/sh_cancel_running/cancel")
    expect(running.status).toBe(204)
    expect((yield* jobs.get("sh_cancel_running"))?.status).toBe("cancelled")

    // Settled job: still tracked (finished but not consumed), so cancel stays an idempotent 204.
    const settledGate = yield* Deferred.make<string>()
    yield* jobs.start({
      id: "sh_cancel_settled",
      type: "shell",
      title: "echo done",
      recovery: { kind: "shell", sessionID, shellID: "sh_cancel_settled", command: "echo done" },
      run: Deferred.await(settledGate),
    })
    yield* jobs.background("sh_cancel_settled")
    yield* Deferred.succeed(settledGate, "done")
    const waited = yield* jobs.wait({ id: "sh_cancel_settled" })
    expect(waited.info?.status).toBe("completed")
    const settled = yield* call("/api/experimental/job/sh_cancel_settled/cancel")
    expect(settled.status).toBe(204)
    expect((yield* jobs.get("sh_cancel_settled"))?.status).toBe("completed")
  }).pipe(Effect.scoped),
)
