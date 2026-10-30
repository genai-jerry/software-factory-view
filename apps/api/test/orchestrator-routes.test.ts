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
