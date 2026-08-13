import { randomBytes } from "node:crypto";
import { CredentialStore, decryptSecret, encryptSecret, loadConfig } from "@console/core";
import { estates, issues, memberships, orgs, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
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
    const body = res.json() as { name: string; results: Array<{ repo: string; ok: boolean }> };
    expect(body.name).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ repo: "acme/app", ok: false });
  });
});
