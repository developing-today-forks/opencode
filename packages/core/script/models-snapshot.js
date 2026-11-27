import { Effect, Schema } from "effect";
import { deadlineSignal, readBoundedResponseText } from "@opencode/util/http-body";
import { ModelsDev } from "../src/models-dev";
// A floor, not equality: guards against an error page or a truncated body
// that still parses as a small object.
const MINIMUM_PROVIDERS = 100;
// Bounded by default (#1127): a stalled endpoint must not hang the refresh
// and an oversized body must not land in the committed snapshot. The real
// catalog is ~6 MB (235 providers, measured 2026-11-01); 32 MiB leaves >5x
// headroom while still refusing a hostile or broken response.
const FETCH_DEADLINE_MS = 30000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const committedSnapshot = new URL("../src/models-dev/snapshot.txt", import.meta.url);
export async function fetchModelsSnapshot() {
    const source = process.env.OPENCODE_MODELS_URL || "https://models.opencode.ai";
    const url = `${source}${ModelsDev.catalogPath}`;
    const response = await fetch(url, { signal: deadlineSignal(undefined, FETCH_DEADLINE_MS) });
    if (!response.ok)
        throw new Error(`${url} returned ${response.status} ${response.statusText}`);
    const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES, () => new Error(`Catalog response from ${url} exceeded the ${MAX_RESPONSE_BYTES}-byte cap`));
    return validateModelsSnapshot(trim(text));
}
// Model fields opencode never reads. Dropping them keeps the bundled copy small; every
// other field, including ones models.dev adds later, is kept as published.
const UNUSED_MODEL_FIELDS = new Set([
    "description",
    "canonical_id",
    "knowledge",
    "last_updated",
    "deprecation_date",
    "open_weights",
    "metadata",
]);
const Catalog = Schema.fromJsonString(Schema.Record(Schema.String, Schema.StructWithRest(Schema.Struct({ models: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)) }), [Schema.Record(Schema.String, Schema.Unknown)])));
function trim(text) {
    const catalog = Schema.decodeUnknownSync(Catalog)(text);
    return JSON.stringify(Object.fromEntries(Object.entries(catalog).map(([id, provider]) => [
        id,
        {
            ...provider,
            models: Object.fromEntries(Object.entries(provider.models).map(([modelID, model]) => [
                modelID,
                Object.fromEntries(Object.entries(model).filter(([key]) => !UNUSED_MODEL_FIELDS.has(key))),
            ])),
        },
    ])));
}
async function validateModelsSnapshot(text) {
    const providers = (await Effect.runPromise(ModelsDev.decodeSnapshot(text))).length;
    if (providers < MINIMUM_PROVIDERS)
        throw new Error(`models.dev catalog has ${providers} providers, expected at least ${MINIMUM_PROVIDERS}`);
    return { text, providers };
}
export async function bundledModelsSnapshot() {
    const file = process.env.OPENCODE_MODELS_SNAPSHOT;
    if (!file)
        return Bun.file(committedSnapshot).text();
    const snapshot = await validateModelsSnapshot(await Bun.file(file).text());
    console.log(`bundling models.dev catalog from ${file} (${snapshot.providers} providers)`);
    return snapshot.text;
}
export function modelsSnapshotPlugin(text) {
    return {
        name: "opencode-models-snapshot",
        setup(build) {
            build.onLoad({ filter: /models-dev[/\\]snapshot\.txt$/ }, () => ({ contents: text, loader: "text" }));
        },
    };
}
