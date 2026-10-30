import { randomBytes } from "node:crypto";
import { CredentialStore, decryptSecret, encryptSecret, loadConfig } from "@console/core";
import { auditLog, estates, githubAppConfig, issues, memberships, orgs, orchestratorSecrets, reconcileRuns, repos, sessions, users, webhookDeliveries } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * Per-org insight settings (model + API key) and the org-level secret
 * write-through: role gating, OAuth-token rejection, encrypted storage, and
 * how the QA surface reflects the org's configuration.
 */

const MASTER_KEY = randomBytes(32).toString("base64");

let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const ownerCookie = "console_session=sess-owner";
const memberCookie = "console_session=sess-member";
const id: Record<string, string> = {};

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
  deps = {
    cfg,
    dbh: { db, sql: null as never, close: async () => undefined },
    credentials: new CredentialStore({
      masterKey: MASTER_KEY,
      apiUrl: "https://api.invalid",
      load: async () => null,
      env: { appId: "1", privateKeyPem: "x", webhookSecret: "s", clientId: "c", clientSecret: "cs" },
    }),
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  app = await buildApp(deps);

  const d = deps.dbh.db;
  const owner = (
    await d.insert(users).values({ ghUserId: 1, login: "alice", encryptedOauthToken: encryptSecret("t", MASTER_KEY) }).returning()
  )[0]!;
  const member = (
    await d.insert(users).values({ ghUserId: 2, login: "bob", encryptedOauthToken: encryptSecret("t", MASTER_KEY) }).returning()
  )[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await d.insert(memberships).values([
    { orgId: org.id, userId: owner.id, role: "owner" },
    { orgId: org.id, userId: member.id, role: "member" },
  ]);
  await d.insert(sessions).values([
    { id: "sess-owner", userId: owner.id, expiresAt: new Date(Date.now() + 3600_000) },
    { id: "sess-member", userId: member.id, expiresAt: new Date(Date.now() + 3600_000) },
  ]);
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const repo = (
    await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/app" }).returning()
  )[0]!;
  const epic = (
    await d
      .insert(issues)
      .values({
        orgId: org.id,
        repoId: repo.id,
        ghNodeId: "I1",
        number: 1,
        title: "epic",
        state: "open",
        kind: "epic",
        factoryState: "factory:intake",
        ghUpdatedAt: new Date(),
        htmlUrl: "https://gh/1",
      })
      .returning()
  )[0]!;
  id.org = org.id;
  id.estate = estate.id;
  id.epic = epic.id;
});

describe("org insight settings", () => {
  it("starts unconfigured and disabled", async () => {
    const res = await app.inject({ method: "GET", url: `/api/orgs/${id.org}/settings`, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, never>;
    expect((body["insight"] as { hasKey: boolean }).hasKey).toBe(false);
    const qa = await app.inject({ method: "GET", url: `/api/epics/${id.epic}/qa`, headers: { cookie: ownerCookie } });
    expect((qa.json() as { enabled: boolean }).enabled).toBe(false);
  });

  it("rejects a Claude Code OAuth token with an explanation", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { apiKey: "sk-ant-oat01-abc" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("OAuth token");
  });

  it("rejects non-admin members", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight`,
      headers: { cookie: memberCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { model: "claude-opus-5" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("stores model + key (encrypted), enables QA, and clears again", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { model: "claude-opus-5", apiKey: "sk-ant-api03-real-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, model: "claude-opus-5", hasKey: true });

    // Stored encrypted, not in the clear — and decrypts back to the input.
    const row = (await deps.dbh.db.select().from(orgs).where(eq(orgs.id, id.org)))[0]!;
    expect(row.encryptedInsightApiKey).not.toContain("sk-ant-api03");
    expect(decryptSecret(row.encryptedInsightApiKey!, MASTER_KEY)).toBe("sk-ant-api03-real-key");

    // The QA surface now reports enabled with the org's model.
    const qa = await app.inject({ method: "GET", url: `/api/epics/${id.epic}/qa`, headers: { cookie: ownerCookie } });
    expect(qa.json()).toMatchObject({ enabled: true, model: "claude-opus-5" });

    // Clearing the key disables again (no instance-wide fallback in this test).
    const clear = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { apiKey: null },
    });
    expect(clear.json()).toMatchObject({ ok: true, hasKey: false });
    const qa2 = await app.inject({ method: "GET", url: `/api/epics/${id.epic}/qa`, headers: { cookie: ownerCookie } });
    expect((qa2.json() as { enabled: boolean }).enabled).toBe(false);
  });

  it("enables QA from the retained factory ANTHROPIC_API_KEY", async () => {
    await deps.dbh.db.insert(orchestratorSecrets).values({
      orgId: id.org,
      name: "ANTHROPIC_API_KEY",
      encryptedValue: encryptSecret("sk-ant-from-factory", MASTER_KEY),
      updatedBy: "alice",
      updatedAt: new Date(),
    });
    const qa = await app.inject({ method: "GET", url: `/api/epics/${id.epic}/qa`, headers: { cookie: ownerCookie } });
    expect(qa.json()).toMatchObject({ enabled: true, provider: "anthropic" });
    const settings = await app.inject({ method: "GET", url: `/api/orgs/${id.org}/settings`, headers: { cookie: ownerCookie } });
    expect((settings.json() as { insight: { globalKeyConfigured: boolean } }).insight.globalKeyConfigured).toBe(true);
    await deps.dbh.db.delete(orchestratorSecrets).where(eq(orchestratorSecrets.orgId, id.org));
  });
});

describe("provider selection", () => {
  it("rejects unknown providers and non-anthropic providers without a model", async () => {
    const bad = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { provider: "gemini" },
    });
    expect(bad.statusCode).toBe(400);
    const noModel = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { provider: "openrouter", model: null },
    });
    expect(noModel.statusCode).toBe(400);
    expect((noModel.json() as { error: string }).error).toContain("model is required");
  });

  it("stores an OpenAI-compatible provider config and surfaces it on the QA panel", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { provider: "openrouter", model: "x-ai/grok-4", apiKey: "sk-or-v1-abc" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, provider: "openrouter", model: "x-ai/grok-4", hasKey: true });

    const settings = await app.inject({ method: "GET", url: `/api/orgs/${id.org}/settings`, headers: { cookie: ownerCookie } });
    expect((settings.json() as { insight: { provider: string } }).insight.provider).toBe("openrouter");

    const qa = await app.inject({ method: "GET", url: `/api/epics/${id.epic}/qa`, headers: { cookie: ownerCookie } });
    expect(qa.json()).toMatchObject({ enabled: true, provider: "openrouter", model: "x-ai/grok-4" });

    // The Claude Code OAuth-token guard is Anthropic-specific — an OpenRouter
    // key that happens to share the prefix is not second-guessed.
    const oat = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { apiKey: "sk-ant-oat01-whatever" },
    });
    expect(oat.statusCode).toBe(200);

    // Reset to a cleared state for the secret tests below.
    await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { provider: "anthropic", model: null, apiKey: null },
    });
  });
});

describe("model listing (key-first configuration)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists models with a request-supplied key before anything is saved", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ data: [{ id: "grok-4" }, { id: "grok-4-fast" }] }), { status: 200 });
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight/models`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { provider: "grok", apiKey: "xai-typed-not-saved" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: "grok", models: ["grok-4", "grok-4-fast"] });
    expect(calls[0]!.url).toContain("api.x.ai");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer xai-typed-not-saved");
  });

  it("400s without any usable key, and rejects OAuth tokens for anthropic", async () => {
    const noKey = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight/models`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { provider: "openai" },
    });
    expect(noKey.statusCode).toBe(400);
    const oat = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight/models`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { provider: "anthropic", apiKey: "sk-ant-oat01-x" },
    });
    expect(oat.statusCode).toBe(400);
    expect((oat.json() as { error: string }).error).toContain("OAuth token");
  });

  it("passes the provider's error through as a 502 (bad key)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight/models`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { provider: "openai", apiKey: "sk-bad" },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toContain("openai 401");
  });

  it("says so when the stored key was sealed under another master key", async () => {
    const other = randomBytes(32).toString("base64");
    await deps.dbh.db
      .update(orgs)
      .set({ insightProvider: "openai", encryptedInsightApiKey: encryptSecret("sk-old", other) })
      .where(eq(orgs.id, id.org));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight/models`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { provider: "openai" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain("Enter the key again");
    expect(fetchSpy).not.toHaveBeenCalled();
    await deps.dbh.db
      .update(orgs)
      .set({ insightProvider: "anthropic", encryptedInsightApiKey: null })
      .where(eq(orgs.id, id.org));
  });

  it("falls back to the stored org key for the matching provider", async () => {
    // Store an OpenRouter key first.
    await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { provider: "openrouter", model: "x-ai/grok-4", apiKey: "sk-or-stored" },
    });
    const calls: Array<{ init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ init });
        return new Response(JSON.stringify({ data: [{ id: "x-ai/grok-4" }] }), { status: 200 });
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight/models`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { provider: "openrouter" },
    });
    expect(res.statusCode).toBe(200);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-or-stored");

    // Reset for the secret tests below.
    await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/insight`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { provider: "anthropic", model: null, apiKey: null },
    });
  });
});

describe("org secret write-through", () => {
  it("rejects unknown secret names and non-admins", async () => {
    const bad = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/secrets`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { name: "NOT_A_SECRET", value: "v" },
    });
    expect(bad.statusCode).toBe(400);
    const member = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/secrets`,
      headers: { cookie: memberCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "v" },
    });
    expect(member.statusCode).toBe(403);
  });

  it("reports per-repo results (GitHub unreachable in tests → per-repo failure, not a 5xx)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/secrets`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "tok" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; stored: boolean; githubActions: boolean; results: Array<{ repo: string; ok: boolean }> };
    expect(body.name).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(body.stored).toBe(true);
    expect(body.githubActions).toBe(true);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ repo: "acme/app", ok: false });
  });
});

describe("org orchestrator", () => {
  it("defaults to GitHub Actions", async () => {
    const res = await app.inject({ method: "GET", url: `/api/orgs/${id.org}/settings`, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      orchestrator: { engine: "github-actions", githubActionsEnabled: true },
    });
  });

  it("rejects an unknown engine and non-admins", async () => {
    const bad = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/orchestrator`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { engine: "langgraph" },
    });
    expect(bad.statusCode).toBe(400);
    const member = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/orchestrator`,
      headers: { cookie: memberCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { engine: "software-factory" },
    });
    expect(member.statusCode).toBe(403);
  });

  it("selects Software Factory and then does not write GitHub Actions secrets", async () => {
    const set = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/orchestrator`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { engine: "software-factory" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ engine: "software-factory", githubActionsEnabled: false });

    const got = await app.inject({ method: "GET", url: `/api/orgs/${id.org}/settings`, headers: { cookie: ownerCookie } });
    expect(got.json()).toMatchObject({ orchestrator: { engine: "software-factory", githubActionsEnabled: false } });

    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/secrets`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { name: "ANTHROPIC_API_KEY", value: "sk-ant-from-console" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: true, githubActions: false, results: [] });

    const rows = await deps.dbh.db.select().from(orchestratorSecrets);
    const ant = rows.find((r) => r.name === "ANTHROPIC_API_KEY");
    expect(ant).toMatchObject({ orgId: id.org });
    expect(decryptSecret(ant!.encryptedValue, MASTER_KEY)).toBe("sk-ant-from-console");

    const meta = await app.inject({ method: "GET", url: `/api/orgs/${id.org}/settings`, headers: { cookie: ownerCookie } });
    const retained = (meta.json() as { retainedSecrets: Array<{ name: string }> }).retainedSecrets;
    expect(retained.map((r) => r.name)).toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(meta.json())).not.toContain("sk-ant-from-console");

    await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/orchestrator`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { engine: "github-actions" },
    });
  });
});

describe("GET /api/ops/ingestion", () => {
  it("403s everyone who is not the GitHub App owner", async () => {
    // The store resolves env credentials, so setupAccess requires App
    // ownership — with GitHub unreachable and no configured_by recorded,
    // nobody qualifies yet.
    const res = await app.inject({ method: "GET", url: "/api/ops/ingestion", headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(403);
  });

  it("serves the delivery ledger and reconcile runs to the App owner", async () => {
    const d = deps.dbh.db;
    // GitHub is unreachable in tests, so ownership falls back to who
    // registered the App in the Console: alice.
    await d.insert(githubAppConfig).values({
      appId: "1",
      encryptedPrivateKey: "x",
      encryptedWebhookSecret: "x",
      clientId: "c",
      encryptedClientSecret: "x",
      configuredBy: "alice",
    });
    await d.insert(webhookDeliveries).values([
      { deliveryGuid: "d-ok", event: "issues", processedAt: new Date(), payload: { action: "opened", repository: { full_name: "acme/app" } } },
      { deliveryGuid: "d-stuck", event: "issues", error: "no GitHub App registered", payload: { action: "labeled", repository: { full_name: "acme/app" } } },
    ]);
    await d.insert(reconcileRuns).values({
      estateId: id.estate,
      trigger: "on-demand",
      finishedAt: new Date(),
      reposWalked: 1,
      issuesSeen: 5,
      pullsSeen: 2,
      errors: [],
    });

    const member = await app.inject({ method: "GET", url: "/api/ops/ingestion", headers: { cookie: memberCookie } });
    expect(member.statusCode).toBe(403);

    const res = await app.inject({ method: "GET", url: "/api/ops/ingestion", headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      summary: { pending: number; failing: number; total: number };
      deliveries: Array<{ deliveryGuid: string; action: string | null; repo: string | null; error: string | null }>;
      reconciles: Array<{ estateName: string | null; trigger: string; issuesSeen: number }>;
    };
    expect(body.summary).toMatchObject({ pending: 1, failing: 1, total: 2 });
    const stuck = body.deliveries.find((x) => x.deliveryGuid === "d-stuck")!;
    expect(stuck).toMatchObject({ action: "labeled", repo: "acme/app", error: "no GitHub App registered" });
    expect(body.reconciles[0]).toMatchObject({ estateName: "acme", trigger: "on-demand", issuesSeen: 5 });
  });

  it("replays only the unprocessed deliveries from the ledger, owner-only", async () => {
    const added: Array<{ name: string; data: { deliveryGuid: string } }> = [];
    deps.ingestQueue = { add: async (name: string, data: { deliveryGuid: string }) => void added.push({ name, data }) } as never;

    const member = await app.inject({
      method: "POST",
      url: "/api/ops/ingestion/replay",
      headers: { cookie: memberCookie, "x-console-csrf": "1" },
    });
    expect(member.statusCode).toBe(403);
    expect(added).toHaveLength(0);

    const res = await app.inject({
      method: "POST",
      url: "/api/ops/ingestion/replay",
      headers: { cookie: ownerCookie, "x-console-csrf": "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, queued: 1 });
    // d-ok is already processed; only the stuck delivery goes back on the queue.
    expect(added.map((a) => a.data.deliveryGuid)).toEqual(["d-stuck"]);
  });
});

describe("org branch defaults", () => {
  it("starts unset and round-trips a save", async () => {
    let res = await app.inject({ method: "GET", url: `/api/orgs/${id.org}/settings`, headers: { cookie: ownerCookie } });
    expect(res.json().branches).toEqual({ defaultBranch: null, stagingBranch: null });

    res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/branches`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { defaultBranch: "main", stagingBranch: "integration" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, defaultBranch: "main", stagingBranch: "integration" });

    res = await app.inject({ method: "GET", url: `/api/orgs/${id.org}/settings`, headers: { cookie: ownerCookie } });
    expect(res.json().branches).toEqual({ defaultBranch: "main", stagingBranch: "integration" });

    // Clearing goes back to the factory defaults.
    res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/branches`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { stagingBranch: null },
    });
    expect(res.json()).toMatchObject({ ok: true, defaultBranch: "main", stagingBranch: null });
  });

  it("rejects invalid names, same-name pairs, and non-admins", async () => {
    let res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/branches`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { stagingBranch: "bad branch" },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/branches`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { defaultBranch: "trunk", stagingBranch: "trunk" },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: "POST",
      url: `/api/orgs/${id.org}/settings/branches`,
      headers: { cookie: memberCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { stagingBranch: "integration" },
    });
    expect(res.statusCode).toBe(403);
  });
});
