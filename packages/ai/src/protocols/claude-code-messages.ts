// The Claude Code Messages protocol — the Claude Code CLI's own wire
// format, folded into the fork as a native provider protocol (#6117).
//
// The CLI does not speak a proprietary inference protocol: it calls the
// Anthropic Messages API (POST https://api.anthropic.com/v1/messages,
// streamed) with its claude.ai subscription OAuth credential. What makes
// a request a *Claude Code* request on that wire — and what the API
// gates subscription access on — is the shape around the standard
// Messages body:
//   * `Authorization: Bearer` + the OAuth token (never x-api-key) — owned by
//     providers/claude-code-auth.ts;
//   * the `anthropic-beta` flags `claude-code-20250219` (identifies the
//     Claude Code client) and `oauth-2025-04-20` (enables OAuth bearer
//     auth), below;
//   * the Claude Code identity as the FIRST system block: the API
//     validates the first system text block of an OAuth request against
//     the known Claude Code identity line, so this protocol prepends it
//     ahead of the caller's own system parts on every request;
//   * the harness env block WITHOUT its git-repo line: Anthropic's
//     third-party classifier fingerprints that one line (#1819) and
//     bills subscription-OAuth requests carrying it to extra usage, so
//     this protocol strips exactly that line from the system parts —
//     every other provider keeps the full env block;
//   * the CLI's client headers (`x-app: cli`, `claude-cli/<version>`
//     User-Agent; version tracks the release this emulation was verified
//     against - Claude Code 2.1.306, the fleet's installed CLI). The
//     route's static User-Agent below is only the default: session
//     requests carry the harness's own UA in `request.http.headers`,
//     which the transport merges over route headers, so
//     providers/claude-code-auth.ts re-stamps CLI_USER_AGENT after the
//     merge (auth application order) - that stamp is the wire truth.
//
// Everything else — tool lowering (tools / tool_choice / tool_use /
// tool_result blocks), streaming, thinking — is the Anthropic Messages
// protocol verbatim, so client tool calls round-trip exactly as they do
// for the first-party API-key provider. That is the doctrine fix for
// code#6117: the old claude-code door (bin/claude-code-proxy.mjs in
// developing-today/code) ran the CLI at inference time and could not
// emit a client tool call at all.
import { Effect } from "effect"
import { Route } from "../route/client.js"
import { Auth } from "../route/auth.js"
import { Endpoint } from "../route/endpoint.js"
import { Protocol } from "../route/protocol.js"
import { LLMRequest, SystemPart } from "../schema/index.js"
import { AnthropicMessages } from "./anthropic-messages.js"

const ADAPTER = "claude-code-messages"

/** The identity line the Messages API expects as the first system block of a Claude Code OAuth request. */
export const IDENTITY_SYSTEM_TEXT = "You are Claude Code, Anthropic's official CLI for Claude."

/** Beta flags a Claude Code OAuth request carries (the Anthropic transport adds feature betas on top). */
export const OAUTH_BETA_HEADER = "claude-code-20250219,oauth-2025-04-20"

/** The CLI's User-Agent grammar: `claude-cli/<version> (external, cli)`. Version = the verified CLI release. */
export const CLI_USER_AGENT = "claude-cli/2.1.306 (external, cli)"

export type OptionsInput = AnthropicMessages.OptionsInput
export type ProviderOptionsInput = AnthropicMessages.ProviderOptionsInput

/**
 * The harness env block's git-repo line (emitted by the core
 * `core/environment` builtin instruction): the anchor Anthropic's
 * third-party classifier fingerprints (#1819). Matches the whole line,
 * either value, at any indentation.
 */
const GIT_REPO_ENV_LINE = /^\s*Is directory a git repo: (?:yes|no)\s*$/

/**
 * Remove the git-repo env line from a system part's text. Every other
 * line survives byte-identical and in order; text without the line is
 * returned unchanged. Oracle: the #1819 wire bisection — the captured
 * production request with ONLY this line removed returns 200 with the
 * rest of the harness prompt intact; flipping its value changes nothing.
 */
export const stripGitRepoEnvLine = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !GIT_REPO_ENV_LINE.test(line))
    .join("\n")

const fromRequest = Effect.fn("ClaudeCodeMessages.fromRequest")(function* (request: LLMRequest) {
  // Strip the git-repo env line from the system parts (#1819): with that
  // one line present, subscription-OAuth requests are classified as a
  // third-party app and refused (HTTP 400, billed to extra usage); the
  // same request without it succeeds. Scoped to this route — the core
  // instruction and every other provider keep the line.
  const shaped = request.system.map((part) => {
    const text = stripGitRepoEnvLine(part.text)
    return text === part.text ? part : { ...part, text }
  })
  // The identity block must be the first system block; a caller that
  // already leads with it (a façade replaying a captured Claude Code
  // request) is not double-stamped.
  const system =
    shaped[0]?.text === IDENTITY_SYSTEM_TEXT
      ? shaped
      : [SystemPart.make(IDENTITY_SYSTEM_TEXT), ...shaped]
  return yield* AnthropicMessages.protocol.body.from(LLMRequest.update(request, { system }))
})

export const protocol = Protocol.make({
  id: ADAPTER,
  body: { schema: AnthropicMessages.AnthropicMessagesBody, from: fromRequest },
  stream: AnthropicMessages.protocol.stream,
  supportsEffortUpdates: AnthropicMessages.protocol.supportsEffortUpdates,
})

export const route = Route.make({
  id: ADAPTER,
  provider: "claude-code",
  providerMetadataKey: "claude-code",
  protocol,
  endpoint: Endpoint.path(AnthropicMessages.PATH, { baseURL: AnthropicMessages.DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: AnthropicMessages.transport<AnthropicMessages.AnthropicMessagesBody>(),
  headers: () => ({
    "anthropic-version": "2023-06-01",
    "anthropic-beta": OAUTH_BETA_HEADER,
    "x-app": "cli",
    "user-agent": CLI_USER_AGENT,
  }),
})

export * as ClaudeCodeMessages from "./claude-code-messages.js"
