import { generateKeyPairSync } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, memberships, orgs, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const PKCS8 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const cookie = "console_session=sess-1";

let app: Awaited<ReturnType<typeof buildApp>>;
let deps: AppDeps;

beforeEach(async () => {
  const pg = new PGlite();
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of (await readFile(join(migrationsDir, file), "utf8")).split("--> statement-breakpoint")) {
      if (stmt.trim()) await pg.exec(stmt.trim());
    }
  }
  const db = drizzle(pg);
  const cfg = loadConfig({
    CONSOLE_MASTER_KEY: MASTER_KEY,
    NODE_ENV: "test",
    ORCHESTRATOR_URL: "http://127.0.0.1:8080",
    ORCHESTRATOR_DISPATCH_TOKEN: "op-token",
  } as never);
  const depsLocal: AppDeps = {
    cfg,
    dbh: { db: db as never, sql: null as never, close: async () => undefined },
    credentials: new CredentialStore({
      masterKey: MASTER_KEY,
      apiUrl: "https://api.invalid",
      load: async () => null,
      env: { appId: "1", privateKeyPem: PKCS8, webhookSecret: "s", clientId: "c", clientSecret: "cs" },
    }),
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  deps = depsLocal;
  const user = (
    await deps.dbh.db
      .insert(users)
      .values({ ghUserId: 1, login: "alice", encryptedOauthToken: encryptSecret("t", MASTER_KEY) })
      .returning()
  )[0]!;
  const org = (await deps.dbh.db.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  await deps.dbh.db.insert(sessions).values({ id: "sess-1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });
  await deps.dbh.db.insert(estates).values({ orgId: org.id, name: "acme", installationId: 99 });
  app = await buildApp(deps);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

describe("GET /api/orchestrator/runs/:id", () => {
  it("requires a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/orchestrator/runs/abc" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the orchestrator run object for the modal", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            id: "ee6a9128-10c0-469c-baa1-3c47b2a08c3c",
            role: "profiler",
            outcome: "running",
            events: [{ ts: "2026-08-28T03:00:00Z", kind: "phase", message: "waiting for tests" }],
          }),
          { status: 200 },
        ),
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/orchestrator/runs/ee6a9128-10c0-469c-baa1-3c47b2a08c3c",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      role: "profiler",
      outcome: "running",
      events: [{ message: "waiting for tests" }],
    });
  });
});

describe("POST /api/orchestrator/github-token", () => {
  it("rejects a missing dispatch token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/orchestrator/github-token",
      headers: { "content-type": "application/json" },
      payload: { installation_id: 99 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("mints a fresh installation token for a known installation", async () => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      expect(String(url)).toContain("/app/installations/99/access_tokens");
      return new Response(
        JSON.stringify({
          token: "ghs_just_before_action",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 201 },
      );
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/orchestrator/github-token",
      headers: { authorization: "Bearer op-token", "content-type": "application/json" },
      payload: { installation_id: 99 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ token: "ghs_just_before_action" });
    expect(typeof (res.json() as { expires_at: string }).expires_at).toBe("string");
  });

  it("refuses to mint for an installation the Console does not know", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/orchestrator/github-token",
      headers: { authorization: "Bearer op-token", "content-type": "application/json" },
      payload: { installation_id: 404 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/orchestrator/usage", () => {
  it("requires a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/orchestrator/usage" });
    expect(res.statusCode).toBe(401);
  });

  it("passes the orchestrator's usage summary through", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ runs: 3, total_tokens: 1200, limit: { reached: false } }), { status: 200 });
    });
    const res = await app.inject({ method: "GET", url: "/api/orchestrator/usage", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ usage: { runs: 3, total_tokens: 1200, limit: { reached: false } } });
    expect(seen).toEqual(["http://127.0.0.1:8080/usage"]);
  });

  it("shows nothing, not an error, when the orchestrator cannot say", async () => {
    for (const reply of [new Response("", { status: 404 }), new Response("", { status: 500 })]) {
      vi.stubGlobal("fetch", async () => reply);
      const res = await app.inject({ method: "GET", url: "/api/orchestrator/usage", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ usage: null });
    }
  });
});

describe("POST /api/threads/:id/ask", () => {
  async function seedThread() {
    const { issues, repos, threads } = await import("@console/db");
    const estate = (await deps.dbh.db.select().from(estates))[0]!;
    const repo = (
      await deps.dbh.db
        .insert(repos)
        .values({ orgId: estate.orgId, estateId: estate.id, ghNodeId: "r1", fullName: "acme/api", defaultBranch: "main" } as never)
        .returning()
    )[0]!;
    const epic = (
      await deps.dbh.db
        .insert(issues)
        .values({ orgId: estate.orgId, repoId: repo.id, number: 34, kind: "epic", title: "Epic", state: "open", labels: [], ghNodeId: "n1", ghId: 1, ghCreatedAt: new Date(), ghUpdatedAt: new Date() } as never)
        .returning()
    )[0]!;
    const thread = (
      await deps.dbh.db
        .insert(threads)
        .values({ orgId: estate.orgId, epicIssueId: epic.id, topicKind: "epic", topicRef: "epic", title: "Epic" } as never)
        .returning()
    )[0]!;
    return thread;
  }

  it("requires a session and a question", async () => {
    const t = await seedThread();
    expect((await app.inject({ method: "POST", url: `/api/threads/${t.id}/ask`, payload: { question: "why?" } })).statusCode).toBe(401);
    const res = await app.inject({
      method: "POST", url: `/api/threads/${t.id}/ask`, headers: { cookie, "x-console-csrf": "1" }, payload: { question: " " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("asks the orchestrator and saves the question and answer in the thread", async () => {
    const t = await seedThread();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ answer: "It stopped at the rework cap.", model: "claude-sonnet-5-5" }), { status: 200 });
    });
    const res = await app.inject({
      method: "POST", url: `/api/threads/${t.id}/ask`, headers: { cookie, "x-console-csrf": "1" }, payload: { question: "Why is it blocked?" },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/ask");
    expect(calls[0]!.body).toMatchObject({ owner: "acme", repo: "api", question: "Why is it blocked?", branch: "factory/epic-34" });
    expect(String(calls[0]!.body.instructions)).toContain("Writing standard");
    const { threadEntries } = await import("@console/db");
    const entries = await deps.dbh.db.select().from(threadEntries);
    expect(entries.map((e) => [e.source, e.author, e.body])).toEqual([
      ["ask_question", "alice", "Why is it blocked?"],
      ["ask_answer", "factory", "It stopped at the rework cap."],
    ]);
  });

  it("shows the orchestrator's reason and saves nothing when it cannot answer", async () => {
    const t = await seedThread();
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ detail: "Claude usage limit reached: resets 2:50pm (UTC)." }), { status: 429 }));
    const res = await app.inject({
      method: "POST", url: `/api/threads/${t.id}/ask`, headers: { cookie, "x-console-csrf": "1" }, payload: { question: "why?" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain("usage limit");
    const { threadEntries } = await import("@console/db");
    expect(await deps.dbh.db.select().from(threadEntries)).toEqual([]);
  });
});

describe("POST /api/epics/:id/qa with a Claude token", () => {
  async function seedEpicWithToken() {
    const { issues, orchestratorSecrets, repos } = await import("@console/db");
    const estate = (await deps.dbh.db.select().from(estates))[0]!;
    const repo = (
      await deps.dbh.db
        .insert(repos)
        .values({ orgId: estate.orgId, estateId: estate.id, ghNodeId: "r2", fullName: "acme/web", defaultBranch: "main" } as never)
        .returning()
    )[0]!;
    const epic = (
      await deps.dbh.db
        .insert(issues)
        .values({ orgId: estate.orgId, repoId: repo.id, number: 36, kind: "epic", title: "Bug epic", state: "open", labels: [], ghNodeId: "n2", ghId: 2, ghCreatedAt: new Date(), ghUpdatedAt: new Date() } as never)
        .returning()
    )[0]!;
    await deps.dbh.db
      .insert(orchestratorSecrets)
      .values({ orgId: estate.orgId, name: "CLAUDE_CODE_OAUTH_TOKEN", encryptedValue: encryptSecret("sk-ant-oat01-x", MASTER_KEY) } as never);
    return epic;
  }

  it("asks the orchestrator's Claude CLI first and cites the numbered sources", async () => {
    const epic = await seedEpicWithToken();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(
        JSON.stringify({ answer: "The epic body says it is a bug fix [1].", model: "claude-sonnet-5-5", usage: { input_tokens: 900, output_tokens: 60 } }),
        { status: 200 },
      );
    });
    const listed = await app.inject({ method: "GET", url: `/api/epics/${epic.id}/qa`, headers: { cookie } });
    expect(listed.json()).toMatchObject({ enabled: true, via: "claude" });
    const res = await app.inject({
      method: "POST", url: `/api/epics/${epic.id}/qa`, headers: { cookie, "x-console-csrf": "1" }, payload: { question: "What is this?" },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/ask");
    expect(calls[0]!.body).toMatchObject({ owner: "acme", repo: "web", branch: "factory/epic-36", claude_code_oauth_token: "sk-ant-oat01-x" });
    expect(String(calls[0]!.body.context)).toContain("[1] (comment) Epic #36: Bug epic");
    expect(String(calls[0]!.body.instructions)).toContain("Writing standard");
    expect(String(calls[0]!.body.instructions)).toContain("numbered sources");
    expect(res.json()).toMatchObject({ answer: "The epic body says it is a bug fix [1].", cost: { inputTokens: 900, outputTokens: 60 } });
    expect(res.json().citations[0]).toMatchObject({ ref: "issue/36" });
  });

  it("says why when the Claude CLI cannot answer and there is no API key to fall back on", async () => {
    const epic = await seedEpicWithToken();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ detail: "Claude usage limit reached: resets 2:50pm (UTC)." }), { status: 429 }));
    const res = await app.inject({
      method: "POST", url: `/api/epics/${epic.id}/qa`, headers: { cookie, "x-console-csrf": "1" }, payload: { question: "why?" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain("usage limit");
  });
});
