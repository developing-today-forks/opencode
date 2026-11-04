import fs from "fs/promises"
import path from "path"
import { createServer } from "node:http"
import { describe, expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Stream } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Global } from "@opencode/util/global"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { TestClock } from "effect/testing"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const fixture = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir()))
  const state: {
    skills: unknown[]
    files: Record<string, string>
    responses: Record<string, HttpServerResponse.HttpServerResponse>
    requests: string[]
  } = { skills: [], files: {}, responses: {}, requests: [] }
  const server = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
  const base = new URL("/catalog/", HttpServer.formatAddress(server.address)).href
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, base)
      state.requests.push(url.href)
      if (state.responses[url.pathname]) return state.responses[url.pathname]
      const body =
        url.pathname === "/catalog/index.json" ? JSON.stringify({ skills: state.skills }) : state.files[url.pathname]
      return HttpServerResponse.text(body ?? "Not Found", { status: body === undefined ? 404 : 200 })
    }),
  )
  return {
    cache: tmp.path,
    base,
    pull: (
      skills: unknown[],
      files: Record<string, string> = {},
      responses: Record<string, HttpServerResponse.HttpServerResponse> = {},
    ) =>
      Effect.gen(function* () {
        state.skills = skills
        state.files = files
        state.responses = responses
        state.requests = []
        // Rebuild per pull so repeated calls exercise the disk cache, not a shared service.
        const directories = yield* Effect.gen(function* () {
          const discovery = yield* SkillDiscovery.Service
          return yield* discovery.pull(base)
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(SkillDiscovery.node, [Global.node.replace(Global.layerWith({ cache: tmp.path }))]),
          ),
        )
        return { directories, requests: state.requests.slice() }
      }),
  }
})

describe("SkillDiscovery.pull", () => {
  for (const input of [
    {
      name: "rejects skill name traversal without fetching files",
      skills: [{ name: "../outside", files: ["SKILL.md"] }],
    },
    {
      name: "rejects file traversal without fetching files",
      skills: [{ name: "deploy", files: ["SKILL.md", "../outside.md"] }],
    },
    {
      name: "rejects absolute file paths without fetching files",
      skills: [{ name: "deploy", files: ["SKILL.md", "/tmp/outside.md"] }],
    },
    {
      name: "rejects cross-origin file URLs without fetching files",
      skills: [{ name: "deploy", files: ["SKILL.md", "https://evil.example.test/outside.md"] }],
    },
  ]) {
    it.live(
      input.name,
      Effect.gen(function* () {
        const catalog = yield* fixture
        const result = yield* catalog.pull(input.skills)
        expect(result.directories).toEqual([])
        expect(result.requests).toEqual([`${catalog.base}index.json`])
        expect(yield* Effect.promise(() => fs.readdir(catalog.cache))).toEqual([])
      }),
    )
  }

  it.live(
    "downloads safe nested files under the skill root",
    Effect.gen(function* () {
      const catalog = yield* fixture
      const result = yield* catalog.pull([{ name: "deploy", files: ["SKILL.md", "references/guide.md"] }], {
        "/catalog/deploy/SKILL.md": "# Deploy",
        "/catalog/deploy/references/guide.md": "# Guide",
      })
      expect(result.directories).toHaveLength(1)
      expect(result.requests.toSorted()).toEqual(
        [
          `${catalog.base}index.json`,
          `${catalog.base}deploy/SKILL.md`,
          `${catalog.base}deploy/references/guide.md`,
        ].toSorted(),
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(result.directories[0], "SKILL.md")).text())).toBe(
        "# Deploy",
      )
      expect(
        yield* Effect.promise(() => Bun.file(path.join(result.directories[0], "references", "guide.md")).text()),
      ).toBe("# Guide")
    }),
  )

  it.live(
    "does not publish an unversioned skill when a listed file fails to download",
    Effect.gen(function* () {
      const catalog = yield* fixture
      const result = yield* catalog.pull([{ name: "deploy", files: ["SKILL.md", "missing.md"] }], {
        "/catalog/deploy/SKILL.md": "# Deploy",
      })
      expect(result.directories).toEqual([])
      expect(result.requests).toContain(`${catalog.base}deploy/SKILL.md`)
      expect(result.requests).toContain(`${catalog.base}deploy/missing.md`)
    }),
  )

  it.effect(
    "settles a download whose body never completes as failed once the download deadline passes",
    Effect.gen(function* () {
      const catalog = yield* fixture
      let result: { directories: string[]; requests: string[] } | undefined
      yield* catalog
        .pull(
          [{ name: "deploy", files: ["SKILL.md"] }],
          {},
          { "/catalog/deploy/SKILL.md": HttpServerResponse.stream(Stream.never) },
        )
        .pipe(
          Effect.tap((value) => Effect.sync(() => (result = value))),
          Effect.forkChild,
        )
      // The download deadline runs on the test clock while the stalled body
      // occupies real time: advance the clock in steps, yielding to the real
      // event loop between steps, until the deadline settles the pull.
      for (let i = 0; i < 60 && result === undefined; i++) {
        yield* TestClock.adjust("10 seconds")
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)))
      }
      expect(result).toBeDefined()
      expect(result?.directories).toEqual([])
      expect(result?.requests).toContain(`${catalog.base}deploy/SKILL.md`)
    }),
  )

  it.live(
    "does not publish a same-version skill when a newly listed file fails to download",
    Effect.gen(function* () {
      const catalog = yield* fixture
      const first = yield* catalog.pull([{ name: "deploy", version: "1", files: ["SKILL.md"] }], {
        "/catalog/deploy/SKILL.md": "# Deploy",
      })
      expect(first.directories).toHaveLength(1)
      const second = yield* catalog.pull([{ name: "deploy", version: "1", files: ["SKILL.md", "missing.md"] }], {
        "/catalog/deploy/SKILL.md": "# Deploy",
      })
      expect(second.directories).toEqual([])
    }),
  )

  it.live(
    "refreshes cached files when the version changes",
    Effect.gen(function* () {
      const catalog = yield* fixture
      const first = yield* catalog.pull([{ name: "deploy", version: "1", files: ["SKILL.md"] }], {
        "/catalog/deploy/SKILL.md": "# Old",
      })
      const second = yield* catalog.pull([{ name: "deploy", version: "2", files: ["SKILL.md"] }], {
        "/catalog/deploy/SKILL.md": "# New",
      })

      expect(yield* Effect.promise(() => Bun.file(path.join(first.directories[0], "SKILL.md")).text())).toBe("# New")
      expect(second.requests).toContain(`${catalog.base}deploy/SKILL.md`)
      const third = yield* catalog.pull([{ name: "deploy", version: "2", files: ["SKILL.md"] }], {
        "/catalog/deploy/SKILL.md": "# Ignored",
      })
      expect(third.requests).toEqual([`${catalog.base}index.json`])
    }),
  )

  it.live(
    "publishes complete updates and removes stale files",
    Effect.gen(function* () {
      const catalog = yield* fixture
      const first = yield* catalog.pull([{ name: "deploy", version: "1", files: ["SKILL.md", "old.md"] }], {
        "/catalog/deploy/SKILL.md": "# Old",
        "/catalog/deploy/old.md": "old reference",
      })
      const root = first.directories[0]

      yield* catalog.pull([{ name: "deploy", version: "2", files: ["SKILL.md", "missing.md"] }], {
        "/catalog/deploy/SKILL.md": "# Partial",
      })
      expect(yield* Effect.promise(() => Bun.file(path.join(root, "SKILL.md")).text())).toBe("# Old")
      expect(yield* Effect.promise(() => Bun.file(path.join(root, "old.md")).text())).toBe("old reference")

      yield* catalog.pull([{ name: "deploy", version: "3", files: ["SKILL.md"] }], {
        "/catalog/deploy/SKILL.md": "# New",
      })
      expect(yield* Effect.promise(() => Bun.file(path.join(root, "SKILL.md")).text())).toBe("# New")
      expect(yield* Effect.promise(() => Bun.file(path.join(root, "old.md")).exists())).toBe(false)
    }),
  )

  it.live(
    "rejects skill files over the size cap, declared or streamed",
    Effect.gen(function* () {
      const catalog = yield* fixture
      const skills = [{ name: "deploy", files: ["SKILL.md"] }]
      // The test server always sends the true content-length, so an actually-oversized
      // body is what pins the declared-size pre-check here; the chunked stream below
      // (no declared length) pins the per-chunk bound.
      const declared = yield* catalog.pull(skills, {
        "/catalog/deploy/SKILL.md": "x".repeat(SkillDiscovery.MAX_SKILL_FILE_BYTES + 1),
      })
      expect(declared.directories).toEqual([])
      expect(declared.requests).toContain(`${catalog.base}deploy/SKILL.md`)

      const streamed = yield* catalog.pull(
        skills,
        {},
        {
          "/catalog/deploy/SKILL.md": HttpServerResponse.stream(
            Stream.make(new Uint8Array(SkillDiscovery.MAX_SKILL_FILE_BYTES + 1)),
            { contentType: "text/markdown" },
          ),
        },
      )
      expect(streamed.directories).toEqual([])
      expect(streamed.requests).toContain(`${catalog.base}deploy/SKILL.md`)
    }),
  )

  it.live(
    "rejects an index over the size cap, declared or streamed",
    Effect.gen(function* () {
      const catalog = yield* fixture
      // Declared: the fixture server sends the true content-length for the
      // JSON body, so an actually-oversized index pins the declared-size
      // pre-check in collectBoundedResponseBody.
      const declared = yield* catalog.pull([
        { name: "x".repeat(SkillDiscovery.MAX_SKILL_INDEX_BYTES + 1), files: ["SKILL.md"] },
      ])
      expect(declared.directories).toEqual([])
      expect(declared.requests).toEqual([`${catalog.base}index.json`])

      // Streamed: no declared length, so the per-chunk bound is what stops it.
      const streamed = yield* catalog.pull([], {}, {
        "/catalog/index.json": HttpServerResponse.stream(
          Stream.make(new Uint8Array(SkillDiscovery.MAX_SKILL_INDEX_BYTES + 1)),
          { contentType: "application/json" },
        ),
      })
      expect(streamed.directories).toEqual([])
      expect(streamed.requests).toEqual([`${catalog.base}index.json`])
    }),
  )
})
