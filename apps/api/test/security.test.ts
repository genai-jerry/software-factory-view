import { createHmac, randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { memberships, orgs, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/** Auth, CSRF and webhook-signature behaviour — the SPA+API trust boundary. */

const MASTER_KEY = randomBytes(32).toString("base64");
const WEBHOOK_SECRET = "test-webhook-secret";

let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
let sessionCookie: string;

beforeAll(async () => {
  const pg = new PGlite();
  const migrationPath = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations/0000_init.sql");
  for (const stmt of (await readFile(migrationPath, "utf8")).split("--> statement-breakpoint")) {
    if (stmt.trim()) await pg.exec(stmt.trim());
  }
  const db = drizzle(pg) as never;

  const cfg = loadConfig({
    CONSOLE_MASTER_KEY: MASTER_KEY,
    GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    NODE_ENV: "test",
  } as never);
  const enqueued: unknown[] = [];
  deps = {
    cfg,
    dbh: { db, sql: null as never, close: async () => undefined },
    credentials: new CredentialStore({
      masterKey: MASTER_KEY,
      apiUrl: "https://api.invalid",
      load: async () => null, // no DB row: exercises the environment fallback
      env: {
        appId: "12345",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
        webhookSecret: WEBHOOK_SECRET,
        clientId: "Iv1.test",
        clientSecret: "shh",
      },
    }),
    ingestQueue: { add: async (...args: unknown[]) => enqueued.push(args) } as never,
    reconcileQueue: { add: async () => undefined } as never,
  };
  app = await buildApp(deps);

  // A signed-in user with an org membership.
  const { db: d } = deps.dbh;
  const user = (
    await d
      .insert(users)
      .values({ ghUserId: 42, login: "alice", encryptedOauthToken: encryptSecret("gho_test", MASTER_KEY) })
      .returning()
  )[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await d.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  await d.insert(sessions).values({ id: "sess-1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });
  sessionCookie = "console_session=sess-1";
});

describe("session auth", () => {
  it("rejects unauthenticated API reads with 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/attention" });
    expect(res.statusCode).toBe(401);
  });

  it("accepts an authenticated read", async () => {
    const res = await app.inject({ method: "GET", url: "/api/attention", headers: { cookie: sessionCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [] });
  });

  it("rejects an expired session", async () => {
    const { db } = deps.dbh;
    const user = (await db.select().from(users)).at(0)!;
    await db.insert(sessions).values({ id: "sess-old", userId: user.id, expiresAt: new Date(Date.now() - 1000) });
    const res = await app.inject({ method: "GET", url: "/api/attention", headers: { cookie: "console_session=sess-old" } });
    expect(res.statusCode).toBe(401);
  });

  it("sets no-store on authenticated JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/api/attention", headers: { cookie: sessionCookie } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("CSRF", () => {
  it("rejects a state-changing call without the custom header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/threads/00000000-0000-0000-0000-000000000000/status",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { status: "resolved" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/CSRF/);
  });

  it("accepts the same call with the header (404 — thread does not exist, but auth passed)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/threads/00000000-0000-0000-0000-000000000000/status",
      headers: { cookie: sessionCookie, "content-type": "application/json", "x-console-csrf": "1" },
      payload: { status: "resolved" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("webhook endpoint", () => {
  const payload = JSON.stringify({ action: "opened", zen: "test" });
  const sign = (body: string) => `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;

  it("rejects a bad signature", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + "0".repeat(64),
        "x-github-event": "issues",
        "x-github-delivery": "d-1",
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a valid signature and enqueues", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(payload),
        "x-github-event": "issues",
        "x-github-delivery": "d-2",
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("short-circuits a duplicate delivery GUID", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(payload),
        "x-github-event": "issues",
        "x-github-delivery": "d-2",
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().duplicate).toBe(true);
  });
});
