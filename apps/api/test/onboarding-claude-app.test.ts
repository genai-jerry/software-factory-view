import { generateKeyPairSync, randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, memberships, orgs, repos, sessions, users, onboardingRuns } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * The Claude GitHub App step. GitHub shows an App's installations to nobody
 * but that App's owner, and the Claude App is Anthropic's — so the Console
 * cannot probe it. The step records a human's confirmation instead, and these
 * tests pin that it records exactly that and talks to GitHub not at all.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const PKCS8 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
let repoId: string;

const post = (cookie = "console_session=sess-1") =>
  app.inject({
    method: "POST",
    url: `/api/repos/${repoId}/onboarding/claude-app`,
    // No content-type: this route takes no body, and Fastify rejects an
    // empty one when the header claims JSON.
    headers: { cookie, "x-console-csrf": "1" },
  });

beforeEach(async () => {
  const pg = new PGlite();
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
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
      load: async () => null,
      env: { appId: "1", privateKeyPem: PKCS8, webhookSecret: "w", clientId: "Iv1.x", clientSecret: "s" },
    }),
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  app = await buildApp(deps);

  const owner = (
    await deps.dbh.db
      .insert(users)
      .values({ ghUserId: 42, login: "alice", encryptedOauthToken: encryptSecret("gho_test", MASTER_KEY) })
      .returning()
  )[0]!;
  const viewer = (
    await deps.dbh.db
      .insert(users)
      .values({ ghUserId: 43, login: "bob", encryptedOauthToken: encryptSecret("gho_test2", MASTER_KEY) })
      .returning()
  )[0]!;
  const org = (await deps.dbh.db.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: owner.id, role: "owner" });
  await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: viewer.id, role: "viewer" });
  await deps.dbh.db.insert(sessions).values({ id: "sess-1", userId: owner.id, expiresAt: new Date(Date.now() + 3600_000) });
  await deps.dbh.db.insert(sessions).values({ id: "sess-2", userId: viewer.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (
    await deps.dbh.db.insert(estates).values({ orgId: org.id, name: "acme", installationId: 99 }).returning()
  )[0]!;
  repoId = (
    await deps.dbh.db
      .insert(repos)
      .values({ orgId: org.id, estateId: estate.id, ghNodeId: "R_1", fullName: "acme/api", defaultBranch: "main" })
      .returning()
  )[0]!.id;

  // Nothing about this step may reach GitHub — there is no API that could
  // answer. A fetch here is a bug, not a missing stub.
  vi.stubGlobal("fetch", async (url: string | URL) => {
    throw new Error(`the claude-app step must not call GitHub, but fetched ${String(url)}`);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("the Claude GitHub App step", () => {
  it("records the signed-in user's confirmation, without touching GitHub", async () => {
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, confirmedBy: "alice" });

    const step = (await deps.dbh.db.select().from(onboardingRuns))[0];
    expect(step).toMatchObject({ step: "claude-app", status: "ok" });
    expect(step!.detail).toMatchObject({ confirmedBy: "alice", appUrl: "https://github.com/apps/claude" });
  });

  it("re-confirming overwrites in place rather than duplicating", async () => {
    await post();
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(await deps.dbh.db.select().from(onboardingRuns)).toHaveLength(1);
  });

  it("refuses a viewer — onboarding needs an admin or owner", async () => {
    const res = await post("console_session=sess-2");
    expect(res.statusCode).toBe(403);
    expect(await deps.dbh.db.select().from(onboardingRuns)).toHaveLength(0);
  });
});
