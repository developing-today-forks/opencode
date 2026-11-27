var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { afterAll, describe, expect, test } from "bun:test";
import { OAuthError, UnauthorizedError } from "@modelcontextprotocol/client";
import path from "path";
import { ConfigMCP } from "@opencode/schema/config/mcp";
import { Credential } from "@opencode/core/credential";
import { Database } from "@opencode/core/database/database";
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder";
import { Integration } from "@opencode/core/integration";
import { McpClient } from "@opencode/core/mcp/client";
import { McpOAuth } from "@opencode/core/mcp/oauth";
import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { hostEnvironmentLayer } from "./fixture/environment";
import { tmpdir } from "./fixture/tmpdir";
const authServer = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
afterAll(() => authServer.stop(true));
const integrationID = Integration.ID.make("mcp_test");
const methodID = Integration.MethodID.make("oauth");
const remote = (url) => new ConfigMCP.Remote({ type: "remote", url, oauth: { client_id: "client" } });
const credential = (input) => new Credential.Info({
    id: Credential.ID.make("cred_test"),
    integrationID,
    label: "test",
    value: {
        type: "oauth",
        methodID,
        access: input.access,
        refresh: input.refresh,
        expires: input.expires ?? Date.now() - 1000,
        metadata: { serverUrl: input.url, tokenType: "Bearer" },
    },
});
// Connect-time providers read and write the credential store; this one lives in memory so tests can
// inspect the row the provider leaves behind.
const memoryCredentials = (initial) => {
    const rows = new Map(initial.map((row) => [row.id, row]));
    const unused = () => Effect.die("unused credential method");
    const service = Credential.Service.of({
        refresh: unused,
        all: unused,
        create: unused,
        activate: unused,
        list: (id) => Effect.sync(() => Array.from(rows.values()).filter((row) => row.integrationID === id)),
        get: (id) => Effect.sync(() => rows.get(id)),
        update: (id, updates) => Effect.sync(() => {
            const row = rows.get(id);
            if (row)
                rows.set(id, new Credential.Info({ ...row, ...updates }));
        }),
        remove: (id) => Effect.sync(() => void rows.delete(id)),
    });
    return { rows, service };
};
// Serves authorization server metadata with the given capabilities and records DCR + token requests.
const authorizationServer = (metadata) => {
    const registrations = [];
    const tokenRequests = [];
    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/.well-known/oauth-authorization-server")
                return Response.json({
                    issuer: url.origin,
                    authorization_endpoint: `${url.origin}/authorize`,
                    token_endpoint: `${url.origin}/token`,
                    registration_endpoint: `${url.origin}/register`,
                    response_types_supported: ["code"],
                    ...metadata,
                });
            if (request.method === "POST" && url.pathname === "/register") {
                registrations.push(await request.json());
                return Response.json({ client_id: "registered", redirect_uris: [] });
            }
            if (request.method === "POST" && url.pathname === "/token") {
                tokenRequests.push(new URLSearchParams(await request.text()));
                return Response.json({ access_token: "access", token_type: "Bearer" });
            }
            return new Response(null, { status: 404 });
        },
    });
    return { server, registrations, tokenRequests };
};
const start = (target, oauth, store = memoryCredentials([])) => Effect.gen(function* () {
    const authorization = yield* McpOAuth.authorize({
        name: "test",
        config: new ConfigMCP.Remote({
            type: "remote",
            url: typeof target === "string" ? target : target.url.href,
            ...(oauth ? { oauth } : {}),
        }),
        integrationID,
        methodID,
    });
    return { authorization, url: new URL(authorization.url) };
}).pipe(Effect.provideService(Credential.Service, store.service));
const authorize = (redirect_uri) => Effect.runPromise(Effect.scoped(start(authServer, { client_id: "client", ...(redirect_uri ? { redirect_uri } : {}) }).pipe(Effect.map(({ url }) => url.searchParams.get("redirect_uri")))));
describe("MCP OAuth", () => {
    test("completes interactive authorization through the loopback callback", async () => {
        const tokenRequests = [];
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                if (request.method !== "POST" || url.pathname !== "/token")
                    return new Response(null, { status: 404 });
                tokenRequests.push(new URLSearchParams(await request.text()));
                return Response.json({
                    access_token: "access",
                    token_type: "Bearer",
                    refresh_token: "refresh",
                    expires_in: 3600,
                });
            },
        });
        const credential = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const { authorization, url: authorizationUrl } = yield* start(server, { client_id: "client" });
            const redirectValue = authorizationUrl.searchParams.get("redirect_uri");
            const state = authorizationUrl.searchParams.get("state");
            if (!redirectValue || !state)
                throw new Error("Missing OAuth redirect parameters");
            const redirect = new URL(redirectValue);
            redirect.searchParams.set("code", "accepted");
            redirect.searchParams.set("state", state);
            expect((yield* Effect.promise(() => fetch(redirect))).status).toBe(200);
            expect((yield* Effect.promise(() => fetch(redirect))).status).toBe(409);
            return yield* authorization.callback;
        }))).finally(() => server.stop(true));
        expect(credential.access).toBe("access");
        expect(credential.refresh).toBe("refresh");
        expect(tokenRequests).toHaveLength(1);
        expect(tokenRequests[0]?.get("grant_type")).toBe("authorization_code");
        expect(tokenRequests[0]?.get("code")).toBe("accepted");
        expect(tokenRequests[0]?.get("code_verifier")).not.toBeNull();
        expect(tokenRequests[0]?.get("resource")).toBe(server.url.href);
        expect(credential.metadata?.discovery).toEqual({ authorizationServer: server.url.href, resource: server.url.href });
    });
    test("keeps waiting for the redirect after callback requests without OAuth parameters", async () => {
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                if (request.method !== "POST" || new URL(request.url).pathname !== "/token")
                    return new Response(null, { status: 404 });
                return Response.json({
                    access_token: "access",
                    token_type: "Bearer",
                    refresh_token: "refresh",
                    expires_in: 3600,
                });
            },
        });
        const credential = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const { authorization, url: authorizationUrl } = yield* start(server, { client_id: "client" });
            const redirectValue = authorizationUrl.searchParams.get("redirect_uri");
            const state = authorizationUrl.searchParams.get("state");
            if (!redirectValue || !state)
                throw new Error("Missing OAuth redirect parameters");
            const callback = new URL(redirectValue);
            expect((yield* Effect.promise(() => fetch(callback, { method: "OPTIONS" }))).status).toBe(400);
            expect((yield* Effect.promise(() => fetch(callback))).status).toBe(400);
            callback.searchParams.set("code", "accepted");
            callback.searchParams.set("state", state);
            expect((yield* Effect.promise(() => fetch(callback))).status).toBe(200);
            return yield* authorization.callback;
        }))).finally(() => server.stop(true));
        expect(credential.access).toBe("access");
    });
    test("completes from a pasted redirect URL and keeps waiting after a wrong paste", async () => {
        const tokenRequests = [];
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                if (request.method !== "POST" || new URL(request.url).pathname !== "/token")
                    return new Response(null, { status: 404 });
                tokenRequests.push(new URLSearchParams(await request.text()));
                return Response.json({
                    access_token: "access",
                    token_type: "Bearer",
                    refresh_token: "refresh",
                    expires_in: 3600,
                });
            },
        });
        const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const { authorization, url: authorizationUrl } = yield* start(server, { client_id: "client" });
            const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
            redirect.searchParams.set("code", "pasted");
            redirect.searchParams.set("state", "another-sign-in");
            const rejected = yield* Effect.flip(authorization.submit(redirect.href));
            const notURL = yield* Effect.flip(authorization.submit("pasted"));
            redirect.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
            yield* authorization.submit(` ${redirect.href}\n`);
            return { rejected, notURL, credential: yield* authorization.callback };
        }))).finally(() => server.stop(true));
        expect(result.rejected.message).toBe("This URL belongs to a different sign-in");
        expect(result.notURL.message).toBe("Paste the full URL from the browser's address bar");
        expect(result.credential.access).toBe("access");
        expect(tokenRequests).toHaveLength(1);
        expect(tokenRequests[0]?.get("code")).toBe("pasted");
    });
    test("does not let an invalid callback prevent a later valid callback", async () => {
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                if (request.method !== "POST" || new URL(request.url).pathname !== "/token")
                    return new Response(null, { status: 404 });
                return Response.json({ access_token: "access", token_type: "Bearer" });
            },
        });
        const credential = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const { authorization, url } = yield* start(server, { client_id: "client" });
            const redirect = new URL(url.searchParams.get("redirect_uri"));
            redirect.searchParams.set("state", "invalid");
            redirect.searchParams.set("code", "forged");
            expect((yield* Effect.promise(() => fetch(redirect))).status).toBe(400);
            redirect.searchParams.set("state", url.searchParams.get("state"));
            redirect.searchParams.set("code", "accepted");
            expect((yield* Effect.promise(() => fetch(redirect))).status).toBe(200);
            return yield* authorization.callback;
        }))).finally(() => server.stop(true));
        expect(credential.access).toBe("access");
    });
    test("fails the authorization for a provider error with valid state", async () => {
        const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
        const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const { authorization, url } = yield* start(server, { client_id: "client" });
            const redirect = new URL(url.searchParams.get("redirect_uri"));
            redirect.searchParams.set("state", url.searchParams.get("state"));
            redirect.searchParams.set("error", "access_denied");
            expect((yield* Effect.promise(() => fetch(redirect))).status).toBe(400);
            return yield* Effect.exit(authorization.callback);
        }))).finally(() => server.stop(true));
        expect(exit._tag).toBe("Failure");
    });
    test("reports a rejected token exchange on the callback page", async () => {
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                if (request.method !== "POST" || new URL(request.url).pathname !== "/token")
                    return new Response(null, { status: 404 });
                return Response.json({ error: "invalid_client", error_description: "bad_client_secret" }, { status: 400 });
            },
        });
        const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const { authorization, url: authorizationUrl } = yield* start(server, { client_id: "client" });
            const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
            redirect.searchParams.set("code", "accepted");
            redirect.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
            const response = yield* Effect.promise(() => fetch(redirect));
            const page = yield* Effect.promise(() => response.text());
            const exit = yield* Effect.exit(authorization.callback);
            return { status: response.status, page, exit };
        }))).finally(() => server.stop(true));
        expect(result.status).toBe(400);
        expect(result.page).toContain("Authorization failed");
        expect(result.page).toContain("bad_client_secret");
        expect(result.exit._tag).toBe("Failure");
    });
    test("resolves an over-cap streamed clone without consuming the original", async () => {
        // Regression (Codex P1 on #1603): the bounded reader awaited cancellation of
        // the tee'd clone at the cap, which pends until the original branch is
        // consumed — but the caller awaits this read first, deadlocking oversized
        // streamed rejections. The excerpt read must resolve on its own.
        const chunk = new Uint8Array(32 * 1024).fill(120);
        const response = new Response(new ReadableStream({
            start(controller) {
                for (let index = 0; index < 5; index++)
                    controller.enqueue(chunk);
                controller.close();
            },
        }), { status: 400, headers: { "content-type": "application/json" } });
        const parsed = await Promise.race([
            McpOAuth.parseErrorBody(response.clone()),
            new Promise((_, reject) => setTimeout(() => reject(new Error("error-body read deadlocked")), 5000)),
        ]);
        expect(parsed).toBeUndefined();
    });
    test("parses a small OAuth error body and yields no parsed error for an over-cap one", async () => {
        const small = new Response(JSON.stringify({ error: "invalid_grant", error_description: "refresh token revoked" }), { status: 400 });
        const parsed = await McpOAuth.parseErrorBody(small);
        expect(parsed?.code).toBe("invalid_grant");
        expect(parsed?.message).toContain("refresh token revoked");
        const overCap = new Response(JSON.stringify({ error: "invalid_grant", error_description: "x".repeat(McpOAuth.ERROR_RESPONSE_MAX_BYTES + 1) }), { status: 400 });
        expect(await McpOAuth.parseErrorBody(overCap)).toBeUndefined();
    });
    test("generates a loopback redirect URL when none is configured", async () => {
        expect(await authorize()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    });
    test("preserves a configured redirect URL and fixed port", async () => {
        const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
        const redirect = `http://127.0.0.1:${reservation.port}/fixed-callback`;
        reservation.stop(true);
        expect(await authorize(redirect)).toBe(redirect);
    });
    test("rejects an invalid redirect URL", async () => {
        await expect(authorize("not a URL")).rejects.toThrow(TypeError);
    });
    test("rejects an authorization endpoint that is not http or https", async () => {
        const { server } = authorizationServer({ authorization_endpoint: "file:///tmp/authorize" });
        await expect(Effect.runPromise(Effect.scoped(start(server))).finally(() => server.stop(true))).rejects.toThrow("returned a file: authorization URL");
    });
    test("finds resource metadata through the 401 header when the well-known path is not served", async () => {
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                const url = new URL(request.url);
                if (url.pathname === "/mcp")
                    return new Response(null, {
                        status: 401,
                        headers: { "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/custom/metadata"` },
                    });
                if (url.pathname === "/custom/metadata")
                    return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [`${url.origin}/as`] });
                if (url.pathname === "/.well-known/oauth-authorization-server/as")
                    return Response.json({
                        issuer: `${url.origin}/as`,
                        authorization_endpoint: `${url.origin}/as/authorize`,
                        token_endpoint: `${url.origin}/as/token`,
                        response_types_supported: ["code"],
                    });
                return new Response(null, { status: 404 });
            },
        });
        const { url } = await Effect.runPromise(Effect.scoped(start(`${server.url.origin}/mcp`, { client_id: "client" }))).finally(() => server.stop(true));
        expect(url.pathname).toBe("/as/authorize");
    });
    test("uses configured authorization server metadata when the resource publishes none", async () => {
        const { server: issuer } = authorizationServer({});
        const resource = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
        const url = `${resource.url.origin}/mcp`;
        const oauth = {
            client_id: "client",
            auth_server_metadata_url: `${issuer.url.origin}/.well-known/oauth-authorization-server`,
        };
        const { url: authorization } = await Effect.runPromise(Effect.scoped(start(url, oauth)));
        expect(authorization.origin).toBe(issuer.url.origin);
        expect(authorization.pathname).toBe("/authorize");
        expect(authorization.searchParams.get("resource")).toBe(url);
        resource.stop(true);
        issuer.stop(true);
    });
    test("requests offline_access without forcing a consent prompt", async () => {
        const { server } = authorizationServer({ scopes_supported: ["read", "offline_access"] });
        const { url } = await Effect.runPromise(Effect.scoped(start(server, { client_id: "client", scope: "read" }))).finally(() => server.stop(true));
        expect(url.searchParams.get("scope")).toBe("read offline_access");
        expect(url.searchParams.has("prompt")).toBe(false);
    });
    test("forwards iss from the redirect so issuer-advertising servers can complete", async () => {
        const { server } = authorizationServer({ authorization_response_iss_parameter_supported: true });
        const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const { authorization, url } = yield* start(server);
            const redirect = new URL(url.searchParams.get("redirect_uri"));
            redirect.searchParams.set("code", "accepted");
            redirect.searchParams.set("state", url.searchParams.get("state"));
            redirect.searchParams.set("iss", server.url.origin);
            yield* Effect.promise(() => fetch(redirect));
            return yield* authorization.callback;
        }))).finally(() => server.stop(true));
        expect(result.access).toBe("access");
    });
    describe("client registration", () => {
        const cimd = { client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ["none"] };
        test("uses the client metadata document when the server supports public CIMD clients", async () => {
            const { server, registrations, tokenRequests } = authorizationServer(cimd);
            const credential = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
                const { authorization, url } = yield* start(server);
                expect(url.searchParams.get("client_id")).toBe(McpOAuth.CLIENT_METADATA_URL);
                const redirect = new URL(url.searchParams.get("redirect_uri"));
                redirect.searchParams.set("code", "accepted");
                redirect.searchParams.set("state", url.searchParams.get("state"));
                yield* Effect.promise(() => fetch(redirect));
                return yield* authorization.callback;
            }))).finally(() => server.stop(true));
            expect(registrations).toHaveLength(0);
            expect(tokenRequests[0]?.get("client_id")).toBe(McpOAuth.CLIENT_METADATA_URL);
            expect(McpOAuth.clientFromCredential(credential)).toEqual({
                client_id: McpOAuth.CLIENT_METADATA_URL,
                issuer: server.url.origin,
            });
        });
        test("registers dynamically when the server does not accept public clients", async () => {
            const { server, registrations } = authorizationServer({
                client_id_metadata_document_supported: true,
                token_endpoint_auth_methods_supported: ["client_secret_post"],
            });
            const { url } = await Effect.runPromise(Effect.scoped(start(server))).finally(() => server.stop(true));
            expect(url.searchParams.get("client_id")).toBe("registered");
            expect(registrations).toHaveLength(1);
            expect(registrations[0]).toMatchObject({
                client_name: "opencode",
                client_uri: "https://opencode.ai",
                logo_uri: "https://opencode.ai/web-app-manifest-512x512.png",
            });
        });
        test("redeems the code with the localhost redirect a server sent the browser back to", async () => {
            const { server, registrations, tokenRequests } = authorizationServer({});
            const sent = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
                const { authorization, url } = yield* start(server);
                const redirect = new URL(url.searchParams.get("redirect_uri"));
                redirect.searchParams.set("code", "accepted");
                redirect.searchParams.set("state", url.searchParams.get("state"));
                // Clerk's consent page rewrites 127.0.0.1 to localhost; the browser reaches the same listener.
                yield* Effect.promise(() => fetch(redirect, { headers: { host: `localhost:${redirect.port}` } }));
                yield* authorization.callback;
                return redirect;
            }))).finally(() => server.stop(true));
            expect(registrations[0]).toMatchObject({
                redirect_uris: [`http://127.0.0.1:${sent.port}/callback`, `http://localhost:${sent.port}/callback`],
            });
            expect(tokenRequests[0]?.get("redirect_uri")).toBe(`http://localhost:${sent.port}/callback`);
        });
        test("reuses the client registered by an earlier login", async () => {
            const { server, registrations } = authorizationServer({});
            const previous = credential({ access: "a", refresh: "r", url: server.url.href });
            const client = { client_id: "registered", issuer: server.url.origin };
            const store = memoryCredentials([
                new Credential.Info({ ...previous, value: { ...previous.value, metadata: { client } } }),
            ]);
            const { url } = await Effect.runPromise(Effect.scoped(start(server, undefined, store))).finally(() => server.stop(true));
            expect(url.searchParams.get("client_id")).toBe("registered");
            expect(registrations).toHaveLength(0);
        });
        test("registers dynamically when a custom redirect_uri is configured", async () => {
            const { server, registrations } = authorizationServer(cimd);
            const { url } = await Effect.runPromise(Effect.scoped(start(server, { redirect_uri: "http://127.0.0.1:0/custom" }))).finally(() => server.stop(true));
            expect(url.searchParams.get("client_id")).toBe("registered");
            expect(registrations).toHaveLength(1);
        });
    });
    describe("credential expiry validation", () => {
        const DAY = 24 * 60 * 60;
        const stored = (expires_in) => ({
            access_token: "access",
            token_type: "Bearer",
            ...(expires_in === undefined ? {} : { expires_in }),
        });
        const credentialFor = (expires_in) => McpOAuth.toCredential({
            methodID,
            serverUrl: "https://example.com/mcp",
            tokens: stored(expires_in),
            client: undefined,
            discovery: undefined,
        });
        test("treats a negative expires_in as non-expiring, not a born-expired credential", () => {
            const credential = credentialFor(-3600);
            expect(credential.expires).toBe(0);
        });
        test("keeps absent and zero expires_in non-expiring", () => {
            expect(credentialFor(undefined).expires).toBe(0);
            expect(credentialFor(0).expires).toBe(0);
        });
        test("clamps a millisecond-scale expires_in so it cannot disable refresh for weeks", () => {
            const before = Date.now();
            const credential = credentialFor(7200000);
            expect(credential.expires).toBeGreaterThanOrEqual(before + 30 * DAY * 1000);
            expect(credential.expires).toBeLessThanOrEqual(Date.now() + 30 * DAY * 1000);
        });
        test("preserves a valid positive expires_in", () => {
            const before = Date.now();
            const credential = credentialFor(3600);
            expect(credential.expires).toBeGreaterThanOrEqual(before + 3600 * 1000);
            expect(credential.expires).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
        });
    });
    describe("configured discovery bounds", () => {
        const configured = (auth_server_metadata_url) => new ConfigMCP.Remote({
            type: "remote",
            url: "https://example.com/mcp",
            oauth: { client_id: "client", auth_server_metadata_url },
        });
        const asError = (result) => {
            if (!(result instanceof Error))
                throw new Error(`Expected a failed discovery, got ${String(result)}`);
            return result;
        };
        test("discovers a small configured metadata document", async () => {
            const server = Bun.serve({
                port: 0,
                fetch() {
                    return Response.json({
                        issuer: "https://issuer.example.com",
                        authorization_endpoint: "https://issuer.example.com/authorize",
                        token_endpoint: "https://issuer.example.com/token",
                        response_types_supported: ["code"],
                    });
                },
            });
            try {
                const discovery = await McpOAuth.configuredDiscovery({
                    config: configured(`${server.url.origin}/.well-known/oauth-authorization-server`),
                    fetchFn: fetch,
                });
                expect(discovery?.authorizationServerUrl).toBe("https://issuer.example.com");
            }
            finally {
                server.stop(true);
            }
        });
        test("rejects an over-cap declared content length", async () => {
            // No local server reliably preserves a mismatched content-length header through the real
            // fetch stack, so pin the declared-length check above the small fixture without a socket:
            // the capped reader refuses the body before consuming it.
            const metadata = Response.json({
                issuer: "https://issuer.example.com",
                authorization_endpoint: "https://issuer.example.com/authorize",
                token_endpoint: "https://issuer.example.com/token",
                response_types_supported: ["code"],
            });
            const plain = new Response(metadata.body, {
                status: metadata.status,
                statusText: metadata.statusText,
                headers: {
                    "content-type": "application/json",
                    "content-length": String(McpOAuth.CONFIGURED_DISCOVERY_MAX_BYTES * 4),
                },
            });
            expect(plain.headers.get("content-length")).toBe(String(McpOAuth.CONFIGURED_DISCOVERY_MAX_BYTES * 4));
            // Belt and suspenders: the socket stack may normalize a mismatched content-length, so assert
            // the constructed header here to prove this case actually exercises the declared-length path.
            const error = asError(await McpOAuth.configuredDiscovery({
                config: configured("https://issuer.example.com/.well-known/oauth-authorization-server"),
                fetchFn: async () => plain,
            }).catch((error) => error));
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toContain(`Response body exceeded ${McpOAuth.CONFIGURED_DISCOVERY_MAX_BYTES} bytes`);
            expect(error.message).toContain("https://issuer.example.com");
        });
        test("rejects an over-cap streamed body", async () => {
            const server = Bun.serve({
                port: 0,
                fetch() {
                    return new Response(new ReadableStream({
                        start(controller) {
                            controller.enqueue(new Uint8Array(40 * 1024));
                            controller.enqueue(new Uint8Array(40 * 1024));
                        },
                    }));
                },
            });
            try {
                const url = `${server.url.origin}/metadata`;
                const error = asError(await McpOAuth.configuredDiscovery({ config: configured(url), fetchFn: fetch }).catch((error) => error));
                expect(error.message).toContain(`Response body exceeded ${McpOAuth.CONFIGURED_DISCOVERY_MAX_BYTES} bytes`);
                expect(error.message).toContain(server.url.origin);
            }
            finally {
                server.stop(true);
            }
        });
        test("names the origin when the metadata body is not JSON", async () => {
            const url = "https://issuer.example.com/.well-known/oauth-authorization-server";
            const error = asError(await McpOAuth.configuredDiscovery({
                config: configured(url),
                fetchFn: async () => new Response("<html><body>captive portal</body></html>", {
                    status: 200,
                    headers: { "content-type": "text/html" },
                }),
            }).catch((error) => error));
            expect(error.message).toContain("Could not parse OAuth authorization server metadata from https://issuer.example.com");
            expect(error.message).not.toMatch(/^Unexpected token/);
        });
        test("names the origin when the metadata body has the wrong shape", async () => {
            const url = "https://issuer.example.com/.well-known/oauth-authorization-server";
            const error = asError(await McpOAuth.configuredDiscovery({
                config: configured(url),
                fetchFn: async () => Response.json({ not: "metadata" }),
            }).catch((error) => error));
            expect(error.message).toContain("Could not parse OAuth authorization server metadata from https://issuer.example.com");
        });
        test("fails instead of hanging on a silent endpoint", async () => {
            const server = Bun.serve({ port: 0, fetch: () => new Promise(() => { }) });
            try {
                const url = `${server.url.origin}/metadata`;
                const error = asError(await McpOAuth.configuredDiscovery({ config: configured(url), fetchFn: fetch, timeoutMs: 50 }).catch((error) => error));
                expect(error.message).toContain(`Timeout trying to load OAuth authorization server metadata from ${server.url.origin}`);
            }
            finally {
                server.stop(true);
            }
        });
    });
});
// Each instance has its own database connection, in-process lock table and file lock client over one
// database file, the way the TUI, desktop app and background service share credentials.
describe("MCP OAuth connections", () => {
    const id = Credential.ID.make("cred_test");
    // Each instance has its own database connection, in-process lock table and file lock client over one file,
    // like two OpenCode processes sharing a database.
    const instance = (file) => ManagedRuntime.make(AppNodeBuilder.build(Credential.node, [Database.node.replace(Database.configured({ path: file }))]));
    const setup = async (url, input = {}) => {
        const tmp = await tmpdir();
        const file = path.join(tmp.path, "opencode.db");
        const first = instance(file);
        const second = instance(file);
        const row = credential({ access: "a1", refresh: "r1", url, expires: input.expires ?? Date.now() + 3600000 });
        await first.runPromise(Credential.Service.use((credentials) => credentials.create({
            ...row,
            value: { ...row.value, metadata: { ...row.value.metadata, ...input.metadata } },
        })));
        const config = input.config ?? remote(url);
        const provider = (runtime) => runtime.runPromise(Credential.Service.use((credentials) => credentials
            .get(id)
            .pipe(Effect.flatMap((credential) => McpOAuth.connectProvider({ server: "test", config, credential })))));
        return {
            first,
            second,
            provider,
            async [Symbol.asyncDispose]() {
                await Promise.all([first.dispose(), second.dispose()]);
                await tmp[Symbol.asyncDispose]();
            },
        };
    };
    const stored = async (runtime) => {
        const value = (await runtime.runPromise(Credential.Service.use((credentials) => credentials.get(id))))?.value;
        return value?.type === "oauth" ? { access: value.access, refresh: value.refresh } : undefined;
    };
    const unauthorized = (provider, url, response = new Response(null, { status: 401 })) => provider.onUnauthorized?.({ response, serverUrl: new URL(url), fetchFn: fetch });
    const connect = (provider, url, config = remote(url)) => Effect.runPromise(Effect.scoped(McpClient.connect({ server: "test", config, directory: import.meta.dir, authProvider: provider })).pipe(Effect.provide(hostEnvironmentLayer), Effect.exit));
    const failure = (exit) => Exit.isFailure(exit) && Cause.squash(exit.cause);
    // A server whose MCP endpoint accepts only the refreshed token and whose token endpoint the test switches.
    const guardedServer = () => {
        const state = {
            token: "ok",
            tokenEndpoint: undefined,
            sent: [],
            refused: 0,
        };
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                if (url.pathname === "/.well-known/oauth-authorization-server")
                    return Response.json({
                        issuer: url.origin,
                        authorization_endpoint: `${url.origin}/authorize`,
                        token_endpoint: state.tokenEndpoint ?? `${url.origin}/token`,
                        response_types_supported: ["code"],
                    });
                if (request.method === "POST" && url.pathname === "/token") {
                    state.sent.push(new URLSearchParams(await request.text()).get("refresh_token"));
                    if (state.token === "unavailable")
                        return new Response("upstream unavailable", { status: 503 });
                    if (state.token === "invalid_grant")
                        return Response.json({ error: "invalid_grant" }, { status: 400 });
                    return Response.json({ access_token: "a2", token_type: "Bearer", refresh_token: "r2", expires_in: 3600 });
                }
                if (request.method === "POST" && url.pathname === "/mcp") {
                    if (request.headers.get("authorization") !== "Bearer a2") {
                        state.refused++;
                        return new Response(null, { status: 401 });
                    }
                    const body = (await request.json());
                    if (body.method === "server/discover")
                        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
                    if (body.method !== "initialize")
                        return new Response(null, { status: 202 });
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            protocolVersion: body.params?.protocolVersion,
                            capabilities: {},
                            serverInfo: { name: "test", version: "1" },
                        },
                    });
                }
                return new Response(null, { status: 404 });
            },
        });
        return { server, state, url: `${server.url.origin}/mcp` };
    };
    test("refreshes a refused token and retries with the new one", async () => {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const guarded = guardedServer();
            const processes = __addDisposableResource(env_1, await setup(guarded.url), true);
            const exit = await connect(await processes.provider(processes.first), guarded.url).finally(() => guarded.server.stop(true));
            expect(Exit.isSuccess(exit)).toBe(true);
            expect(guarded.state.sent).toEqual(["r1"]);
            const value = (await processes.second.runPromise(Credential.Service.use((credentials) => credentials.get(id))))
                ?.value;
            expect(value?.type === "oauth" && [value.access, value.refresh, value.metadata?.issuer]).toEqual([
                "a2",
                "r2",
                guarded.server.url.origin,
            ]);
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            const result_1 = __disposeResources(env_1);
            if (result_1)
                await result_1;
        }
    });
    describe("ahead of expiry", () => {
        // An authorization server whose token endpoint the test switches, and the discovery a login saves for it.
        const issuerServer = () => {
            const state = { token: "ok", sent: [] };
            const server = Bun.serve({
                port: 0,
                async fetch(request) {
                    const url = new URL(request.url);
                    if (url.pathname === "/.well-known/oauth-authorization-server/as")
                        return Response.json({
                            issuer: `${url.origin}/as`,
                            authorization_endpoint: `${url.origin}/as/authorize`,
                            token_endpoint: `${url.origin}/as/token`,
                            response_types_supported: ["code"],
                        });
                    if (request.method !== "POST" || url.pathname !== "/as/token")
                        return new Response(null, { status: 404 });
                    state.sent.push(`${new URLSearchParams(await request.text()).get("resource")}`);
                    if (state.token === "unavailable")
                        return new Response(null, { status: 503 });
                    return Response.json({ access_token: "a2", token_type: "Bearer", refresh_token: "r2", expires_in: 3600 });
                },
            });
            const origin = server.url.origin;
            const discovery = { authorizationServer: `${origin}/as`, resource: `${origin}/mcp` };
            return { server, state, url: `${origin}/mcp`, discovery };
        };
        test("refreshes a token that expires within 30 seconds with the saved discovery before sending it", async () => {
            const env_2 = { stack: [], error: void 0, hasError: false };
            try {
                const as = issuerServer();
                const processes = __addDisposableResource(env_2, await setup(as.url, {
                    expires: Date.now() + 10000,
                    metadata: { discovery: as.discovery },
                }), true);
                const token = await (await processes.provider(processes.first)).token().finally(() => as.server.stop(true));
                expect(token).toBe("a2");
                // The saved discovery names the authorization server and resource; the MCP server is never probed.
                expect(as.state.sent).toEqual([as.url]);
                expect(await stored(processes.second)).toEqual({ access: "a2", refresh: "r2" });
            }
            catch (e_2) {
                env_2.error = e_2;
                env_2.hasError = true;
            }
            finally {
                const result_2 = __disposeResources(env_2);
                if (result_2)
                    await result_2;
            }
        });
        test("sends the current token when the refresh fails", async () => {
            const env_3 = { stack: [], error: void 0, hasError: false };
            try {
                const as = issuerServer();
                as.state.token = "unavailable";
                const processes = __addDisposableResource(env_3, await setup(as.url, {
                    expires: Date.now() + 10000,
                    metadata: { discovery: as.discovery },
                }), true);
                const token = await (await processes.provider(processes.first)).token().finally(() => as.server.stop(true));
                expect(token).toBe("a1");
                expect(await stored(processes.second)).toEqual({ access: "a1", refresh: "r1" });
            }
            catch (e_3) {
                env_3.error = e_3;
                env_3.hasError = true;
            }
            finally {
                const result_3 = __disposeResources(env_3);
                if (result_3)
                    await result_3;
            }
        });
        test("leaves tokens with time left, without a lifetime, or saved without discovery to the 401", async () => {
            const as = issuerServer();
            const cases = [
                { expires: Date.now() + 60000, metadata: { discovery: as.discovery } },
                { expires: 0, metadata: { discovery: as.discovery } },
                { expires: Date.now() + 10000 },
            ];
            for (const input of cases) {
                const env_4 = { stack: [], error: void 0, hasError: false };
                try {
                    const processes = __addDisposableResource(env_4, await setup(as.url, input), true);
                    expect(await (await processes.provider(processes.first)).token()).toBe("a1");
                }
                catch (e_4) {
                    env_4.error = e_4;
                    env_4.hasError = true;
                }
                finally {
                    const result_4 = __disposeResources(env_4);
                    if (result_4)
                        await result_4;
                }
            }
            as.server.stop(true);
            expect(as.state.sent).toEqual([]);
        });
    });
    test("refreshes the credential it was made with, not the one signed in since", async () => {
        const env_5 = { stack: [], error: void 0, hasError: false };
        try {
            const guarded = guardedServer();
            const processes = __addDisposableResource(env_5, await setup(guarded.url), true);
            const provider = await processes.provider(processes.first);
            const newer = await processes.first.runPromise(Credential.Service.use((credentials) => credentials.create({
                integrationID,
                value: credential({ access: "other", refresh: "other-refresh", url: guarded.url }).value,
            })));
            await provider.token();
            await unauthorized(provider, guarded.url)?.finally(() => guarded.server.stop(true));
            expect(guarded.state.sent).toEqual(["r1"]);
            expect(await stored(processes.second)).toEqual({ access: "a2", refresh: "r2" });
            const untouched = (await processes.second.runPromise(Credential.Service.use((credentials) => credentials.get(newer.id))))?.value;
            expect(untouched?.type === "oauth" && untouched.access).toBe("other");
        }
        catch (e_5) {
            env_5.error = e_5;
            env_5.hasError = true;
        }
        finally {
            const result_5 = __disposeResources(env_5);
            if (result_5)
                await result_5;
        }
    });
    test("reports needs_auth for an unauthorized server without a credential or any OAuth request", async () => {
        const requests = [];
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                const url = new URL(request.url);
                requests.push(url.pathname);
                if (url.pathname === "/mcp")
                    return new Response(null, { status: 401 });
                return new Response(null, { status: 404 });
            },
        });
        const url = `${server.url.origin}/mcp`;
        const provider = await Effect.runPromise(McpOAuth.connectProvider({ server: "test", config: remote(url), credential: undefined }).pipe(Effect.provideService(Credential.Service, memoryCredentials([]).service)));
        const exit = await connect(provider, url).finally(() => server.stop(true));
        expect(failure(exit)).toBeInstanceOf(McpClient.NeedsAuthError);
        expect(requests.every((path) => path === "/mcp")).toBe(true);
    });
    describe("resource", () => {
        test("sends the configured URL when the server publishes no metadata", async () => {
            const env_6 = { stack: [], error: void 0, hasError: false };
            try {
                const { server, tokenRequests } = authorizationServer({});
                const url = `${server.url.origin}/mcp`;
                const processes = __addDisposableResource(env_6, await setup(url), true);
                const provider = await processes.provider(processes.first);
                await provider.token();
                await unauthorized(provider, url)?.finally(() => server.stop(true));
                expect(tokenRequests[0]?.get("grant_type")).toBe("refresh_token");
                expect(tokenRequests[0]?.get("resource")).toBe(url);
            }
            catch (e_6) {
                env_6.error = e_6;
                env_6.hasError = true;
            }
            finally {
                const result_6 = __disposeResources(env_6);
                if (result_6)
                    await result_6;
            }
        });
        test("keeps the configured URL when metadata echoes the dialed query", async () => {
            const env_7 = { stack: [], error: void 0, hasError: false };
            try {
                const tokenRequests = [];
                const server = Bun.serve({
                    port: 0,
                    async fetch(request) {
                        const url = new URL(request.url);
                        if (url.pathname === "/.well-known/oauth-authorization-server")
                            return Response.json({
                                issuer: url.origin,
                                authorization_endpoint: `${url.origin}/authorize`,
                                token_endpoint: `${url.origin}/token`,
                                response_types_supported: ["code"],
                            });
                        if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
                            return Response.json({ resource: `${url.origin}/mcp${url.search}`, authorization_servers: [url.origin] });
                        if (request.method === "POST" && url.pathname === "/token") {
                            tokenRequests.push(new URLSearchParams(await request.text()));
                            return Response.json({ access_token: "next", token_type: "Bearer" });
                        }
                        return new Response(null, { status: 404 });
                    },
                });
                const url = `${server.url.origin}/mcp`;
                const processes = __addDisposableResource(env_7, await setup(url), true);
                const provider = await processes.provider(processes.first);
                // The transport dials with ?codemode=false and the 401 points at metadata that echoes it.
                await provider.token();
                await unauthorized(provider, `${url}?codemode=false`, new Response(null, {
                    status: 401,
                    headers: {
                        "WWW-Authenticate": `Bearer resource_metadata="${server.url.origin}/.well-known/oauth-protected-resource/mcp?codemode=false"`,
                    },
                }))?.finally(() => server.stop(true));
                expect(tokenRequests[0]?.get("resource")).toBe(url);
            }
            catch (e_7) {
                env_7.error = e_7;
                env_7.hasError = true;
            }
            finally {
                const result_7 = __disposeResources(env_7);
                if (result_7)
                    await result_7;
            }
        });
        test("discovers the resource for a login saved without one", async () => {
            const env_8 = { stack: [], error: void 0, hasError: false };
            try {
                const tokenRequests = [];
                const server = Bun.serve({
                    port: 0,
                    async fetch(request) {
                        const url = new URL(request.url);
                        if (url.pathname === "/.well-known/oauth-authorization-server")
                            return Response.json({
                                issuer: url.origin,
                                authorization_endpoint: `${url.origin}/authorize`,
                                token_endpoint: `${url.origin}/token`,
                                response_types_supported: ["code"],
                            });
                        if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
                            return Response.json({ resource: `${url.origin}/`, authorization_servers: [url.origin] });
                        if (request.method === "POST" && url.pathname === "/token") {
                            tokenRequests.push(new URLSearchParams(await request.text()));
                            return Response.json({ access_token: "a2", token_type: "Bearer" });
                        }
                        return new Response(null, { status: 404 });
                    },
                });
                const url = `${server.url.origin}/mcp`;
                const processes = __addDisposableResource(env_8, await setup(url), true);
                const provider = await processes.provider(processes.first);
                await provider.token();
                await unauthorized(provider, url)?.finally(() => server.stop(true));
                expect(tokenRequests[0]?.get("resource")).toBe(`${server.url.origin}/`);
            }
            catch (e_8) {
                env_8.error = e_8;
                env_8.hasError = true;
            }
            finally {
                const result_8 = __disposeResources(env_8);
                if (result_8)
                    await result_8;
            }
        });
        test("follows the 401 to the resource for a login saved without discovery, and saves it", async () => {
            const env_9 = { stack: [], error: void 0, hasError: false };
            try {
                const tokenRequests = [];
                const server = Bun.serve({
                    port: 0,
                    async fetch(request) {
                        const url = new URL(request.url);
                        if (url.pathname === "/custom/metadata")
                            return Response.json({ resource: `${url.origin}/`, authorization_servers: [`${url.origin}/as`] });
                        if (url.pathname === "/.well-known/oauth-authorization-server/as")
                            return Response.json({
                                issuer: `${url.origin}/as`,
                                authorization_endpoint: `${url.origin}/as/authorize`,
                                token_endpoint: `${url.origin}/as/token`,
                                response_types_supported: ["code"],
                            });
                        if (request.method === "POST" && url.pathname === "/as/token") {
                            tokenRequests.push(new URLSearchParams(await request.text()));
                            return Response.json({ access_token: "a2", token_type: "Bearer", refresh_token: "r2", expires_in: 3600 });
                        }
                        return new Response(null, { status: 404 });
                    },
                });
                const url = `${server.url.origin}/mcp`;
                const processes = __addDisposableResource(env_9, await setup(url, { expires: Date.now() - 1000 }), true);
                const provider = await processes.provider(processes.first);
                await provider.token();
                await unauthorized(provider, url, new Response(null, {
                    status: 401,
                    headers: { "WWW-Authenticate": `Bearer resource_metadata="${server.url.origin}/custom/metadata"` },
                }))?.finally(() => server.stop(true));
                expect(tokenRequests.map((body) => body.get("resource"))).toEqual([`${server.url.origin}/`]);
                const value = (await processes.second.runPromise(Credential.Service.use((credentials) => credentials.get(id))))
                    ?.value;
                expect(value?.type === "oauth" && value.metadata?.discovery).toEqual({
                    authorizationServer: `${server.url.origin}/as`,
                    resource: `${server.url.origin}/`,
                });
            }
            catch (e_9) {
                env_9.error = e_9;
                env_9.hasError = true;
            }
            finally {
                const result_9 = __disposeResources(env_9);
                if (result_9)
                    await result_9;
            }
        });
        test("refreshes through configured authorization server metadata", async () => {
            const env_10 = { stack: [], error: void 0, hasError: false };
            try {
                const { server, tokenRequests } = authorizationServer({});
                const resource = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
                const url = `${resource.url.origin}/mcp`;
                const processes = __addDisposableResource(env_10, await setup(url, {
                    config: new ConfigMCP.Remote({
                        type: "remote",
                        url,
                        oauth: {
                            client_id: "client",
                            auth_server_metadata_url: `${server.url.origin}/.well-known/oauth-authorization-server`,
                        },
                    }),
                }), true);
                const provider = await processes.provider(processes.first);
                await provider.token();
                await unauthorized(provider, url)?.finally(() => {
                    resource.stop(true);
                    server.stop(true);
                });
                expect(tokenRequests[0]?.get("grant_type")).toBe("refresh_token");
                expect(tokenRequests[0]?.get("resource")).toBe(url);
            }
            catch (e_10) {
                env_10.error = e_10;
                env_10.hasError = true;
            }
            finally {
                const result_10 = __disposeResources(env_10);
                if (result_10)
                    await result_10;
            }
        });
    });
    describe("across processes", () => {
        // A token endpoint that rotates refresh tokens and rejects reuse. The test releases each response.
        const rotatingServer = () => {
            const state = { current: "r1", generation: 1 };
            const sent = [];
            const received = Promise.withResolvers();
            const release = Promise.withResolvers();
            const server = Bun.serve({
                port: 0,
                async fetch(request) {
                    const url = new URL(request.url);
                    if (request.method !== "POST" || url.pathname !== "/token")
                        return new Response(null, { status: 404 });
                    const token = new URLSearchParams(await request.text()).get("refresh_token") ?? "";
                    sent.push(token);
                    received.resolve();
                    await release.promise;
                    if (token !== state.current)
                        return Response.json({ error: "invalid_grant" }, { status: 400 });
                    state.generation++;
                    state.current = `r${state.generation}`;
                    return Response.json({
                        access_token: `a${state.generation}`,
                        token_type: "Bearer",
                        refresh_token: state.current,
                        expires_in: 3600,
                    });
                },
            });
            return { server, sent, received: received.promise, release: () => release.resolve() };
        };
        test("sends one refresh when two instances refresh the same credential at once", async () => {
            const env_11 = { stack: [], error: void 0, hasError: false };
            try {
                const endpoint = rotatingServer();
                const url = endpoint.server.url.href;
                const processes = __addDisposableResource(env_11, await setup(url), true);
                const [first, second] = await Promise.all([
                    processes.provider(processes.first),
                    processes.provider(processes.second),
                ]);
                await Promise.all([first.token(), second.token()]);
                const pending = unauthorized(first, url);
                // The first instance holds the credential lock until its rotated tokens are saved.
                await endpoint.received;
                const waiting = unauthorized(second, url);
                endpoint.release();
                await Promise.all([pending, waiting]).finally(() => endpoint.server.stop(true));
                expect(endpoint.sent).toEqual(["r1"]);
                expect([await first.token(), await second.token()]).toEqual(["a2", "a2"]);
                expect(await stored(processes.second)).toEqual({ access: "a2", refresh: "r2" });
            }
            catch (e_11) {
                env_11.error = e_11;
                env_11.hasError = true;
            }
            finally {
                const result_11 = __disposeResources(env_11);
                if (result_11)
                    await result_11;
            }
        });
        test("uses the stored tokens instead of spending a refresh token another instance already spent", async () => {
            const env_12 = { stack: [], error: void 0, hasError: false };
            try {
                const endpoint = rotatingServer();
                endpoint.release();
                const url = endpoint.server.url.href;
                const processes = __addDisposableResource(env_12, await setup(url), true);
                const stale = await processes.provider(processes.first);
                const other = await processes.provider(processes.second);
                await Promise.all([stale.token(), other.token()]);
                await unauthorized(other, url);
                await unauthorized(stale, url)?.finally(() => endpoint.server.stop(true));
                expect(endpoint.sent).toEqual(["r1"]);
                expect(await stale.token()).toBe("a2");
            }
            catch (e_12) {
                env_12.error = e_12;
                env_12.hasError = true;
            }
            finally {
                const result_12 = __disposeResources(env_12);
                if (result_12)
                    await result_12;
            }
        });
        test("needs auth without a request when the credential was signed out", async () => {
            const env_13 = { stack: [], error: void 0, hasError: false };
            try {
                const endpoint = rotatingServer();
                endpoint.release();
                const url = endpoint.server.url.href;
                const processes = __addDisposableResource(env_13, await setup(url), true);
                const provider = await processes.provider(processes.first);
                await provider.token();
                await processes.second.runPromise(Credential.Service.use((credentials) => credentials.remove(id)));
                const error = await Promise.resolve(unauthorized(provider, url))
                    .catch((error) => error)
                    .finally(() => endpoint.server.stop(true));
                expect(error).toBeInstanceOf(UnauthorizedError);
                expect(endpoint.sent).toEqual([]);
            }
            catch (e_13) {
                env_13.error = e_13;
                env_13.hasError = true;
            }
            finally {
                const result_13 = __disposeResources(env_13);
                if (result_13)
                    await result_13;
            }
        });
    });
    describe("when the refresh fails", () => {
        test("fails without signing out when the token endpoint answers 503", async () => {
            const env_14 = { stack: [], error: void 0, hasError: false };
            try {
                const guarded = guardedServer();
                const processes = __addDisposableResource(env_14, await setup(guarded.url), true);
                guarded.state.token = "unavailable";
                const failed = failure(await connect(await processes.provider(processes.first), guarded.url));
                expect(failed).toBeInstanceOf(McpClient.ConnectError);
                expect(failed instanceof McpClient.ConnectError && failed.answered).toBe(false);
                expect(failed instanceof McpClient.ConnectError && failed.message).toBe("Could not refresh the OAuth token: HTTP 503 (temporarily_unavailable)");
                expect(await stored(processes.second)).toEqual({ access: "a1", refresh: "r1" });
                guarded.state.token = "ok";
                const exit = await connect(await processes.provider(processes.first), guarded.url).finally(() => guarded.server.stop(true));
                expect(Exit.isSuccess(exit)).toBe(true);
                expect(guarded.state.sent).toEqual(["r1", "r1"]);
                expect(await stored(processes.second)).toEqual({ access: "a2", refresh: "r2" });
            }
            catch (e_14) {
                env_14.error = e_14;
                env_14.hasError = true;
            }
            finally {
                const result_14 = __disposeResources(env_14);
                if (result_14)
                    await result_14;
            }
        });
        test("fails without signing out when the token endpoint is unreachable", async () => {
            const env_15 = { stack: [], error: void 0, hasError: false };
            try {
                const guarded = guardedServer();
                const closed = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
                closed.stop(true);
                guarded.state.tokenEndpoint = `${closed.url.origin}/token`;
                const processes = __addDisposableResource(env_15, await setup(guarded.url), true);
                const failed = failure(await connect(await processes.provider(processes.first), guarded.url));
                expect(failed).toBeInstanceOf(McpClient.ConnectError);
                expect(failed instanceof McpClient.ConnectError && failed.answered).toBe(false);
                expect(await stored(processes.second)).toEqual({ access: "a1", refresh: "r1" });
                guarded.state.tokenEndpoint = undefined;
                const exit = await connect(await processes.provider(processes.first), guarded.url).finally(() => guarded.server.stop(true));
                expect(Exit.isSuccess(exit)).toBe(true);
            }
            catch (e_15) {
                env_15.error = e_15;
                env_15.hasError = true;
            }
            finally {
                const result_15 = __disposeResources(env_15);
                if (result_15)
                    await result_15;
            }
        });
        test("signs out when the token endpoint answers invalid_grant", async () => {
            const env_16 = { stack: [], error: void 0, hasError: false };
            try {
                const guarded = guardedServer();
                guarded.state.token = "invalid_grant";
                const processes = __addDisposableResource(env_16, await setup(guarded.url), true);
                const failed = failure(await connect(await processes.provider(processes.first), guarded.url));
                guarded.server.stop(true);
                expect(failed).toBeInstanceOf(McpClient.NeedsAuthError);
                expect(await stored(processes.second)).toBeUndefined();
            }
            catch (e_16) {
                env_16.error = e_16;
                env_16.hasError = true;
            }
            finally {
                const result_16 = __disposeResources(env_16);
                if (result_16)
                    await result_16;
            }
        });
        test("keeps the credential when the refresh times out", async () => {
            const env_17 = { stack: [], error: void 0, hasError: false };
            try {
                const received = Promise.withResolvers();
                let aborted = false;
                const hung = Bun.serve({
                    port: 0,
                    fetch: (request) => {
                        request.signal.addEventListener("abort", () => {
                            aborted = true;
                        });
                        received.resolve();
                        return new Promise(() => { });
                    },
                });
                const url = hung.url.href;
                const processes = __addDisposableResource(env_17, await setup(url), true);
                const error = await processes.first
                    .runPromise(Effect.gen(function* () {
                    const credentials = yield* Credential.Service;
                    const provider = yield* McpOAuth.connectProvider({
                        server: "test",
                        config: remote(url),
                        credential: yield* credentials.get(id),
                    });
                    yield* Effect.promise(() => provider.token());
                    const pending = Promise.resolve(unauthorized(provider, url)).catch((error) => error);
                    yield* Effect.promise(() => received.promise);
                    yield* TestClock.adjust("30 seconds");
                    return yield* Effect.promise(() => pending);
                }).pipe(Effect.provide(TestClock.layer())))
                    .finally(() => hung.stop(true));
                expect(error instanceof OAuthError && error.code).toBe("temporarily_unavailable");
                expect(await stored(processes.second)).toEqual({ access: "a1", refresh: "r1" });
                expect(aborted).toBe(true);
            }
            catch (e_17) {
                env_17.error = e_17;
                env_17.hasError = true;
            }
            finally {
                const result_17 = __disposeResources(env_17);
                if (result_17)
                    await result_17;
            }
        });
        test("sends nothing to an authorization server other than the one that issued the credential", async () => {
            const env_18 = { stack: [], error: void 0, hasError: false };
            try {
                const received = [];
                const attacker = Bun.serve({
                    port: 0,
                    async fetch(request) {
                        const url = new URL(request.url);
                        if (url.pathname === "/resource")
                            return Response.json({ resource: `${url.origin}/`, authorization_servers: [url.origin] });
                        if (url.pathname === "/.well-known/oauth-authorization-server")
                            return Response.json({
                                issuer: url.origin,
                                authorization_endpoint: `${url.origin}/authorize`,
                                token_endpoint: `${url.origin}/token`,
                                response_types_supported: ["code"],
                            });
                        if (request.method === "POST")
                            received.push(await request.text());
                        return Response.json({ access_token: "stolen", token_type: "Bearer" });
                    },
                });
                const url = `${attacker.url.origin}/mcp`;
                // Saved before discovery was stored: only the issuer the login found is known.
                const processes = __addDisposableResource(env_18, await setup(url, { metadata: { issuer: "https://auth.legit.example" } }), true);
                const provider = await processes.provider(processes.first);
                await provider.token();
                const error = await Promise.resolve(unauthorized(provider, url, new Response(null, {
                    status: 401,
                    headers: { "WWW-Authenticate": `Bearer resource_metadata="${attacker.url.origin}/resource"` },
                })))
                    .catch((error) => error)
                    .finally(() => attacker.stop(true));
                expect(error).toBeInstanceOf(UnauthorizedError);
                expect(received).toEqual([]);
                const value = (await processes.second.runPromise(Credential.Service.use((credentials) => credentials.get(id))))
                    ?.value;
                expect(value?.type === "oauth" && [value.access, value.refresh, value.metadata?.issuer]).toEqual([
                    "a1",
                    "r1",
                    "https://auth.legit.example",
                ]);
            }
            catch (e_18) {
                env_18.error = e_18;
                env_18.hasError = true;
            }
            finally {
                const result_18 = __disposeResources(env_18);
                if (result_18)
                    await result_18;
            }
        });
        test("names only the error code of a token endpoint that answers without an OAuth error", async () => {
            const env_19 = { stack: [], error: void 0, hasError: false };
            try {
                const guarded = guardedServer();
                const processes = __addDisposableResource(env_19, await setup(guarded.url), true);
                const provider = await processes.provider(processes.first);
                const server = Bun.serve({
                    port: 0,
                    fetch: () => new Response("<html>secret echo of the request</html>", { status: 400 }),
                });
                guarded.state.tokenEndpoint = `${server.url.origin}/token`;
                await provider.token();
                const error = await Promise.resolve(unauthorized(provider, guarded.url))
                    .catch((error) => error)
                    .finally(() => {
                    server.stop(true);
                    guarded.server.stop(true);
                });
                expect(error instanceof OAuthError && error.message).toBe("Could not refresh the OAuth token: server_error");
                expect(await stored(processes.second)).toEqual({ access: "a1", refresh: "r1" });
            }
            catch (e_19) {
                env_19.error = e_19;
                env_19.hasError = true;
            }
            finally {
                const result_19 = __disposeResources(env_19);
                if (result_19)
                    await result_19;
            }
        });
        test("signs out a credential without client information", async () => {
            const env_20 = { stack: [], error: void 0, hasError: false };
            try {
                const { server, tokenRequests } = authorizationServer({});
                const url = `${server.url.origin}/mcp`;
                const processes = __addDisposableResource(env_20, await setup(url, { config: new ConfigMCP.Remote({ type: "remote", url }) }), true);
                const provider = await processes.provider(processes.first);
                await provider.token();
                const error = await Promise.resolve(unauthorized(provider, url))
                    .catch((error) => error)
                    .finally(() => server.stop(true));
                expect(error).toBeInstanceOf(UnauthorizedError);
                expect(tokenRequests).toEqual([]);
                expect(await stored(processes.second)).toBeUndefined();
            }
            catch (e_20) {
                env_20.error = e_20;
                env_20.hasError = true;
            }
            finally {
                const result_20 = __disposeResources(env_20);
                if (result_20)
                    await result_20;
            }
        });
        test("tries the next metadata URL when one answers 502", async () => {
            const env_21 = { stack: [], error: void 0, hasError: false };
            try {
                const tokenRequests = [];
                const server = Bun.serve({
                    port: 0,
                    async fetch(request) {
                        const url = new URL(request.url);
                        if (url.pathname === "/.well-known/oauth-authorization-server")
                            return new Response(null, { status: 502 });
                        if (url.pathname === "/.well-known/openid-configuration")
                            return Response.json({
                                issuer: url.origin,
                                authorization_endpoint: `${url.origin}/authorize`,
                                token_endpoint: `${url.origin}/token`,
                                response_types_supported: ["code"],
                                subject_types_supported: ["public"],
                                id_token_signing_alg_values_supported: ["RS256"],
                                jwks_uri: `${url.origin}/jwks`,
                            });
                        if (request.method === "POST" && url.pathname === "/token") {
                            tokenRequests.push(url.pathname);
                            return Response.json({ access_token: "a2", token_type: "Bearer", refresh_token: "r2" });
                        }
                        return new Response(null, { status: 404 });
                    },
                });
                const url = `${server.url.origin}/mcp`;
                const processes = __addDisposableResource(env_21, await setup(url), true);
                const provider = await processes.provider(processes.first);
                await provider.token();
                await unauthorized(provider, url)?.finally(() => server.stop(true));
                expect(tokenRequests).toEqual(["/token"]);
                expect(await stored(processes.second)).toEqual({ access: "a2", refresh: "r2" });
            }
            catch (e_21) {
                env_21.error = e_21;
                env_21.hasError = true;
            }
            finally {
                const result_21 = __disposeResources(env_21);
                if (result_21)
                    await result_21;
            }
        });
    });
    test("reports needs_auth when the server asks for more scope", async () => {
        const env_22 = { stack: [], error: void 0, hasError: false };
        try {
            const server = Bun.serve({
                port: 0,
                fetch: () => new Response(null, {
                    status: 403,
                    headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="admin"' },
                }),
            });
            const url = `${server.url.origin}/mcp`;
            const processes = __addDisposableResource(env_22, await setup(url), true);
            const exit = await connect(await processes.provider(processes.first), url).finally(() => server.stop(true));
            expect(failure(exit)).toBeInstanceOf(McpClient.NeedsAuthError);
        }
        catch (e_22) {
            env_22.error = e_22;
            env_22.hasError = true;
        }
        finally {
            const result_22 = __disposeResources(env_22);
            if (result_22)
                await result_22;
        }
    });
});
