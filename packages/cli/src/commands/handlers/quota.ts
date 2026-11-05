import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import {
  fetchQuotaForProviderInstances,
  listConfiguredQuotaProviders,
  resolveQuotaProviderName,
  type QuotaContext,
  type QuotaCredentialRow,
  type QuotaResult,
} from "@opencode/ai/quota"
import { Global } from "@opencode/util/global"
import { Effect, Option } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { EOL, homedir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { databasePath } from "../../database-path"
import { errorMessage } from "../../util/error"

/**
 * `opencode quota` — the single source for quota info (code#6125).
 *
 * Quota is a provider function in @opencode/ai: each provider emulates
 * its first-party billing/usage wire. This handler assembles the quota
 * context from the fork's own credential machinery — the running
 * server's credential list (GET /api/credential), with a read-only
 * local credential-store fallback when no server answers — and the
 * merged config's facts (disabled_providers, provider instances) read
 * from the config files.
 *
 * No arguments: every configured provider with a usable credential,
 * plus the built-in turso fetcher; disabled providers are skipped
 * unless --all. Named providers are always fetched, even when
 * routing-disabled. Exit code is non-zero when a requested provider
 * produced no successful result.
 */

const DEFAULT_QUOTA_TIMEOUT_MS = 30_000

const quotaTimeoutMs = (): number => {
  const parsed = Number(process.env.OPENCODE_QUOTA_TIMEOUT_MS)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647 ? parsed : DEFAULT_QUOTA_TIMEOUT_MS
}

interface GlobalPaths {
  config: string
  data: string
  state: string
}

const readStoreRows = async (dbPath: string): Promise<QuotaCredentialRow[]> => {
  // The CLI runs on Bun (dev and the compiled binary alike); the
  // local store is read through bun:sqlite, read-only. Loaded via
  // createRequire so a Node runtime without bun:sqlite simply has
  // no fallback instead of failing to load this handler.
  const { createRequire } = await import("node:module")
  const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
    Database: new (path: string, options: { readonly: boolean }) => {
      prepare: (sql: string) => { all: () => Array<Record<string, unknown>> }
      close: () => void
    }
  }
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db
      .prepare("select id, integration_id, label, value from credential order by active asc, time_created asc, id asc")
      .all()
    const entries: QuotaCredentialRow[] = []
    for (const row of rows) {
      let value: QuotaCredentialRow["value"] | null = null
      try {
        value = JSON.parse(String(row.value)) as QuotaCredentialRow["value"]
      } catch {
        value = null
      }
      if (!row.integration_id || !value || (value.type !== "key" && value.type !== "oauth")) continue
      entries.push({
        id: String(row.id),
        integrationID: String(row.integration_id),
        label: typeof row.label === "string" ? row.label : undefined,
        active: false,
        value,
      })
    }
    // The server's listing marks each integration's last row (in this
    // order) active; mirror that here.
    const selectedIndex = new Map<string, number>()
    entries.forEach((entry, index) => selectedIndex.set(entry.integrationID, index))
    entries.forEach((entry, index) => {
      entry.active = selectedIndex.get(entry.integrationID) === index
    })
    return entries
  } finally {
    db.close()
  }
}

const readLocalCredentialRows = async (global: GlobalPaths): Promise<QuotaCredentialRow[]> => {
  // Canonical stores first: a channel-scoped database (opencode-local.db
  // and friends) is a different, possibly empty store, so it is only
  // the last resort — a candidate that reads as empty never hides the
  // machine's real credential store behind it.
  const candidates = [
    join(global.data, "opencode.db"),
    join(global.state, "opencode.db"),
    join(homedir(), ".local", "share", "opencode", "opencode.db"),
    join(homedir(), ".local", "state", "opencode", "opencode.db"),
    databasePath(global.data),
  ]
  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) continue
    try {
      const rows = await readStoreRows(candidate)
      if (rows.length > 0) return rows
    } catch {
      // An unreadable candidate decides nothing; the next one stands.
    }
  }
  return []
}

interface ConfigFacts {
  disabledProviders: Set<string>
  instances: Map<string, { base: string; name?: string }>
  providerConfig: Record<string, Record<string, unknown>>
}

const readConfigFacts = (global: GlobalPaths): ConfigFacts => {
  const files: string[] = []
  const addCandidates = (dir: string) => {
    files.push(join(dir, "opencode.jsonc"), join(dir, "opencode.json"))
  }
  addCandidates(global.config)
  if (process.env.OPENCODE_CONFIG) files.push(process.env.OPENCODE_CONFIG)
  addCandidates(process.cwd())
  addCandidates(join(process.cwd(), ".opencode"))

  const disabledProviders = new Set<string>()
  const instances = new Map<string, { base: string; name?: string }>()
  const providerConfig: Record<string, Record<string, unknown>> = {}

  for (const file of files) {
    let document: Record<string, unknown> | undefined
    try {
      if (!existsSync(file)) continue
      const parsed = parse(readFileSync(file, "utf8")) as Record<string, unknown> | undefined
      if (parsed && typeof parsed === "object") document = parsed
    } catch {
      document = undefined
    }
    if (!document) continue
    if (Array.isArray(document.disabled_providers)) {
      for (const entry of document.disabled_providers) {
        if (typeof entry === "string" && entry !== "") disabledProviders.add(entry)
      }
    }
    for (const sectionKey of ["provider", "providers"]) {
      const section = document[sectionKey]
      if (!section || typeof section !== "object" || Array.isArray(section)) continue
      for (const [id, definition] of Object.entries(section as Record<string, unknown>)) {
        if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue
        const record = definition as Record<string, unknown>
        providerConfig[id] = { ...(providerConfig[id] ?? {}), ...record }
        const base = typeof record.instanceOf === "string" ? record.instanceOf : undefined
        if (base) {
          instances.set(id, {
            base,
            name: typeof record.name === "string" ? record.name : undefined,
          })
        }
      }
    }
  }
  return { disabledProviders, instances, providerConfig }
}

export const buildQuotaContext = async (
  client: ReturnType<typeof OpenCode.make> | null,
  global: GlobalPaths,
): Promise<QuotaContext> => {
  let credentials: QuotaCredentialRow[] = []
  if (client) {
    try {
      const entries = await client.credential.list()
      credentials = entries.map((entry) => ({
        id: String(entry.id),
        integrationID: String(entry.integrationID),
        label: entry.label,
        active: Boolean(entry.active),
        value: entry.value as QuotaCredentialRow["value"],
      }))
    } catch {
      credentials = []
    }
  }
  if (credentials.length === 0) {
    credentials = await readLocalCredentialRows(global)
  }
  const facts = readConfigFacts(global)
  return {
    credentials,
    disabledProviders: facts.disabledProviders,
    instances: facts.instances,
    providerConfig: facts.providerConfig,
    homeDir: homedir(),
    configDir: global.config,
    env: process.env,
  }
}

const fetchProviderWithTimeout = async (ctx: QuotaContext, providerId: string): Promise<QuotaResult[]> => {
  const timeoutMs = quotaTimeoutMs()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<QuotaResult[]>((resolve) => {
    timer = setTimeout(
      () =>
        resolve([
          {
            providerId,
            providerName: providerId,
            ok: false,
            configured: true,
            usage: null,
            fetchedAt: Date.now(),
            error: `Quota fetch timed out after ${timeoutMs}ms`,
          },
        ]),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([fetchQuotaForProviderInstances(ctx, providerId), deadline])
  } catch (error) {
    return [
      {
        providerId,
        providerName: providerId,
        ok: false,
        configured: true,
        usage: null,
        fetchedAt: Date.now(),
        error: errorMessage(error),
      },
    ]
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Whether every requested provider group produced at least one successful result. */
export const quotaRunSucceeded = (groups: { results: QuotaResult[] }[]): boolean =>
  groups.every((group) => group.results.some((result) => result.ok))

export const renderQuotaResults = (results: QuotaResult[]): string => {
  const lines: string[] = []
  for (const result of results) {
    const headerParts = [`${result.providerName} (${result.providerId})`]
    if (result.credentialLabel) headerParts.push(result.credentialLabel)
    if (result.accountLabel) headerParts.push(result.accountLabel)
    if (result.planLabel) headerParts.push(`plan: ${result.planLabel}`)
    const header = headerParts.join(" — ")
    if (!result.ok) {
      lines.push(`${header}: ${result.error ?? "Failed to fetch quota"}`)
      lines.push("")
      continue
    }
    lines.push(header)
    const windows = Object.entries(result.usage?.windows ?? {})
    if (windows.length === 0 && !result.usage?.models) {
      lines.push("  no usage windows reported")
    }
    for (const [label, window] of windows) {
      const value = Number.isFinite(window?.usedPercent)
        ? `${window.usedPercent}% used`
        : (window?.valueLabel ?? "unknown")
      const detail = Number.isFinite(window?.usedPercent) && window?.valueLabel ? ` (${window.valueLabel})` : ""
      const reset = window?.resetAtFormatted ? `, resets ${window.resetAtFormatted}` : ""
      lines.push(`  ${label}: ${value}${detail}${reset}`)
    }
    const models = result.usage?.models
    if (models && !Array.isArray(models)) {
      for (const [model, entry] of Object.entries(models)) {
        const parts = Object.entries(entry.windows ?? {}).map(([label, window]) =>
          Number.isFinite(window?.usedPercent) ? `${label} ${window.usedPercent}%` : `${label} ${window?.valueLabel ?? "unknown"}`,
        )
        if (parts.length > 0) lines.push(`  ${model}: ${parts.join(" · ")}`)
      }
    }
    lines.push("")
  }
  return lines.join(EOL).trimEnd()
}

const handler = Effect.fn("cli.quota")(function* (input: Runtime.Input<typeof Commands.commands.quota>) {
  const global = yield* Global.Service
  const server = yield* ServerConnection.resolve({
    server: Option.getOrUndefined(input.server),
    standalone: input.standalone,
    mismatch: "ignore",
  }).pipe(Effect.catch(() => Effect.succeed(null)))
  const client = server
    ? OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    : null
  const ctx = yield* Effect.promise(() => buildQuotaContext(client, global))

  const requested = [...input.providers]
  const groups: { providerId: string; results: QuotaResult[] }[] = []

  if (requested.length === 0) {
    const ids = yield* Effect.promise(() => listConfiguredQuotaProviders(ctx, { includeDisabled: input.all }))
    for (const providerId of ids) {
      const results = yield* Effect.promise(() => fetchProviderWithTimeout(ctx, providerId))
      groups.push({ providerId, results })
    }
  } else {
    for (const name of requested) {
      const resolved = resolveQuotaProviderName(ctx, name)
      if (!resolved) {
        process.stderr.write(`Unknown provider: ${name}${EOL}`)
        process.exitCode = 1
        return
      }
      if (groups.some((group) => group.providerId === resolved)) continue
      const results = yield* Effect.promise(() => fetchProviderWithTimeout(ctx, resolved))
      groups.push({ providerId: resolved, results })
    }
  }

  const results = groups.flatMap((group) => group.results)
  if (input.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + EOL)
  } else {
    const rendered = renderQuotaResults(results)
    if (rendered) process.stdout.write(rendered + EOL)
  }
  if (!quotaRunSucceeded(groups)) {
    process.exitCode = 1
  }
})

export default Runtime.handler(Commands.commands.quota, (input) =>
  handler(input).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        process.stderr.write(errorMessage(error) + EOL)
        process.exitCode = 1
      }),
    ),
  ),
)
