# OpenCode V2 Promise Plugin API

The Promise plugin API at `@opencode/plugin` is the async/await equivalent of `@opencode/plugin/effect`. It grants plugins the same two in-process capabilities:

- `hook` installs behavior at an OpenCode extension point.
- `reload` reruns every transform hook for a stateful domain.

The Promise API uses Promises instead of Effects for setup, runtime hook
callbacks, hook registration, `reload`, and `Registration.dispose`. Transform
editor callbacks remain synchronous.

## Defining A Plugin

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  setup: async (ctx) => {
    await ctx.provider.transform((editor) => {
      editor.update("example", (provider) => {
        provider.name = "Example"
      })
    })
  },
})
```

Plugin setup registers hooks imperatively through each domain's `hook` method.
It may return a synchronous or asynchronous cleanup function. OpenCode awaits
the cleanup when the plugin is unloaded or replaced:

```ts
setup: async (ctx) => {
  const timer = setInterval(refresh, 60_000)
  return () => clearInterval(timer)
}
```

Configuration supplied for the plugin is available as `ctx.options`.

A registration may be removed early through `dispose`:

```ts
const registration = await ctx.model.transform(applyModelPolicy)
await registration.dispose()
```

## Transform Hooks

Transform hooks contribute to stateful domains. The editor is synchronous,
so load asynchronous data before registering a transform or reloading its domain:

```ts
const description = await loadReviewerDescription()

await ctx.agent.transform((agent) => {
  agent.update("reviewer", (item) => {
    item.description = description
    item.mode = "subagent"
  })
})
```

Available transform hooks are namespaced by domain:

```ts
ctx.agent.transform
ctx.command.transform
ctx.integration.transform
ctx.mcp.transform
ctx.model.transform
ctx.provider.transform
ctx.reference.transform
ctx.skill.transform
ctx.tool.transform
ctx.vcs.transform
ctx.websearch.transform
```

Provider transforms contribute provider settings and immutable model definitions. After provider availability is resolved,
model transforms edit the complete active-provider candidate collection in order. Use `ctx.model.transform` for runtime
model restrictions; `editor.provider.get()` reads source templates even when their provider is inactive.

```ts
await ctx.model.transform((editor) => {
  editor
    .list()
    .filter((model) => model.cost.some((tier) => tier.output > 20))
    .forEach((model) => {
      editor.remove(model.providerID, model.id)
    })
})
```

## Runtime Hooks

Runtime hooks intercept live operations:

```ts
await ctx.aisdk.hook("sdk", async (event) => {
  if (event.package !== "@ai-sdk/xai") return
  const mod = await import("@ai-sdk/xai")
  event.sdk = mod.createXai(event.options)
})

await ctx.aisdk.hook("language", (event) => {
  if (event.model.providerID !== "xai") return
  event.language = event.sdk.responses(event.model.modelID)
})
```

Session context is mutable immediately before provider dispatch:

```ts
await ctx.session.hook("context", (event) => {
  event.tools.read.description = "Read a file using narrow line ranges."
  delete event.tools.write
})

await ctx.session.hook("retry", (event) => {
  if (event.attempt >= 3) event.decision = { retry: false }
})
```

Promise tools use complete executable tool values with async executors:

```ts
import { Schema } from "effect"

await ctx.tool.transform((tools) => {
  tools.add({
    name: "echo",
    options: { codemode: false },
    description: "Echo text",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: async ({ text }) => ({ output: { text }, content: text }),
  })
})
```

## Reloading A Domain

When data captured by a transform changes, reload the affected domain:

```ts
const source = { providers: await loadProviders() }

await ctx.provider.transform((editor) => {
  source.providers.forEach((provider) => editor.add(provider))
})

source.providers = await loadProviders()
await ctx.provider.reload()
```

`loadProviders()` returns entries shaped as `{ info: Provider.Info, models: readonly Model.Info[] }`. Provider reloads
also invalidate the active model result, so every model transform runs again with the refreshed definitions. Model
callbacks edit raw overrides; provider defaults are merged once when the result is committed.

Available reload operations are:

```ts
ctx.agent.reload()
ctx.command.reload()
ctx.integration.reload()
ctx.mcp.reload()
ctx.model.reload()
ctx.provider.reload()
ctx.reference.reload()
ctx.skill.reload()
ctx.tool.reload()
ctx.vcs.reload()
ctx.websearch.reload()
```

## Reading Server State

Child sessions are read-only through the session domain. Pass `parentID` to
enumerate a session's subagent sessions, for example for a per-subagent cost
breakdown:

```ts
const children = await ctx.session.list({ parentID: sessionID })
for (const child of children.data) {
  // child.parentID === sessionID
}
if (children.cursor.next) {
  const next = await ctx.session.list({ parentID: sessionID, cursor: children.cursor.next })
}
```

`parentID: null` lists root sessions. Results otherwise match the HTTP
`session.list` endpoint: `{ data, cursor }`.

Live provider pricing is already on the model catalog. `ctx.model.list()`
returns `{ location, data }`, where each `Model.Info` entry's `cost` is an
array of USD-per-million-tokens rates (`input`, `output`, `cache.read`,
`cache.write`):

```ts
const { data: models } = await ctx.model.list()
const rate = models.find((model) => model.id === "example-model")?.cost[0]
```

Multiplying those rates by observed token usage is plugin-side. The agent and
skill catalogs enumerate the same way (`ctx.agent.list()`,
`ctx.skill.list()`); estimating their token cost is likewise plugin-side, the
server does not report it.

`ctx.serverUrl` is the active server listener URL (for example
`http://127.0.0.1:4096`), or `undefined` on hosts without a listener such as
embedded SDK hosts. In-process domain calls are already authenticated, which
is the documented equivalent of v1's `client`: prefer `ctx.session`,
`ctx.model`, and the other domains over raw HTTP, and only use `serverUrl`
when a raw HTTP(S) URL is needed.

`ctx.session.context` returns the messages since the last compaction — the
context the model will see, by design. Full pre-compaction history is not
exposed; file a follow-up if a plugin needs it.
