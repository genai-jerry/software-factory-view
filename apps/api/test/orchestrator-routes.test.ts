import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { memberships, orgs, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const cookie = "console_session=sess-1";

let app: Awaited<ReturnType<typeof buildApp>>;

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
  const deps: AppDeps = {
    cfg,
    dbh: { db: db as never, sql: null as never, close: async () => undefined },
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
  const user = (
    await deps.dbh.db
      .insert(users)
      .values({ ghUserId: 1, login: "alice", encryptedOauthToken: encryptSecret("t", MASTER_KEY) })
      .returning()
  )[0]!;
  const org = (await deps.dbh.db.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  await deps.dbh.db.insert(sessions).values({ id: "sess-1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });
  app = await buildApp(deps);
});

afterEach(() => vi.unstubAllGlobals());

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
            outcome: "error",
            error: "No model in the preference chain",
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
    expect(res.json()).toMatchObject({ role: "profiler", outcome: "error" });
  });
});
