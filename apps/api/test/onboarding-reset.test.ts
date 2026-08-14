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
 * Reset opens a PR that deletes the factory footprint so setup can be run
 * again. It must not merge, must not touch secrets/labels/CLAUDE.md, and must
 * refuse when there is nothing factory-related on the default branch.
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
let calls: string[];
let routes: Array<[string, { status?: number; body: unknown }]>;

const cookie = "console_session=sess-1";
const post = () =>
  app.inject({
    method: "POST",
    url: `/api/repos/${repoId}/onboarding/reset`,
    headers: { cookie, "x-console-csrf": "1" },
  });

const reply = (match: string, body: unknown, status = 200) => routes.unshift([match, { status, body }]);

const fileBody = (sha: string, text = "x") => ({
  content: Buffer.from(text, "utf8").toString("base64"),
  sha,
  encoding: "base64",
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

  const user = (
    await deps.dbh.db
      .insert(users)
      .values({ ghUserId: 42, login: "alice", encryptedOauthToken: encryptSecret("gho_test", MASTER_KEY) })
      .returning()
  )[0]!;
  const org = (await deps.dbh.db.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  await deps.dbh.db.insert(sessions).values({ id: "sess-1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (
    await deps.dbh.db.insert(estates).values({ orgId: org.id, name: "acme", installationId: 99 }).returning()
  )[0]!;
  repoId = (
    await deps.dbh.db
      .insert(repos)
      .values({ orgId: org.id, estateId: estate.id, ghNodeId: "R_1", fullName: "acme/api", defaultBranch: "main" })
      .returning()
  )[0]!.id;

  calls = [];
  routes = [
    ["POST /app/installations/99/access_tokens", { body: { token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() } }],
    ["GET /repos/acme/api/branches/main", { body: { commit: { sha: "abc123" } } }],
    ["GET /repos/acme/api/branches/factory-console%2Freset-factory", { status: 404, body: { message: "Not Found" } }],
    ["GET /repos/acme/api/contents/.github/workflows/factory-pipeline.yml", { body: fileBody("s1", "name: Factory pipeline\n") }],
    ["GET /repos/acme/api/contents/", { status: 404, body: { message: "Not Found" } }],
    ["POST /repos/acme/api/git/refs", { body: { ref: "refs/heads/factory-console/reset-factory" } }],
    ["DELETE /repos/acme/api/contents/", { body: {} }],
    ["POST /repos/acme/api/pulls", { body: { number: 12, html_url: "https://github.com/acme/api/pull/12" } }],
  ];

  vi.stubGlobal("fetch", async (url: string | URL, init?: { method?: string }) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    const key = `${method} ${path}`;
    calls.push(key);
    const hit = routes.find(([match]) => key.includes(match));
    if (!hit) throw new Error(`unstubbed GitHub call: ${key}`);
    const [, res] = hit;
    return new Response(res.status === 204 ? null : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

const stepRow = async () => (await deps.dbh.db.select().from(onboardingRuns)).find((r) => r.step === "reset");

describe("the reset action", () => {
  it("opens a PR that deletes factory files and does not merge it", async () => {
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      prNumber: 12,
      prUrl: "https://github.com/acme/api/pull/12",
      removed: [".github/workflows/factory-pipeline.yml"],
    });

    expect(calls.some((c) => c.startsWith("POST /repos/acme/api/git/refs"))).toBe(true);
    expect(calls.some((c) => c.startsWith("DELETE /repos/acme/api/contents/.github/workflows/factory-pipeline.yml"))).toBe(true);
    expect(calls.some((c) => c.startsWith("POST /repos/acme/api/pulls"))).toBe(true);
    expect(calls.some((c) => c.includes("/merges") || c.includes("/merge"))).toBe(false);
    expect(calls.some((c) => c.includes("CLAUDE.md"))).toBe(false);
    expect(calls.some((c) => c.includes("/actions/secrets"))).toBe(false);
    expect(calls.some((c) => c.includes("/labels"))).toBe(false);

    const step = await stepRow();
    expect(step).toMatchObject({ step: "reset", status: "ok" });
    expect(step!.detail).toMatchObject({ prNumber: 12, prUrl: "https://github.com/acme/api/pull/12" });
  });

  it("refuses when the default branch has no factory files, and creates no branch", async () => {
    reply("GET /repos/acme/api/contents/.github/workflows/factory-pipeline.yml", { message: "Not Found" }, 404);

    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/nothing to reset/);
    expect(calls.some((c) => c.startsWith("POST /repos/acme/api/git/refs"))).toBe(false);
    expect(calls.some((c) => c.startsWith("DELETE "))).toBe(false);
    expect(calls.some((c) => c.startsWith("POST /repos/acme/api/pulls"))).toBe(false);
  });

  it("walks openspec/ and still leaves CLAUDE.md alone", async () => {
    reply("GET /repos/acme/api/contents/openspec/config.yaml", fileBody("o1", "schema: spec-driven\n"));
    reply("GET /repos/acme/api/contents/openspec?", [
      { path: "openspec/config.yaml", type: "file", sha: "o1" },
    ]);

    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toEqual([".github/workflows/factory-pipeline.yml", "openspec/config.yaml"]);
    expect(calls.some((c) => c.startsWith("DELETE /repos/acme/api/contents/openspec/config.yaml"))).toBe(true);
    expect(calls.some((c) => c.includes("CLAUDE.md"))).toBe(false);
  });

  it("reuses an existing reset PR instead of opening a second", async () => {
    reply("GET /repos/acme/api/pulls?", [
      {
        number: 9,
        html_url: "https://github.com/acme/api/pull/9",
        state: "open",
        head: { ref: "factory-console/reset-factory" },
      },
    ]);
    reply("POST /repos/acme/api/pulls", { message: "Validation Failed" }, 422);
    reply("GET /repos/acme/api/branches/factory-console%2Freset-factory", { commit: { sha: "def456" } });

    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, prNumber: 9, prUrl: "https://github.com/acme/api/pull/9" });
    expect(calls.some((c) => c.startsWith("POST /repos/acme/api/git/refs"))).toBe(false);
  });
});
