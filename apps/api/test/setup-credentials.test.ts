import { generateKeyPairSync, randomBytes } from "node:crypto";
import { CredentialStore, decryptSecret, encryptSecret, loadConfig } from "@console/core";
import { githubAppConfig, memberships, orgs, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * Manual GitHub App registration — the path for an App that already exists, or
 * for a Console github.com cannot reach to run the manifest handshake.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const PKCS1 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const VALID = {
  appId: "123456",
  slug: "factory-console",
  privateKeyPem: PKCS1,
  webhookSecret: "whsec",
  clientId: "Iv1.abc",
  clientSecret: "cs",
};

let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
let sessionCookie: string;

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/setup/credentials",
    headers: { "content-type": "application/json", "x-console-csrf": "1", ...headers },
    payload: payload as never,
  });

beforeEach(async () => {
  const pg = new PGlite();
  const migrations = dirname(fileURLToPath(import.meta.url));
  for (const file of ["0000_init.sql", "0001_app_config.sql"]) {
    const sql = await readFile(join(migrations, "../../../packages/db/migrations", file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt.trim());
  }
  const db = drizzle(pg);

  const cfg = loadConfig({ CONSOLE_MASTER_KEY: MASTER_KEY, NODE_ENV: "test" } as never);
  deps = {
    cfg,
    dbh: { db: db as never, sql: null as never, close: async () => undefined },
    credentials: new CredentialStore({
      masterKey: MASTER_KEY,
      apiUrl: "https://api.invalid",
      // Backed by the real table, so the store sees what the endpoint wrote.
      load: async () => (await db.select().from(githubAppConfig))[0] ?? null,
      env: { appId: "", privateKeyPem: "", webhookSecret: "", clientId: "", clientSecret: "" },
    }),
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  app = await buildApp(deps);

  const user = (
    await deps.dbh.db
      .insert(users)
      .values({ ghUserId: 42, login: "alice", encryptedOauthToken: encryptSecret("gho_test", MASTER_KEY) })
      .returning()
  )[0]!;
  const org = (await deps.dbh.db.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  await deps.dbh.db.insert(sessions).values({ id: "sess-1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });
  sessionCookie = "console_session=sess-1";
});

describe("manual App registration", () => {
  it("stores the credentials encrypted and resolves the App without a restart", async () => {
    expect(await deps.credentials.isConfigured()).toBe(false);

    const res = await post(VALID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, appId: "123456", slug: "factory-console" });

    const row = (await deps.dbh.db.select().from(githubAppConfig))[0]!;
    expect(row.appId).toBe("123456");
    expect(row.encryptedPrivateKey).not.toContain("PRIVATE KEY"); // stored ciphertext, not the PEM
    // GitHub hands out PKCS#1; jose needs PKCS#8, so the conversion happens here.
    expect(decryptSecret(row.encryptedPrivateKey, MASTER_KEY)).toContain("BEGIN PRIVATE KEY");
    expect(decryptSecret(row.encryptedClientSecret, MASTER_KEY)).toBe("cs");

    const resolved = await deps.credentials.resolve();
    expect(resolved?.source).toBe("database");
    expect(resolved?.appId).toBe("123456");
    expect(await deps.credentials.webhookSecret()).toBe("whsec");
  });

  it("accepts a PKCS#8 key and a \\n-escaped one-line PEM", async () => {
    const escaped = { ...VALID, privateKeyPem: PKCS1.replace(/\n/g, "\\n") };
    expect((await post(escaped)).statusCode).toBe(200);
    expect((await deps.credentials.resolve())?.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  });

  it("rejects a write without the CSRF header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/credentials",
      headers: { "content-type": "application/json" },
      payload: VALID as never,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/CSRF/);
  });

  it("names the fields it is missing", async () => {
    const res = await post({ appId: "1", privateKeyPem: PKCS1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/clientId, clientSecret/);
  });

  it("rejects a non-numeric App ID (the slug is a common mistake)", async () => {
    const res = await post({ ...VALID, appId: "factory-console" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/numeric/);
  });

  it("rejects an unreadable private key instead of storing it", async () => {
    const res = await post({ ...VALID, privateKeyPem: "not a pem" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/private key/);
    expect(await deps.dbh.db.select().from(githubAppConfig)).toHaveLength(0);
  });

  it("is open while unconfigured but authenticated once an App exists", async () => {
    expect((await post(VALID)).statusCode).toBe(200);

    const anon = await post({ ...VALID, appId: "999" });
    expect(anon.statusCode).toBe(403);
    expect((await deps.credentials.resolve())?.appId).toBe("123456");

    const signedIn = await post({ ...VALID, appId: "999" }, { cookie: sessionCookie });
    expect(signedIn.statusCode).toBe(200);
    expect((await deps.credentials.resolve())?.appId).toBe("999");
  });

  it("reports whether webhook deliveries will be verified", async () => {
    const res = await post({ ...VALID, webhookSecret: "" });
    expect(res.json().webhookVerification).toBe(false);
  });
});

describe("editing a stored registration", () => {
  it("keeps the fields the edit leaves blank", async () => {
    expect((await post(VALID)).statusCode).toBe(200);

    const res = await post({ ...VALID, privateKeyPem: "", clientSecret: "rotated", webhookSecret: "" }, { cookie: sessionCookie });
    expect(res.statusCode).toBe(200);

    const resolved = await deps.credentials.resolve();
    expect(resolved?.clientSecret).toBe("rotated");
    expect(resolved?.privateKeyPem).toContain("BEGIN PRIVATE KEY"); // kept, not blanked
    expect(resolved?.webhookSecret).toBe("whsec"); // kept, so deliveries stay verified
  });

  it("falls back to the stored identifiers when only a secret is sent", async () => {
    await post(VALID);

    const res = await post({ clientSecret: "rotated" }, { cookie: sessionCookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ appId: "123456", slug: "factory-console" });
  });

  it("refuses to graft the stored key onto a different App", async () => {
    await post(VALID);

    const res = await post({ ...VALID, appId: "999", privateKeyPem: "" }, { cookie: sessionCookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/different App ID/);
    expect((await deps.credentials.resolve())?.appId).toBe("123456");

    const secret = await post({ ...VALID, clientId: "Iv1.other", clientSecret: "" }, { cookie: sessionCookie });
    expect(secret.statusCode).toBe(400);
    expect(secret.json().error).toMatch(/different OAuth client id/);
  });

  it("clears the slug when the field is sent empty", async () => {
    await post(VALID);
    expect((await post({ ...VALID, slug: "" }, { cookie: sessionCookie })).json().slug).toBeNull();
  });

  it("still demands the full set when the credentials come from the environment", async () => {
    // No stored row: an env-configured Console has nothing to patch, and
    // half-copying its secrets into the database would be worse than asking.
    deps.credentials = new CredentialStore({
      masterKey: MASTER_KEY,
      apiUrl: "https://api.invalid",
      load: async () => null,
      env: { appId: "9", privateKeyPem: PKCS1, webhookSecret: "w", clientId: "Iv1.env", clientSecret: "envsecret" },
    });
    app = await buildApp(deps);

    const res = await post({ clientSecret: "rotated" }, { cookie: sessionCookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/environment/);
  });

  it("stays open while nobody owns the Console yet", async () => {
    // The App's own OAuth pair is what signs people in, so gating setup on a
    // session before anyone can have one would lock the fix behind the break.
    await deps.dbh.db.delete(memberships);
    expect((await post(VALID)).statusCode).toBe(200);

    const anon = await post({ clientSecret: "rotated" });
    expect(anon.statusCode).toBe(200);
    expect((await deps.credentials.resolve())?.clientSecret).toBe("rotated");
  });

  it("tells the setup screen what is stored, without the secrets", async () => {
    await post(VALID);
    const body = (await app.inject({ method: "GET", url: "/api/setup/status" })).json();

    expect(body).toMatchObject({ configured: true, appId: "123456", clientId: "Iv1.abc", hasWebhookSecret: true });
    expect(body.canEditApp).toBe(false); // signed out, and this Console has an owner
    expect(Object.keys(body)).not.toContain("clientSecret");
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");

    const signedIn = await app.inject({ method: "GET", url: "/api/setup/status", headers: { cookie: sessionCookie } });
    expect(signedIn.json().canEditApp).toBe(true);
  });
});
