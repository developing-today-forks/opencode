export * as FileMutation from "./file-mutation.js"

import { isUtf8 } from "node:buffer"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Bom } from "@opencode/util/bom"
import { Environment } from "./environment/index.js"
import type { Files } from "./environment/index.js"
import { FileAccess } from "./file-access.js"
import { AbsolutePath } from "./schema.js"

export type Target = Pick<FileAccess.Target, "absolute" | "resource" | "environment">

export interface WriteInput {
  readonly target: Target
  readonly content: string | Uint8Array
}

export interface TextWriteInput {
  readonly target: Target
  readonly content: string
}

export interface WriteResult {
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface TextWriteResult extends WriteResult {
  readonly bom: boolean
}

export interface Interface {
  /**
   * Serialize a complete read/prepare/write mutation transaction by file. A typed path is located first, so it
   * names its machine when the text does.
   */
  readonly withLock: (
    targets: ReadonlyArray<Environment.Place | string>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Environment.Failed, R>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, Environment.Failed>
  /** Add bytes to the end of a file, creating it when missing. */
  readonly append: (input: WriteInput) => Effect.Effect<WriteResult, Environment.Failed>
  /** Write text while retaining an existing UTF-8 BOM and emitting at most one BOM. */
  readonly writeTextPreservingBom: (
    input: TextWriteInput,
  ) => Effect.Effect<TextWriteResult, Environment.WrongKind | Environment.Failed>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileMutation") {}

export class InvalidUtf8Error extends Schema.TaggedError<InvalidUtf8Error>()("FileMutation.InvalidUtf8Error", {
  path: Schema.String,
}) {
  override get message() {
    return "file is not valid UTF-8. It was left unchanged because rewriting it as text would replace every byte that is not UTF-8 with U+FFFD; change it with a tool that preserves its bytes, or convert it to UTF-8 first"
  }
}

export const readText = Effect.fn("FileMutation.readText")(function* (files: Files, target: string) {
  return Bom.decodeBytes((yield* files.read(target)).bytes)
})

/** Read text that will be rewritten. Decoding replaces invalid bytes with U+FFFD, so such files are refused. */
export const readEditableText = Effect.fn("FileMutation.readEditableText")(function* (files: Files, target: string) {
  const bytes = (yield* files.read(target)).bytes
  if (!isUtf8(bytes)) return yield* new InvalidUtf8Error({ path: target })
  return Bom.decodeBytes(bytes)
})

export const readOptionalText = Effect.fn("FileMutation.readOptionalText")(function* (files: Files, target: string) {
  const result = yield* files.read(target).pipe(Effect.catchTag("Environment.NotFound", () => Effect.undefined))
  return result ? Bom.decodeBytes(result.bytes) : undefined
})

export const syncTextBom = Effect.fn("FileMutation.syncTextBom")(function* (
  files: Files,
  target: string,
  bom: boolean,
) {
  const synced = Bom.syncBytes((yield* files.read(target)).bytes, bom)
  if (synced.bytes) yield* files.write(target, synced.bytes)
  return synced.text
})

/** Share transaction locks across Location graphs that address the same file. */
const transactionLocks = KeyedMutex.makeUnsafe<string>()

/**
 * Resolved paths whose transaction lock the current fiber already holds.
 * A transaction (edit/patch) stores its result through `write` while holding
 * the lock, and the keyed mutex is not reentrant, so a write must not
 * re-acquire a key its own fiber already holds — it would deadlock. Fibers
 * outside the transaction do not carry the held set, so an ordinary write
 * still waits for the transaction to finish.
 */
const HeldTransactionKeys = Context.Reference<ReadonlySet<string>>("@opencode/FileMutation/HeldTransactionKeys", {
  defaultValue: () => new Set<string>(),
})

/**
 * Mutation locking is process-local and serializes cooperating OpenCode
 * changes; external writes can still race.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const access = yield* FileAccess.Service
    // A file's lock key: the resolved path on its machine.
    const lockKey = (target: { readonly absolute: string; readonly environment: { readonly id: Environment.ID } }) =>
      FileAccess.key({ absolute: AbsolutePath.make(FSUtil.resolve(target.absolute)), environment: target.environment })
    const withTransactionLocks =
      (keys: ReadonlyArray<string>) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.gen(function* () {
          const held = yield* HeldTransactionKeys
          const fresh = [...new Set(keys)].filter((key) => !held.has(key)).sort()
          const inner = Effect.provideService(effect, HeldTransactionKeys, new Set([...held, ...fresh]))
          return yield* fresh.reduceRight<Effect.Effect<A, E, R>>(
            (result, key) => transactionLocks.withLock(key)(result),
            inner,
          )
        })
    const withLock: Interface["withLock"] = (targets) => (effect) =>
      Effect.gen(function* () {
        const places = yield* Effect.forEach(targets, (target) =>
          typeof target === "string" ? access.locate(target) : Effect.succeed(target),
        )
        return yield* withTransactionLocks(places.map(lockKey))(effect)
      })
    // Ordinary writes take the same transaction lock the edit/patch tools hold across their read/prepare/write
    // transaction, so a write can no longer land mid-transaction and be silently overwritten by the transaction's
    // stale result (issue #2276).
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        withTransactionLocks([lockKey(target)])(Effect.uninterruptible(effect))

    const writeResult = (target: Target, existed: boolean): WriteResult => ({
      operation: "write",
      target: target.absolute,
      resource: target.resource,
      existed,
    })

    const put = (input: WriteInput, store: "write" | "append") =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const existed = yield* input.target.environment.files.stat(input.target.absolute).pipe(
            Effect.as(true),
            Effect.catchTag("Environment.NotFound", () => Effect.succeed(false)),
          )
          yield* input.target.environment.files[store](
            input.target.absolute,
            typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content,
          )
          return writeResult(input.target, existed)
        }),
      )

    const write = Effect.fn("FileMutation.write")((input: WriteInput) => put(input, "write"))

    const append = Effect.fn("FileMutation.append")((input: WriteInput) => put(input, "append"))

    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const next = Bom.split(input.content)
          const current = yield* input.target.environment.files
            .read(input.target.absolute, { offset: 0, length: 3 })
            .pipe(
              Effect.map((result) => result.bytes),
              Effect.catchTag("Environment.NotFound", () => Effect.undefined),
            )
          const bom = Boolean(current && Bom.has(current)) || next.bom
          yield* input.target.environment.files.write(
            input.target.absolute,
            new TextEncoder().encode(Bom.join(next.text, bom)),
          )
          return { ...writeResult(input.target, current !== undefined), bom }
        }),
      ),
    )

    return Service.of({ withLock, write, append, writeTextPreservingBom })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FileAccess.node] })

/**
 * Deferred until the corresponding integrations exist.
 */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after snapshot design exists.
// TODO: Notify LSP and collect diagnostics after LSP runtime exists.
// TODO: Design multi-file transactions / rollback if patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// Crash recovery between Tool.Called and durable settlement is defined, and
// recovery never re-executes a call. The restart sweep
// (SessionRestart.resumeSuspendedSessions in session/execution/restart.ts)
// settles interrupted mutation calls from the durable history: a `write`
// call's recorded input fully determines its post-state, so the sweep
// verifies it against the filesystem — an exact match settles as success, a
// missing target settles as failed (verified not applied), and any other
// content settles as failed unconfirmed. `edit`/`patch` post-states cannot
// be derived from their recorded inputs, so they settle as failed
// unconfirmed. A session drained without the sweep keeps the runner's
// warn-only `tool.interrupted` settlement (SessionRunner.settleStaleToolCalls
// in session/runner/llm.ts). This layer stays crash-agnostic on purpose: a
// settlement decision needs the session history, which only the sweep and
// the runner own.
