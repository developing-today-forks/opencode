export * as WebFetchTool from "./webfetch.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Duration, Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Parser } from "htmlparser2"
import { Permission } from "../../permission.js"
import { convertHTMLToMarkdown, MAX_MARKDOWN_BYTES } from "../html-markdown.js"
import { collectBoundedResponseBody } from "../http-body.js"

export const name = "webfetch"
export const MAX_RESPONSE_BYTES = MAX_MARKDOWN_BYTES
export const DEFAULT_TIMEOUT_SECONDS = 30
export const MAX_TIMEOUT_SECONDS = 120
export const MAX_REDIRECTS = 10

export const description = `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.

Use a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.`

const Timeout = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS))

export const Input = Schema.Struct({
  url: Schema.String.annotate({ description: "The HTTP or HTTPS URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({ description: "The format to return the content in. Defaults to markdown." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed("markdown" as const))),
  timeout: Schema.optionalKey(Timeout).annotate({
    description: `Optional timeout in seconds (maximum: ${MAX_TIMEOUT_SECONDS})`,
  }),
})

const Output = Schema.Struct({
  url: Schema.String,
  contentType: Schema.String,
  format: Input.fields.format,
  output: Schema.String,
})
type Format = (typeof Input.Type)["format"]

const acceptHeader = (format: Format) => {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
}

const headers = (format: Format, userAgent: string) => ({
  "User-Agent": userAgent,
  Accept: acceptHeader(format),
  "Accept-Language": "en-US,en;q=0.9",
})

const openCodeUserAgent =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OpenCode-User/1.0; +https://opencode.ai"

const isCloudflareChallenge = (error: unknown) => {
  // Redirect and permission errors also flow through this predicate; only an
  // HttpClientError carries a `reason` to inspect.
  const reason = (
    error as { reason?: { _tag?: string; response?: { status: number; headers: Record<string, string> } } }
  ).reason
  if (reason?._tag !== "StatusCodeError" || !reason.response) return false
  return reason.response.status === 403 && reason.response.headers["cf-mitigated"] === "challenge"
}

const request = (url: string, format: Format, userAgent = openCodeUserAgent) =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers(format, userAgent)))

const assertHttpUrl = (url: URL) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http:// or https://")
}

// Redirects are followed manually: the transport must not follow them itself,
// or a permitted URL could redirect to a destination that was never checked.
const execute = (http: HttpClient.HttpClient, url: string, format: Format, userAgent = openCodeUserAgent) =>
  http
    .execute(request(url, format, userAgent))
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))

const isRedirect = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 300 && response.status < 400 && response.headers["location"] !== undefined

const collectBody = (response: HttpClientResponse.HttpClientResponse) =>
  collectBoundedResponseBody(
    response,
    MAX_RESPONSE_BYTES,
    () => new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`),
  )

const mimeFrom = (contentType: string) => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
const isImageAttachment = (mime: string) =>
  mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
const isTextualMime = (mime: string) =>
  !mime ||
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime.endsWith("+xml") ||
  mime === "application/javascript" ||
  mime === "application/x-javascript"
const convert = (content: string, contentType: string, format: Format) => {
  if (!contentType.includes("text/html")) return content
  if (format === "markdown") return convertHTMLToMarkdown(content)
  if (format === "text") return extractTextFromHTML(content)
  return content
}

export const Plugin = {
  id: "opencode.tool.webfetch",
  effect: Effect.fn("WebFetchTool.Plugin")(function* (ctx: Context) {
    const http = yield* HttpClient.HttpClient
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* Effect.try({
                try: () => assertHttpUrl(new URL(input.url)),
                catch: (error) => error,
              })

              yield* permission.assert({
                action: name,
                resources: [input.url],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })

              const { body, contentType } = yield* Effect.gen(function* () {
                // Every redirect destination is resolved, scheme-checked, and
                // permission-checked before it is fetched. The initial URL was
                // already asserted above, so it is seeded into the checked set;
                // a destination is asserted at most once per fetch.
                const checked = new Set([input.url])
                const fetchFinal = (userAgent: string) =>
                  Effect.gen(function* () {
                    let url = input.url
                    let redirects = 0
                    while (true) {
                      const response = yield* execute(http, url, input.format, userAgent)
                      if (!isRedirect(response)) return yield* HttpClientResponse.filterStatusOk(response)
                      if (redirects >= MAX_REDIRECTS)
                        return yield* Effect.fail(new Error(`Too many redirects: exceeded ${MAX_REDIRECTS} redirects`))
                      redirects++
                      const location = response.headers["location"]!
                      const destination = yield* Effect.try({
                        try: () => new URL(location, url),
                        catch: () => new Error(`Invalid redirect Location header: ${location}`),
                      })
                      yield* Effect.try({
                        try: () => assertHttpUrl(destination),
                        catch: (error) => error,
                      })
                      const destinationUrl = destination.toString()
                      if (!checked.has(destinationUrl)) {
                        checked.add(destinationUrl)
                        yield* permission.assert({
                          action: name,
                          resources: [destinationUrl],
                          save: ["*"],
                          metadata: { ...input, url: destinationUrl },
                          sessionID: context.sessionID,
                          agent: context.agent,
                          source: { type: "tool", messageID: context.messageID, id: context.id },
                        })
                      }
                      url = destinationUrl
                    }
                  })
                const response = yield* fetchFinal(openCodeUserAgent).pipe(
                  Effect.catchIf(isCloudflareChallenge, () => fetchFinal("opencode")),
                )
                const contentType = response.headers["content-type"] || ""
                const mime = mimeFrom(contentType)
                if (isImageAttachment(mime))
                  return yield* Effect.fail(new Error(`Unsupported fetched image content type: ${mime}`))
                if (!isTextualMime(mime))
                  return yield* Effect.fail(new Error(`Unsupported fetched file content type: ${mime}`))
                return { body: yield* collectBody(response), contentType }
              }).pipe(
                Effect.timeoutOrElse({
                  duration: Duration.seconds(input.timeout ?? DEFAULT_TIMEOUT_SECONDS),
                  orElse: () => Effect.fail(new Error("Request timed out")),
                }),
              )
              const content = new TextDecoder().decode(body)
              const output = yield* Effect.try({
                try: () => convert(content, contentType, input.format),
                catch: (error) => error,
              })
              const result = {
                url: input.url,
                contentType,
                format: input.format,
                output,
              }
              return { output: result, content: result.output, metadata: { contentType: result.contentType } }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to fetch ${input.url}`, error }))),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

export function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth++
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}

export { convertHTMLToMarkdown }
