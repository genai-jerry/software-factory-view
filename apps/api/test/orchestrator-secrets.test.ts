import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialStore, decryptSecret, encryptSecret, loadConfig } from "@console/core";
import { memberships, orchestratorSecrets, orgs, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * Agent-secret retention for the orchestrator engine: values written through
 * the Console are sealed into orchestrator_secrets so the LangGraph engine
 * can read them back — while the Console API itself stays write-only
 * (metadata out, never values). The org here has no estates, so the GitHub
 * write-through loop is a no-op and no network is touched.
 */

const MASTER_KEY = randomBytes(32).toString("base64");

let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const ownerCookie = "console_session=sess-owner";
const id: Record<string, string> = {};

async function makeDeps(masterKey: string): Promise<AppDeps> {
  const pg = new PGlite();
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of (await readFile(join(migrationsDir, file), "utf8")).split("--> statement-breakpoint")) {
      if (stmt.trim()) await pg.exec(stmt.trim());
    }
  }
  const db = drizzle(pg) as never;
  const cfg = loadConfig({ CONSOLE_MASTER_KEY: masterKey, GITHUB_APP_WEBHOOK_SECRET: "s", NODE_ENV: "test" } as never);
  return {
    cfg,
    dbh: { db, sql: null as never, close: async () => undefined },
    credentials: new CredentialStore({
      masterKey: masterKey || MASTER_KEY,
      apiUrl: "https://api.invalid",
      load: async () => null,
      env: { appId: "1", privateKeyPem: "x", webhookSecret: "s", clientId: "c", clientSecret: "cs" },
    }),
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
}

async function seedOrg(d: AppDeps): Promise<string> {
  const db = d.dbh.db;
  const owner = (
    await db.insert(users).values({ ghUserId: 1, login: "alice", encryptedOauthToken: encryptSecret("t", MASTER_KEY) }).returning()
  )[0]!;
  const org = (await db.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await db.insert(memberships).values([{ orgId: org.id, userId: owner.id, role: "owner" }]);
  await db.insert(sessions).values([{ id: "sess-owner", userId: owner.id, expiresAt: new Date(Date.now() + 3600_000) }]);
  return org.id;
}

beforeAll(async () => {
  deps = await makeDeps(MASTER_KEY);
  app = await buildApp(deps);
  id.org = await seedOrg(deps);
});

async function putSecret(name: string, value: string) {
  return app.inject({
    method: "POST",
    url: `/api/orgs/${id.org}/settings/secrets`,
    headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
    payload: { name, value },
  });
}

describe("orchestrator secret retention", () => {
  it("retains an org secret encrypted, decryptable with the master key", async () => {
    const res = await putSecret("ANTHROPIC_API_KEY", "sk-ant-agent-1");
    expect(res.statusCode).toBe(200);
    expect((res.json() as { retained: boolean }).retained).toBe(true);

    const rows = await deps.dbh.db
      .select()
      .from(orchestratorSecrets)
      .where(eq(orchestratorSecrets.orgId, id.org));
    expect(rows.map((r) => r.name)).toEqual(["ANTHROPIC_API_KEY"]);
    expect(rows[0]!.encryptedValue).not.toContain("sk-ant-agent-1");
    expect(rows[0]!.encryptedValue.startsWith("v1.")).toBe(true);
    expect(decryptSecret(rows[0]!.encryptedValue, MASTER_KEY)).toBe("sk-ant-agent-1");
    expect(rows[0]!.updatedBy).toBe("alice");
  });

  it("upserts on rewrite — one row per org+name, newest value wins", async () => {
    await putSecret("ANTHROPIC_API_KEY", "sk-ant-agent-2");
    const rows = await deps.dbh.db
      .select()
      .from(orchestratorSecrets)
      .where(eq(orchestratorSecrets.orgId, id.org));
    expect(rows).toHaveLength(1);
    expect(decryptSecret(rows[0]!.encryptedValue, MASTER_KEY)).toBe("sk-ant-agent-2");
  });

  it("exposes metadata, never values, on the settings surface", async () => {
    const res = await app.inject({ method: "GET", url: `/api/orgs/${id.org}/settings`, headers: { cookie: ownerCookie } });
    const body = res.json() as { retainedSecrets: Array<{ name: string; updatedAt: string }> };
    expect(body.retainedSecrets.map((s) => s.name)).toEqual(["ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(body)).not.toContain("sk-ant-agent");
  });

  it("still rejects names outside the allow-list", async () => {
    const res = await putSecret("SOMETHING_ELSE", "x");
    expect(res.statusCode).toBe(400);
  });

  it("skips retention without a master key, and says so", async () => {
    const bare = await makeDeps("");
    const bareApp = await buildApp(bare);
    const orgId = await seedOrg(bare);
    const res = await bareApp.inject({
      method: "POST",
      url: `/api/orgs/${orgId}/settings/secrets`,
      headers: { cookie: ownerCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { name: "ANTHROPIC_API_KEY", value: "sk-ant-agent-3" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { retained: boolean }).retained).toBe(false);
    const rows = await bare.dbh.db.select().from(orchestratorSecrets);
    expect(rows).toHaveLength(0);
  });
});
