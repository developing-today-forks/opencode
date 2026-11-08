import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { OPENCODE_VERSION } from "../src/version"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServerConnection } from "../src/services/server-connection"
import { ServiceConfig } from "../src/services/service-config"

test("resolution groups Effect-native lifecycle operations only for the managed service", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-resolution-"))
  const id = "server-resolution-test"
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        version: OPENCODE_VERSION,
        pid: process.pid,
        urls: [],
      })
    },
  })
  const registration = path.join(root, "state", ServiceConfig.filename())
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | FSUtil.Service | Scope.Scope>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(layer), Effect.provide(FSUtil.layer), Effect.provide(NodeFileSystem.layer), Effect.scoped),
    )

  try {
    await fs.mkdir(path.dirname(registration), { recursive: true })
    await fs.writeFile(
      registration,
      JSON.stringify({
        id,
        version: OPENCODE_VERSION,
        url: server.url.toString(),
        pid: process.pid,
      }),
    )
    const resolved = await runPromise(ServerConnection.resolve())

    expect(resolved.endpoint.url).toBe(server.url.toString())
    expect(resolved.service).toBeDefined()
    if (!resolved.service) throw new Error("Expected managed service capabilities")
    expect(Effect.isEffect(resolved.service.reconnect())).toBe(true)
    expect(Effect.isEffect(resolved.service.restart())).toBe(true)
    expect(await runPromise(resolved.service.reconnect())).toEqual(resolved.endpoint)

    const explicit = await runPromise(ServerConnection.resolve({ server: server.url.toString() }))
    expect(explicit.endpoint.url).toBe(server.url.toString())
    expect(explicit.service).toBeUndefined()
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("explicit server resolution retries a starting server until it answers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-starting-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | FSUtil.Service | Scope.Scope>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(layer), Effect.provide(FSUtil.layer), Effect.provide(NodeFileSystem.layer), Effect.scoped),
    )
  let probes = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      probes++
      if (probes < 3)
        return Response.json({ code: "service_starting" }, { status: 503, headers: { "retry-after": "1" } })
      return Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [] })
    },
  })

  try {
    const resolved = await runPromise(ServerConnection.resolve({ server: server.url.toString() }))
    expect(resolved.endpoint.url).toBe(server.url.toString())
    expect(probes).toBe(3)
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("explicit server resolution retries a refused connection until the server starts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-refused-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | FSUtil.Service | Scope.Scope>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(layer), Effect.provide(FSUtil.layer), Effect.provide(NodeFileSystem.layer), Effect.scoped),
    )
  const placeholder = Bun.serve({ port: 0, fetch: () => new Response() })
  const url = placeholder.url.toString()
  const port = placeholder.port
  await placeholder.stop(true)
  let server: ReturnType<typeof Bun.serve> | undefined

  try {
    const pending = runPromise(ServerConnection.resolve({ server: url }))
    void pending.catch(() => undefined)
    await Bun.sleep(1_200)
    server = Bun.serve({
      port,
      fetch() {
        return Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [] })
      },
    })
    const resolved = await pending
    expect(resolved.endpoint.url).toBe(url)
  } finally {
    await server?.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("explicit server resolution does not retry an unauthorized server", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-unauthorized-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | FSUtil.Service | Scope.Scope>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(layer), Effect.provide(FSUtil.layer), Effect.provide(NodeFileSystem.layer), Effect.scoped),
    )
  const previousPassword = process.env.OPENCODE_PASSWORD
  const previousServerPassword = process.env.OPENCODE_SERVER_PASSWORD
  delete process.env.OPENCODE_PASSWORD
  delete process.env.OPENCODE_SERVER_PASSWORD
  let probes = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      probes++
      return Response.json({ _tag: "UnauthorizedError", message: "Invalid credentials" }, { status: 401 })
    },
  })

  try {
    await expect(runPromise(ServerConnection.resolve({ server: server.url.toString() }))).rejects.toThrow(
      "requires a password",
    )
    expect(probes).toBe(1)
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
    if (previousPassword === undefined) delete process.env.OPENCODE_PASSWORD
    else process.env.OPENCODE_PASSWORD = previousPassword
    if (previousServerPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = previousServerPassword
  }
})

test("service options only require a matching version when requested", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-options-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | FSUtil.Service | Scope.Scope>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(layer), Effect.provide(FSUtil.layer), Effect.provide(NodeFileSystem.layer), Effect.scoped),
    )

  try {
    expect((await runPromise(ServiceConfig.options())).version).toBeUndefined()
    expect((await runPromise(ServiceConfig.options({ checkVersion: true }))).version).toBe(OPENCODE_VERSION)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
