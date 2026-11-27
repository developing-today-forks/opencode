import { Agent } from "@opencode/schema/agent";
import { Document, Info } from "@opencode/schema/config";
import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Config } from "@opencode/core/config";
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider";
import { Credential } from "@opencode/core/credential";
import { Integration } from "@opencode/core/integration";
import { Model } from "@opencode/core/model";
import { Plugin } from "@opencode/core/plugin";
import { PluginHost } from "@opencode/core/plugin/host";
import { PluginHooks } from "@opencode/core/plugin/hooks";
import { ChatGPTPlugin } from "@opencode/core/plugin/provider/chatgpt";
import { ProviderInstancePlugin, configuredInstances, instanceLabel } from "@opencode/core/plugin/provider/instance";
import { Provider } from "@opencode/core/provider";
import { Session } from "@opencode/core/session";
import { testEffect } from "../lib/effect";
import { PluginTestLayer } from "./fixture";
const it = testEffect(PluginTestLayer);
const decode = Schema.decodeUnknownSync(Info);
const work = Provider.ID.make("openai.work");
const document = (providers) => new Document({ type: "document", info: decode({ providers }) });
const unavailableModels = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 503 }))));
// Stands in for the models.dev catalog entry that every OpenAI connection starts from.
const seedCatalog = Effect.fn(function* () {
    const providers = yield* Provider.Service;
    const integrations = yield* Integration.Service;
    yield* integrations.transform((editor) => {
        editor.update(Integration.ID.make("openai"), (integration) => {
            integration.name = "OpenAI";
        });
        editor.method.update({ integrationID: Integration.ID.make("openai"), method: { type: "key" } });
        editor.method.update({
            integrationID: Integration.ID.make("openai"),
            method: { type: "env", names: ["OPENAI_API_KEY"] },
        });
    });
    yield* providers.transform((editor) => {
        editor.update(Provider.ID.openai, (provider) => {
            provider.name = "OpenAI";
            provider.package = "@opencode/ai/providers/openai";
            provider.integrationID = Integration.ID.make("openai");
        });
        editor.models.update(Provider.ID.openai, Model.ID.make("gpt-5.5"), () => { });
        editor.models.update(Provider.ID.openai, Model.ID.make("gpt-4.1"), () => { });
    });
});
const addPlugins = Effect.fn(function* (entries) {
    const plugin = yield* Plugin.Service;
    const config = Config.testLayer(entries);
    yield* seedCatalog();
    yield* ProviderInstancePlugin.effect(yield* PluginHost.make(plugin, ProviderInstancePlugin.id)).pipe(Effect.provide(config));
    yield* ChatGPTPlugin.effect(yield* PluginHost.make(plugin, ChatGPTPlugin.id)).pipe(Effect.provideService(HttpClient.HttpClient, unavailableModels), Effect.provide(config));
    yield* ConfigProviderPlugin.Plugin.effect(yield* PluginHost.make(plugin, ConfigProviderPlugin.Plugin.id)).pipe(Effect.provide(config));
});
const chatgpt = (access) => Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("chatgpt-token-sharing"),
    access,
    refresh: "refresh",
    expires: Date.now() + 60 * 60000,
    metadata: { clientID: "oaiapp_issued" },
});
const request = Effect.fn(function* (providerID) {
    const hooks = yield* PluginHooks.Service;
    const event = yield* hooks.trigger("session", "model.request", {
        sessionID: Session.ID.make("ses_instance"),
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ providerID, id: Model.ID.make("gpt-5.5") }),
        kind: "primary",
        baseURL: "https://api.openai.com/v1",
        headers: {},
    });
    return event.headers;
});
describe("configuredInstances", () => {
    it.effect("maps instances to their base and ignores copies of copies", () => Effect.sync(() => {
        const instances = configuredInstances([
            document({ "openai.work": { instanceOf: "openai" }, anthropic: {} }),
            document({ "openai.work.nested": { instanceOf: "openai.work" }, "anthropic.2": { instanceOf: "anthropic" } }),
        ]);
        expect(Array.from(instances)).toEqual([
            [work, Provider.ID.openai],
            [Provider.ID.make("anthropic.2"), Provider.ID.anthropic],
        ]);
        expect(instanceLabel("openai.work", "openai")).toBe("work");
        expect(instanceLabel("codex2", "openai")).toBe("codex2");
    }));
});
describe("ProviderInstancePlugin", () => {
    it.effect("serves an API key account and a ChatGPT account at the same time", () => Effect.gen(function* () {
        const credentials = yield* Credential.Service;
        const providers = yield* Provider.Service;
        const models = yield* Model.Service;
        const integrations = yield* Integration.Service;
        yield* credentials.create({
            integrationID: Integration.ID.make("openai"),
            value: Credential.Key.make({ type: "key", key: "sk-base" }),
        });
        yield* credentials.create({ integrationID: Integration.ID.make(work), value: chatgpt("work-token") });
        yield* addPlugins([document({ "openai.work": { instanceOf: "openai" } })]);
        const instance = yield* providers.get(work);
        expect(instance).toMatchObject({
            id: work,
            name: "OpenAI (work)",
            canonical: Provider.ID.openai,
            integrationID: Integration.ID.make(work),
            instanceOf: Provider.ID.openai,
            activation: "auto",
        });
        expect(instance?.settings?.baseURL).toBe("https://api.openai.com/v1");
        expect((yield* providers.get(Provider.ID.openai))?.settings?.baseURL).toBeUndefined();
        expect((yield* providers.available()).map((provider) => provider.id)).toEqual(expect.arrayContaining([Provider.ID.openai, work]));
        // The ChatGPT account keeps only the subscription's models; the API key account keeps the catalog.
        expect((yield* models.get(work, Model.ID.make("gpt-5.5")))?.cost).toEqual([]);
        expect(yield* models.get(work, Model.ID.make("gpt-4.1"))).toBeUndefined();
        expect((yield* models.get(Provider.ID.openai, Model.ID.make("gpt-4.1")))?.enabled).toBe(true);
        expect(yield* request(work)).toMatchObject({ "thread-id": "ses_instance" });
        expect(yield* request(Provider.ID.openai)).toEqual({});
        const methods = (yield* integrations.get(Integration.ID.make(work)))?.methods ?? [];
        expect(methods.map((method) => method.type).toSorted()).toEqual(["key", "oauth"]);
        expect((yield* integrations.get(Integration.ID.make(work)))?.name).toBe("OpenAI (work)");
    }));
    it.effect("keeps an instance unavailable until its own account connects", () => Effect.gen(function* () {
        const credentials = yield* Credential.Service;
        const providers = yield* Provider.Service;
        yield* credentials.create({
            integrationID: Integration.ID.make("openai"),
            value: Credential.Key.make({ type: "key", key: "sk-base" }),
        });
        yield* addPlugins([document({ "openai.work": { instanceOf: "openai", name: "OpenAI Work" } })]);
        expect((yield* providers.get(work))?.name).toBe("OpenAI Work");
        expect((yield* providers.available()).map((provider) => provider.id)).not.toContain(work);
        yield* credentials.create({ integrationID: Integration.ID.make(work), value: chatgpt("work-token") });
        // Availability follows the instance's own credential, never the base's.
        yield* Effect.yieldNow;
        expect((yield* providers.available()).map((provider) => provider.id)).toContain(work);
    }));
});
