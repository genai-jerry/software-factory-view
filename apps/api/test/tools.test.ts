import { randomBytes } from "node:crypto";
import { CredentialStore, decryptSecret, loadConfig } from "@console/core";
import { auditLog, mcpServers, memberships, orgs, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";
import { sseMessages } from "../src/mcp-client.js";
import { mergeTools, slugFor } from "../src/routes/tools.js";

/**
 * Compass → Tools: an admin adds a remote MCP server; Compass lists its tools
 * before saving, read-only tools start allowed, headers are sealed and never
 * returned, and members can see but not change.
 */

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

describe("helpers", () => {
  it("makes ids Claude can use, unique in the org", () => {
    expect(slugFor("Sarvam Docs!", new Set())).toBe("sarvam_docs");
    expect(slugFor("docs.sarvam.ai", new Set(["docs_sarvam_ai"]))).toBe("docs_sarvam_ai_2");
    expect(slugFor("42", new Set())).toBe("s_42");
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
