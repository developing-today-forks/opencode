export * as SkillDiscovery from "./discovery.js"

import path from "path"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { AbsolutePath } from "../schema.js"
import { collectBoundedResponseBody } from "../tool/http-body.js"
import { Hash } from "@opencode/util/hash"

/**
 * Cap on one downloaded skill file. Skill files are markdown and reference text fetched from a remote,
 * third-party index, so the body is untrusted; 5 MiB matches the webfetch tool's `MAX_RESPONSE_BYTES`
 * bound for the same kind of content and is far above any real skill file.
 */
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024

/**
 * Cap on the remote catalog index body. The index is a flat JSON list of
 * {name, version?, files[]} entries fetched from the same untrusted source as
 * the skill files, so it gets its own bound instead of an unbounded decode:
 * even 10,000 skills at ~200 bytes per entry is ~2 MiB, and 8 MiB leaves
 * generous headroom while still failing a hostile or broken catalog fast.
 */
export const MAX_SKILL_INDEX_BYTES = 8 * 1024 * 1024

/** Deadline for the index fetch, matching WellKnown's manifest fetch bound. */
const indexFetchTimeout = "15 seconds"

/**
 * Deadline for one skill file download, bounding the whole transfer
 * including the HttpClient's transient retries: a per-attempt bound would
 * let retryTransient re-enter a stalled source indefinitely. Sized against
 * MAX_SKILL_FILE_BYTES: a full 5 MiB file still completes on a link as slow
 * as ~85 KiB/s, while a source that stalls or slow-drips past any plausible
 * transfer settles through download()'s failure path instead of hanging
 * pull() - and with it plugin/skill loading - forever (#1381).
 */
export const downloadTimeout = "60 seconds"

const skillConcurrency = 4
const fileConcurrency = 8

function isSafeSegment(value: string) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  )
}

function isSafeRelativePath(value: string) {
  const segments = value.split("/")
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !URL.canParse(value) &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    segments.every((segment) => {
      try {
        return isSafeSegment(decodeURIComponent(segment))
      } catch {
        return false
      }
    })
  )
}

class IndexSkill extends Schema.Class<IndexSkill>("SkillDiscovery.IndexSkill")({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
}) {}

class Index extends Schema.Class<Index>("SkillDiscovery.Index")({
  skills: Schema.Array(IndexSkill),
}) {}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<AbsolutePath[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillDiscovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.retryTransient({
        retryOn: "errors-and-responses",
        times: 2,
        schedule: Schedule.exponential(200).pipe(Schedule.jittered),
      }),
      HttpClient.filterStatusOk,
    )

    const download = Effect.fn("SkillDiscovery.download")(function* (url: string, destination: string) {
      if (yield* fs.exists(destination).pipe(Effect.orDie)) return true
      return yield* HttpClientRequest.get(url).pipe(
        HttpClient.withScope(http).execute,
        Effect.flatMap((response) =>
          collectBoundedResponseBody(
            response,
            MAX_SKILL_FILE_BYTES,
            () => new Error(`Skill file too large (exceeds ${MAX_SKILL_FILE_BYTES} byte limit): ${url}`),
          ),
        ),
        Effect.flatMap((body) => fs.writeWithDirs(destination, new Uint8Array(body))),
        Effect.as(true),
        Effect.timeout(downloadTimeout),
        Effect.catch((error) =>
          Effect.logError("failed to download skill file", { url, error }).pipe(Effect.as(false)),
        ),
        // Scoped (withScope above): closing the scope aborts a response the bounded
        // collector rejected on its declared size instead of leaving it to GC.
        Effect.scoped,
      )
    })

    return Service.of({
      pull: Effect.fn("SkillDiscovery.pull")(function* (url) {
        const base = url.endsWith("/") ? url : `${url}/`
        const source = new URL(base)
        const index = new URL("index.json", source).href
        const data = yield* HttpClientRequest.get(index).pipe(
          HttpClientRequest.acceptJson,
          HttpClient.withScope(http).execute,
          // Bounded read (#1376, the #923 residual): collect the body under the
          // index cap first (declared-length pre-check plus in-flight bound),
          // then decode the bounded bytes instead of schemaBodyJson on the raw
          // response. Failure disposition unchanged: log and pull nothing.
          Effect.flatMap((response) =>
            collectBoundedResponseBody(
              response,
              MAX_SKILL_INDEX_BYTES,
              () => new Error(`Skill index too large (exceeds ${MAX_SKILL_INDEX_BYTES} byte limit): ${index}`),
            ),
          ),
          Effect.flatMap((body) => Schema.decodeUnknownEffect(Schema.fromJsonString(Index))(body.toString("utf8"))),
          Effect.timeout(indexFetchTimeout),
          Effect.catch((error) =>
            Effect.logError("failed to fetch skill index", { url: index, error }).pipe(Effect.as(undefined)),
          ),
          // Scoped (withScope above): closing the scope aborts a response the
          // bounded collector rejected on its declared size, as in download().
          Effect.scoped,
        )
        if (!data) return []

        const sourceRoot = path.resolve(global.cache, "skills", Hash.fast(base))
        return yield* Effect.forEach(
          data.skills.flatMap((skill) => {
            if (!isSafeSegment(skill.name)) {
              return []
            }
            if (!skill.files.includes("SKILL.md") && !skill.files.includes(`${skill.name}.md`)) {
              return []
            }

            const root = path.resolve(sourceRoot, skill.name)
            if (!FSUtil.contains(sourceRoot, root) || root === sourceRoot) {
              return []
            }

            const skillUrl = new URL(`${encodeURIComponent(skill.name)}/`, source)
            const versionFile = path.join(root, ".opencode-version")
            const files = skill.files.map((file) => {
              if (!isSafeRelativePath(file)) return undefined
              let resource: URL
              try {
                resource = new URL(file, skillUrl)
              } catch {
                return undefined
              }
              if (resource.origin !== source.origin) return undefined

              const destination = path.resolve(root, file)
              if (!FSUtil.contains(root, destination) || destination === root) return undefined
              return {
                url: resource.href,
                destination,
                file,
              }
            })
            if (!files.every((file): file is { url: string; destination: string; file: string } => file !== undefined))
              return []
            return [{ skill, root, versionFile, files }]
          }),
          ({ skill, root, versionFile, files }) =>
            Effect.gen(function* () {
              const version = skill.version
              const current =
                version === undefined
                  ? undefined
                  : yield* fs.readFileStringSafe(versionFile).pipe(Effect.orElseSucceed(() => undefined))
              let incomplete = false
              if (version === undefined || current === version) {
                const downloaded = yield* Effect.forEach(files, (file) => download(file.url, file.destination), {
                  concurrency: fileConcurrency,
                })
                // Match the versioned branch's gate: a skill whose files did not
                // all download is not published as pulled (#1125).
                if (!downloaded.every(Boolean)) incomplete = true
              } else {
                const token = crypto.randomUUID()
                const staging = `${root}.tmp-${token}`
                const backup = `${root}.old-${token}`
                yield* Effect.gen(function* () {
                  const downloaded = yield* Effect.forEach(
                    files,
                    (file) => download(file.url, path.resolve(staging, file.file)),
                    { concurrency: fileConcurrency },
                  )
                  if (!downloaded.every(Boolean)) return
                  const exists =
                    (yield* fs.exists(path.join(staging, "SKILL.md")).pipe(Effect.orDie)) ||
                    (yield* fs.exists(path.join(staging, `${skill.name}.md`)).pipe(Effect.orDie))
                  if (!exists) return
                  yield* fs.writeFileString(path.join(staging, ".opencode-version"), version)
                  yield* Effect.uninterruptible(
                    Effect.gen(function* () {
                      const cached = yield* fs.exists(root).pipe(Effect.orDie)
                      if (cached) yield* fs.rename(root, backup)
                      yield* fs.rename(staging, root).pipe(
                        Effect.catch((error) =>
                          Effect.gen(function* () {
                            if (cached) yield* fs.rename(backup, root).pipe(Effect.ignore)
                            return yield* Effect.fail(error)
                          }),
                        ),
                      )
                      if (cached) yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore)
                    }),
                  )
                }).pipe(
                  Effect.catch((error) => Effect.logError("failed to refresh skill", { skill: skill.name, error })),
                  Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
                )
              }
              const exists =
                (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie)) ||
                (yield* fs.exists(path.join(root, `${skill.name}.md`)).pipe(Effect.orDie))
              return exists && !incomplete ? [AbsolutePath.make(root)] : []
            }),
          { concurrency: skillConcurrency },
        ).pipe(Effect.map((directories) => directories.flat()))
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [httpClient, FSUtil.node, Global.node] })
