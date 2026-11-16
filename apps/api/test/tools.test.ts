import { randomBytes } from "node:crypto";
import { CredentialStore, decryptSecret, loadConfig } from "@console/core";
import { auditLog, mcpServers, memberships, orgs, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";
import { isPublicAddress, sseMessages } from "../src/mcp-client.js";
import { mergeTools, slugFor } from "../src/routes/tools.js";
import { renewDue, SIGN_IN_AGAIN } from "../src/mcp-oauth-store.js";
import { createHash } from "node:crypto";

/**
 * Compass → Tools: an admin adds a remote MCP server; Compass lists its tools
 * before saving, read-only tools start allowed, headers are sealed and never
 * returned, and members can see but not change.
 */

/** DNS without the network: the test hosts, plus one that points inside. */
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === "docs.example.com" || host === "mcp.example.com" || host === "auth.example.com") return [{ address: "93.184.215.14", family: 4 }];
    if (host === "metadata.example.com") return [{ address: "169.254.169.254", family: 4 }];
    throw new Error("ENOTFOUND");
  }),
}));

const MASTER_KEY = randomBytes(32).toString("base64");
const SERVER = "https://docs.example.com/_mcp/server";

let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
let orgId = "";
let seen: Array<{ method: string; headers: Record<string, string> }> = [];
let serverTools: unknown[] = [];

const admin = { cookie: "console_session=admin", "x-console-csrf": "1" };
const member = { cookie: "console_session=member", "x-console-csrf": "1" };

function sse(obj: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(obj)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function stubServer() {
  seen = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) !== SERVER) return new Response("nope", { status: 405 });
      const msg = JSON.parse(String(init?.body)) as { id?: number; method: string };
      seen.push({ method: msg.method, headers: init?.headers as Record<string, string> });
      if (msg.method === "initialize") return sse({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fern" } } });
      if (msg.method === "tools/list") return sse({ jsonrpc: "2.0", id: msg.id, result: { tools: serverTools } });
      return new Response(null, { status: 202 });
    }),
  );
}

beforeAll(async () => {
  const pg = new PGlite();
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of (await readFile(join(migrationsDir, file), "utf8")).split("--> statement-breakpoint")) {
      if (stmt.trim()) await pg.exec(stmt.trim());
    }
  }
  const db = drizzle(pg) as never;
  const cfg = loadConfig({ CONSOLE_MASTER_KEY: MASTER_KEY, GITHUB_APP_WEBHOOK_SECRET: "s", NODE_ENV: "test" } as never);
  const credentials = new CredentialStore({
    masterKey: MASTER_KEY,
    apiUrl: "https://gh.test",
    load: async () => null,
    env: { appId: "1", privateKeyPem: "x", webhookSecret: "s", clientId: "c", clientSecret: "cs" },
  });
  deps = {
    cfg,
    dbh: { db, sql: null as never, close: async () => undefined },
    credentials,
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  app = await buildApp(deps);
  const d = deps.dbh.db;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  orgId = org.id;
  for (const [i, login, role] of [
    [1, "alice", "owner"],
    [2, "bob", "member"],
  ] as const) {
    const u = (await d.insert(users).values({ ghUserId: i, login }).returning())[0]!;
    await d.insert(memberships).values({ orgId: org.id, userId: u.id, role });
    await d.insert(sessions).values({ id: role === "owner" ? "admin" : "member", userId: u.id, expiresAt: new Date(Date.now() + 3600_000) });
  }
});

beforeEach(async () => {
  await deps.dbh.db.delete(mcpServers);
  serverTools = [
    { name: "searchDocs", description: "Search the docs", annotations: { title: "Search docs", readOnlyHint: true } },
    { name: "deleteIndex", description: "Wipe the index" },
  ];
  stubServer();
});

afterEach(() => vi.unstubAllGlobals());

const add = (body: Record<string, unknown>, headers = admin) => app.inject({ method: "POST", url: `/api/orgs/${orgId}/tools`, headers, payload: body });

describe("adding a server", () => {
  it("lists its tools first, then saves it with only the read-only ones allowed", async () => {
    const res = await add({ label: "Sarvam docs", url: SERVER });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.name).toBe("sarvam_docs");
    expect(s.tools).toEqual([
      { name: "searchDocs", title: "Search docs", description: "Search the docs", readOnly: true, allowed: true },
      { name: "deleteIndex", description: "Wipe the index", readOnly: false, allowed: false },
    ]);
    expect([s.useShape, s.useAsk, s.useBuild, s.enabled]).toEqual([true, true, true, true]);
    expect(seen.map((x) => x.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect((await deps.dbh.db.select().from(auditLog)).some((a) => a.action === "tools.add")).toBe(true);
  });

  it("names it after the host when no name is typed", async () => {
    expect((await add({ url: SERVER })).json().label).toBe("docs.example.com");
  });

  it("seals headers, sends them to the server, and never returns their values", async () => {
    const res = await add({ label: "Docs", url: SERVER, headers: [{ name: "x-api-key", value: "sk-very-secret" }] });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("sk-very-secret");
    expect(res.json().headerNames).toEqual(["x-api-key"]);
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-very-secret");
    const row = (await deps.dbh.db.select().from(mcpServers))[0]!;
    expect(row.encryptedHeaders).not.toContain("sk-very-secret");
    expect(JSON.parse(decryptSecret(row.encryptedHeaders!, MASTER_KEY))).toEqual({ "x-api-key": "sk-very-secret" });
    const list = await app.inject({ method: "GET", url: `/api/orgs/${orgId}/tools`, headers: member });
    expect(list.body).not.toContain("sk-very-secret");
  });

  it("saves nothing when the server does not answer as MCP", async () => {
    const res = await add({ url: "https://docs.example.com/wrong" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/could not list this server's tools: the server answered 405/);
    expect(await deps.dbh.db.select().from(mcpServers)).toEqual([]);
  });

  it("refuses plain http and credentials in the URL", async () => {
    expect((await add({ url: "http://docs.example.com/mcp" })).json().error).toMatch(/https/);
    expect((await add({ url: "https://u:p@docs.example.com/mcp" })).json().error).toMatch(/header/);
  });

  it("refuses servers that are, or resolve to, private addresses, and redirects", async () => {
    expect((await add({ url: "https://10.0.0.5/mcp" })).json().error).toMatch(/10\.0\.0\.5 is not a public address/);
    expect((await add({ url: "https://metadata.example.com/mcp" })).json().error).toMatch(/metadata\.example\.com is not a public address/);
    expect((await add({ url: "https://[fd00::1]/mcp" })).json().error).toMatch(/not a public address/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })));
    expect((await add({ url: SERVER })).json().error).toMatch(/redirected to http:\/\/169\.254\.169\.254\/; use that URL/);
    expect(await deps.dbh.db.select().from(mcpServers)).toEqual([]);
  });

  it("is for admins: a member sees the list but cannot add", async () => {
    expect((await add({ url: SERVER }, member)).statusCode).toBe(403);
    const list = await app.inject({ method: "GET", url: `/api/orgs/${orgId}/tools`, headers: member });
    expect(list.json()).toMatchObject({ canEdit: false, servers: [] });
  });
});

describe("changing a server", () => {
  it("switches tools and places, and a re-test keeps those choices while adding new tools", async () => {
    const s = (await add({ label: "Docs", url: SERVER })).json();
    const changed = await app.inject({
      method: "PATCH",
      url: `/api/orgs/${orgId}/tools/${s.id}`,
      headers: admin,
      payload: { useBuild: false, tools: { deleteIndex: true, searchDocs: false } },
    });
    expect(changed.json().useBuild).toBe(false);
    expect(changed.json().tools.map((t: { allowed: boolean }) => t.allowed)).toEqual([false, true]);

    serverTools = [...serverTools, { name: "getPage", annotations: { readOnlyHint: true } }];
    const tested = await app.inject({ method: "POST", url: `/api/orgs/${orgId}/tools/${s.id}/test`, headers: admin });
    expect(tested.json().tools.map((t: { name: string; allowed: boolean }) => `${t.name}:${t.allowed}`)).toEqual([
      "searchDocs:false",
      "deleteIndex:true",
      "getPage:true",
    ]);
    expect(tested.json().checkError).toBeNull();
  });

  it("records why a re-test failed, without losing the tools", async () => {
    const s = (await add({ label: "Docs", url: SERVER })).json();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const tested = (await app.inject({ method: "POST", url: `/api/orgs/${orgId}/tools/${s.id}/test`, headers: admin })).json();
    expect(tested.checkError).toBe("the server answered 503");
    expect(tested.tools).toHaveLength(2);
  });

  it("removes a server", async () => {
    const s = (await add({ label: "Docs", url: SERVER })).json();
    expect((await app.inject({ method: "DELETE", url: `/api/orgs/${orgId}/tools/${s.id}`, headers: admin })).statusCode).toBe(204);
    expect(await deps.dbh.db.select().from(mcpServers)).toEqual([]);
  });
});

describe("serving the orchestrator", () => {
  it("gives the orchestrator the org's allowed tools with their headers, for its dispatch token only", async () => {
    deps.cfg.ORCHESTRATOR_DISPATCH_TOKEN = "dispatch-tok";
    const { estates, repos } = await import("@console/db");
    const estate = (await deps.dbh.db.insert(estates).values({ orgId, name: "acme", installationId: 5 }).returning())[0]!;
    await deps.dbh.db.insert(repos).values({ orgId, estateId: estate.id, ghNodeId: "R-mcp", fullName: "acme/mcp-app" }).onConflictDoNothing();
    await add({ label: "Docs", url: SERVER, headers: [{ name: "x-api-key", value: "sk-very-secret" }] });
    const off = (await add({ label: "Off", url: SERVER })).json();
    await app.inject({ method: "PATCH", url: `/api/orgs/${orgId}/tools/${off.id}`, headers: admin, payload: { enabled: false } });

    const url = "/api/orchestrator/mcp-servers?repo=acme/mcp-app";
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    const got = await app.inject({ method: "GET", url, headers: { authorization: "Bearer dispatch-tok" } });
    expect(got.json()).toEqual({
      servers: [{ name: "docs", label: "Docs", transport: "http", url: SERVER, headers: { "x-api-key": "sk-very-secret" }, tools: ["searchDocs"], use_shape: true, use_ask: true, use_build: true }],
    });
    expect((await app.inject({ method: "GET", url: "/api/orchestrator/mcp-servers?repo=nobody/x", headers: { authorization: "Bearer dispatch-tok" } })).statusCode).toBe(404);
  });
});

describe("tools for particular projects", () => {
  it("goes only to sessions in its projects; unscoped tools go everywhere", async () => {
    deps.cfg.ORCHESTRATOR_DISPATCH_TOKEN = "dispatch-tok";
    const { estates, projects: projectsTable, repos } = await import("@console/db");
    const d = deps.dbh.db;
    const estate = (await d.insert(estates).values({ orgId, name: "scoped", installationId: 77 }).returning())[0]!;
    const beacon = (await d.insert(projectsTable).values({ orgId, name: "Beacon" }).returning())[0]!;
    const lens = (await d.insert(projectsTable).values({ orgId, name: "Lens" }).returning())[0]!;
    const mk = (name: string, projectId: string | null) =>
      d.insert(repos).values({ orgId, estateId: estate.id, ghNodeId: `R-${name}`, fullName: `acme/${name}`, projectId }).onConflictDoNothing();
    await mk("beacon-api", beacon.id);
    await mk("lens-app", lens.id);
    await mk("loose", null);

    const logs = (await add({ label: "Beacon logs", url: SERVER, projectIds: [beacon.id] })).json();
    await add({ label: "Docs", url: SERVER });
    expect(logs.projectIds).toEqual([beacon.id]);

    const seenBy = async (repo: string) =>
      ((await app.inject({ method: "GET", url: `/api/orchestrator/mcp-servers?repo=acme/${repo}`, headers: { authorization: "Bearer dispatch-tok" } })).json().servers as Array<{ name: string }>).map((x) => x.name).sort();
    expect(await seenBy("beacon-api")).toEqual(["beacon_logs", "docs"]);
    expect(await seenBy("lens-app")).toEqual(["docs"]);
    expect(await seenBy("loose")).toEqual(["docs"]); // no project: never a scoped server

    // Change the scope, or clear it back to every project.
    const both = await app.inject({ method: "PATCH", url: `/api/orgs/${orgId}/tools/${logs.id}`, headers: admin, payload: { projectIds: [beacon.id, lens.id] } });
    expect(both.json().projectIds.sort()).toEqual([beacon.id, lens.id].sort());
    expect(await seenBy("lens-app")).toEqual(["beacon_logs", "docs"]);
    await app.inject({ method: "PATCH", url: `/api/orgs/${orgId}/tools/${logs.id}`, headers: admin, payload: { projectIds: [] } });
    expect(await seenBy("loose")).toEqual(["beacon_logs", "docs"]);
  });

  it("refuses a project that is not this organisation's", async () => {
    const { orgs, projects: projectsTable } = await import("@console/db");
    const other = (await deps.dbh.db.insert(orgs).values({ name: "other-org" }).returning())[0]!;
    const theirs = (await deps.dbh.db.insert(projectsTable).values({ orgId: other.id, name: "Theirs" }).returning())[0]!;
    const refused = await add({ label: "Docs", url: SERVER, projectIds: [theirs.id] });
    expect(refused.statusCode).toBe(400);
    const ok = (await add({ label: "Docs", url: SERVER })).json();
    const patched = await app.inject({ method: "PATCH", url: `/api/orgs/${orgId}/tools/${ok.id}`, headers: admin, payload: { projectIds: [theirs.id] } });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().error).toMatch(/not in this organisation/);
  });
});

describe("helpers", () => {
  it("makes ids Claude can use, unique in the org", () => {
    expect(slugFor("Sarvam Docs!", new Set())).toBe("sarvam_docs");
    expect(slugFor("docs.sarvam.ai", new Set(["docs_sarvam_ai"]))).toBe("docs_sarvam_ai_2");
    expect(slugFor("42", new Set())).toBe("s_42");
  });

  it("tells public addresses from private ones", () => {
    for (const ip of ["93.184.215.14", "2606:4700::1"]) expect(isPublicAddress(ip)).toBe(true);
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "nonsense"])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it("reads multi-line SSE events", () => {
    expect(sseMessages("event: endpoint\ndata: /messages?s=1\n\ndata: {\"a\":\ndata: 1}\n\n")).toEqual([
      { event: "endpoint", data: "/messages?s=1" },
      { event: "message", data: '{"a":\n1}' },
    ]);
  });

  it("keeps earlier choices when merging a new listing", () => {
    expect(mergeTools([{ name: "a", readOnly: false }, { name: "b", readOnly: true }], [{ name: "a", readOnly: false, allowed: true }])).toEqual([
      { name: "a", readOnly: false, allowed: true },
      { name: "b", readOnly: true, allowed: true },
    ]);
  });
});


describe("servers that sign in (OAuth)", () => {
  const MCP = "https://mcp.example.com/mcp";
  const AS = "https://auth.example.com";
  let challenge = "";
  let tokens: Record<string, { access: string; refresh: string }>;
  let calls: string[];
  let registration = true;

  function stubOAuthServer() {
    calls = [];
    tokens = { rt1: { access: "at2", refresh: "rt2" } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === MCP) {
          const auth = headers.Authorization ?? headers.authorization;
          if (!auth?.startsWith("Bearer at")) {
            return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"` } });
          }
          const msg = JSON.parse(String(init?.body)) as { id?: number; method: string };
          if (msg.method === "initialize") return sse({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } });
          if (msg.method === "tools/list") return sse({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "list_meetings", annotations: { readOnlyHint: true } }] } });
          return new Response(null, { status: 202 });
        }
        if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
          return Response.json({ resource: MCP, authorization_servers: [AS], scopes_supported: ["mcp"] });
        }
        if (url === `${AS}/.well-known/oauth-authorization-server`) {
          return Response.json({
            issuer: AS,
            authorization_endpoint: "https://login.example.com/authorize",
            token_endpoint: `${AS}/token`,
            ...(registration ? { registration_endpoint: `${AS}/register` } : {}),
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (url === `${AS}/register`) {
          const body = JSON.parse(String(init?.body)) as { redirect_uris: string[]; token_endpoint_auth_method: string };
          expect(body.token_endpoint_auth_method).toBe("none");
          expect(body.redirect_uris[0]).toMatch(/\/api\/tools\/oauth\/callback$/);
          return Response.json({ client_id: "cid" }, { status: 201 });
        }
        if (url === `${AS}/token`) {
          const form = new URLSearchParams(String(init?.body));
          expect(form.get("client_id")).toBe("cid");
          expect(form.get("resource")).toBe(MCP);
          if (form.get("grant_type") === "authorization_code") {
            const verifier = form.get("code_verifier") ?? "";
            if (form.get("code") !== "good" || createHash("sha256").update(verifier).digest("base64url") !== challenge) {
              return Response.json({ error: "invalid_grant" }, { status: 400 });
            }
            return Response.json({ access_token: "at1", refresh_token: "rt1", expires_in: 3600 });
          }
          const next = tokens[form.get("refresh_token") ?? ""];
          if (!next) return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
          return Response.json({ access_token: next.access, refresh_token: next.refresh, expires_in: 3600 });
        }
        return new Response("nope", { status: 404 });
      }),
    );
  }

  beforeEach(() => {
    registration = true;
    stubOAuthServer();
  });

  async function signIn(body: Record<string, unknown> = { label: "Fathom", url: MCP }, who = admin) {
    const started = await app.inject({ method: "POST", url: `/api/orgs/${orgId}/tools/sign-in`, headers: who, payload: body });
    if (started.statusCode !== 200) return { started, back: null };
    const to = new URL(started.json().authorizeUrl);
    challenge = to.searchParams.get("code_challenge")!;
    const state = to.searchParams.get("state")!;
    const back = await app.inject({ method: "GET", url: `/api/tools/oauth/callback?code=good&state=${state}`, headers: { cookie: admin.cookie } });
    return { started, back, to };
  }

  const row = async () => (await deps.dbh.db.select().from(mcpServers))[0]!;
  const said = (res: { headers: Record<string, unknown> }) => new URL(String(res.headers.location), "https://compass.test").searchParams.get("sign_in_error") ?? "";

  it("discovers the server's sign-in, registers, sends the browser with PKCE, and saves the server with its tools", async () => {
    const { started, back, to } = await signIn();
    expect(started.statusCode).toBe(200);
    expect(to!.origin + to!.pathname).toBe("https://login.example.com/authorize");
    expect(Object.fromEntries(["response_type", "client_id", "code_challenge_method", "resource", "scope"].map((k) => [k, to!.searchParams.get(k)]))).toEqual({
      response_type: "code",
      client_id: "cid",
      code_challenge_method: "S256",
      resource: MCP,
      scope: "mcp",
    });
    expect(back!.statusCode).toBe(302);
    expect(back!.headers.location).toBe("/tools?signed_in=Fathom");
    const r = await row();
    expect([r.authKind, r.oauthBy, r.headerNames, r.tools.map((t) => [t.name, t.allowed])]).toEqual(["oauth", "alice", ["Authorization"], [["list_meetings", true]]]);
    expect(JSON.parse(decryptSecret(r.encryptedHeaders!, MASTER_KEY))).toEqual({ Authorization: "Bearer at1" });
    const listed = await app.inject({ method: "GET", url: `/api/orgs/${orgId}/tools`, headers: admin });
    expect(listed.body).not.toMatch(/at1|rt1|cid/);
    expect(listed.json().servers[0]).toMatchObject({ authKind: "oauth", oauthBy: "alice" });
    expect((await deps.dbh.db.select().from(auditLog)).some((a) => a.action === "tools.sign_in")).toBe(true);
  });

  it("says when adding by URL alone meets a server that wants a sign-in", async () => {
    const res = await add({ label: "Fathom", url: MCP });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ signIn: true });
    expect(res.json().error).toMatch(/Press Sign in/);
  });

  it("refuses an unknown or reused state, another person's return, and a refusal on the server's page", async () => {
    const unknown = await app.inject({ method: "GET", url: "/api/tools/oauth/callback?code=good&state=nope", headers: { cookie: admin.cookie } });
    expect(said(unknown)).toMatch(/That sign-in had expired/);

    const started = await app.inject({ method: "POST", url: `/api/orgs/${orgId}/tools/sign-in`, headers: admin, payload: { label: "Fathom", url: MCP } });
    const state = new URL(started.json().authorizeUrl).searchParams.get("state")!;
    const other = await app.inject({ method: "GET", url: `/api/tools/oauth/callback?code=good&state=${state}`, headers: { cookie: member.cookie } });
    expect(said(other)).toMatch(/started by someone else/);
    const again = await app.inject({ method: "GET", url: `/api/tools/oauth/callback?code=good&state=${state}`, headers: { cookie: admin.cookie } });
    expect(said(again)).toMatch(/had expired/);

    const s2 = new URL((await app.inject({ method: "POST", url: `/api/orgs/${orgId}/tools/sign-in`, headers: admin, payload: { label: "Fathom", url: MCP } })).json().authorizeUrl).searchParams.get("state")!;
    const denied = await app.inject({ method: "GET", url: `/api/tools/oauth/callback?error=access_denied&state=${s2}`, headers: { cookie: admin.cookie } });
    expect(said(denied)).toMatch(/Fathom did not sign in: access_denied/);
    expect(await deps.dbh.db.select().from(mcpServers)).toHaveLength(0);
  });

  it("says why when the server does not let apps register", async () => {
    registration = false;
    const res = await app.inject({ method: "POST", url: `/api/orgs/${orgId}/tools/sign-in`, headers: admin, payload: { url: MCP } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/does not let apps register themselves/);
  });

  it("is for admins only", async () => {
    const res = await app.inject({ method: "POST", url: `/api/orgs/${orgId}/tools/sign-in`, headers: member, payload: { url: MCP } });
    expect(res.statusCode).toBe(403);
  });

  it("renews a token about to run out before handing it to the orchestrator, and leaves out one that cannot renew", async () => {
    deps.cfg.ORCHESTRATOR_DISPATCH_TOKEN = "dispatch-tok";
    const { estates, repos } = await import("@console/db");
    const estate = (await deps.dbh.db.insert(estates).values({ orgId, name: "acme-oauth", installationId: 6 }).returning())[0]!;
    await deps.dbh.db.insert(repos).values({ orgId, estateId: estate.id, ghNodeId: "R-oauth", fullName: "acme/oauth-app" }).onConflictDoNothing();
    await signIn();
    const r = await row();
    await deps.dbh.db.update(mcpServers).set({ oauthExpiresAt: new Date(Date.now() + 60_000) }).where(eq(mcpServers.id, r.id));

    const url = "/api/orchestrator/mcp-servers?repo=acme/oauth-app";
    const got = await app.inject({ method: "GET", url, headers: { authorization: "Bearer dispatch-tok" } });
    expect(got.json().servers[0].headers).toEqual({ Authorization: "Bearer at2" });
    expect((await row()).oauthExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

    // The next renewal is refused (revoked in Fathom): the server drops out and says so.
    await deps.dbh.db.update(mcpServers).set({ oauthExpiresAt: new Date(Date.now() - 1000) }).where(eq(mcpServers.id, r.id));
    tokens = {};
    const after = await app.inject({ method: "GET", url, headers: { authorization: "Bearer dispatch-tok" } });
    expect(after.json().servers).toEqual([]);
    expect((await row()).checkError).toContain(SIGN_IN_AGAIN);
  });

  it("renews in the background only the tokens that are due", async () => {
    await signIn();
    expect(await renewDue(deps)).toBe(0);
    const r = await row();
    await deps.dbh.db.update(mcpServers).set({ oauthExpiresAt: new Date(Date.now() + 5 * 60_000) }).where(eq(mcpServers.id, r.id));
    expect(await renewDue(deps)).toBe(1);
    expect(JSON.parse(decryptSecret((await row()).encryptedHeaders!, MASTER_KEY))).toEqual({ Authorization: "Bearer at2" });
  });

  it("will not take typed headers for a signed-in server, and Sign in again keeps the tool choices", async () => {
    await signIn();
    const r = await row();
    const typed = await app.inject({ method: "PATCH", url: `/api/orgs/${orgId}/tools/${r.id}`, headers: admin, payload: { headers: [{ name: "x-api-key", value: "k" }] } });
    expect(typed.statusCode).toBe(409);
    await app.inject({ method: "PATCH", url: `/api/orgs/${orgId}/tools/${r.id}`, headers: admin, payload: { tools: { list_meetings: false } } });
    const { back } = await signIn({ serverId: r.id });
    expect(back!.headers.location).toBe("/tools?signed_in=Fathom");
    const rows = await deps.dbh.db.select().from(mcpServers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tools).toEqual([{ name: "list_meetings", readOnly: true, allowed: false }]);
  });
});
