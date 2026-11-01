export * as ConfigMessaging from "./messaging.js"

import { Schema } from "effect"
import { PositiveInt, optional } from "../schema.js"

const Delivery = Schema.Literals(["none", "inbox", "wake"])

export class Remote extends Schema.Class<Remote>("Config.Messaging.Remote")({
  url: Schema.String.annotate({
    description: "Base URL of an OpenAI-compatible API, for example https://api.openai.com/v1",
  }),
  model: Schema.String.annotate({ description: "Embedding model name" }),
  key: Schema.String.annotate({
    description: "API key; {env:NAME} reads it from the environment",
  }).pipe(optional),
  dimensions: PositiveInt.pipe(optional),
}) {}

export class Embedding extends Schema.Class<Embedding>("Config.Messaging.Embedding")({
  tier: Schema.String.annotate({
    description: 'Built-in model tier: "tiny", "default", "step-up", "top", or "off" (default: "default")',
  }).pipe(optional),
  url: Schema.String.annotate({ description: "GGUF download URL used instead of the tier's model" }).pipe(optional),
  sha256: Schema.String.annotate({
    description: "Expected SHA-256 of the custom GGUF file; verified after download when set",
  }).pipe(optional),
  size: PositiveInt.annotate({
    description: "Expected size in bytes of the custom GGUF file; bounds the download exactly when set",
  }).pipe(optional),
  path: Schema.String.annotate({ description: "Existing local GGUF file used instead of downloading" }).pipe(optional),
  pooling: Schema.Literals(["last", "mean", "cls"])
    .annotate({
      description:
        "Pooling override (default: the tier's pooling; for a custom model, last for Qwen3 embedding files and mean otherwise)",
    })
    .pipe(optional),
  query: Schema.String.annotate({
    description: "Instruction prefix for search queries, replacing the tier's prefix; the remote endpoint uses it too",
  }).pipe(optional),
  server: Schema.String.annotate({
    description: "llama-server executable to use instead of the downloaded llama.cpp build",
  }).pipe(optional),
  autostart: Schema.Boolean.annotate({
    description: "Download and start the model in the background at startup (default: true)",
  }).pipe(optional),
  gpu_layers: Schema.Int.annotate({ description: "Layers to offload to the GPU (default: all)" }).pipe(optional),
  threads: PositiveInt.pipe(optional),
  remote: Remote.annotate({
    description: "Embeddings endpoint used when the local model is unavailable, or always when the tier is off",
  }).pipe(optional),
}) {}

export class Search extends Schema.Class<Search>("Config.Messaging.Search")({
  match: Schema.Literals(["exact", "regex", "fuzzy", "semantic", "hybrid", "advanced"])
    .annotate({
      description: 'Default match mode for message and log searches (default: "hybrid")',
    })
    .pipe(optional),
  model: Schema.String.annotate({
    description:
      "Fast model (provider/model) that reranks advanced searches; defaults to the session provider's small model",
  }).pipe(optional),
}) {}

export class Info extends Schema.Class<Info>("Config.Messaging")({
  presets: Schema.Record(Schema.String, Schema.String)
    .annotate({
      description: "Topic presets: name to template, overriding or extending the built-in presets",
    })
    .pipe(optional),
  vars: Schema.Record(Schema.String, Schema.String)
    .annotate({
      description: "Template variables: name to value or template, overriding or extending the built-in variables",
    })
    .pipe(optional),
  session_start: Schema.String.annotate({
    description:
      "Template added to every session's instructions when it starts (default: the current date, time and timezone). An empty string disables it",
  }).pipe(optional),
  delivery: Schema.Struct({
    direct: Delivery.annotate({ description: 'Direct messages (default: "wake")' }).pipe(optional),
    root: Delivery.annotate({ description: 'Messages to the root topic (default: "wake")' }).pipe(optional),
    user: Schema.Literals(["hidden", "visible", "wake"])
      .annotate({
        description: 'Whether the root session sees messages sent to the user (default: "visible")',
      })
      .pipe(optional),
  })
    .annotate({ description: "Default delivery of messages into sessions" })
    .pipe(optional),
  search: Search.pipe(optional),
  embedding: Schema.Union([Schema.String, Embedding])
    .annotate({
      description:
        'Local embedding model: a tier name ("tiny", "default", "step-up", "top", "off") or detailed settings',
    })
    .pipe(optional),
}) {}
