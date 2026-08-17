import { generateKeyPairSync, randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, memberships, orgs, repos, sessions, users, onboardingRuns } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * Reset deletes the factory footprint straight from the default branch, clears
 * the recorded setup steps, and prunes stale factory-console/* branches so a
 * later enablement run does not 422 on "No commits between …". Branch
 * protection demotes it to a PR a human merges. It must never touch
 * secrets/labels/CLAUDE.md.
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
let orgId: string;
let estateId: string;
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

/** Recorded step rows a reset is expected to wipe. */
const seedSteps = () =>
  deps.dbh.db.insert(onboardingRuns).values([
    { orgId, estateId, repoId, step: "labels", status: "ok", detail: { found: 14 }, updatedAt: new Date() },
    { orgId, estateId, repoId, step: "validate", status: "ok", detail: { checks: [] }, updatedAt: new Date() },
  ]);

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
  orgId = org.id;
  await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  await deps.dbh.db.insert(sessions).values({ id: "sess-1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (
    await deps.dbh.db.insert(estates).values({ orgId: org.id, name: "acme", installationId: 99 }).returning()
  )[0]!;
  estateId = estate.id;
  repoId = (
    await deps.dbh.db
      .insert(repos)
      .values({
        orgId: org.id,
        estateId: estate.id,
        ghNodeId: "R_1",
        fullName: "acme/api",
        defaultBranch: "main",
        factoryEnabled: true,
        profileSha: "p1",
      })
      .returning()
  )[0]!.id;

  calls = [];
  routes = [
    ["POST /app/installations/99/access_tokens", { body: { token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() } }],
    ["GET /repos/acme/api/branches/main", { body: { commit: { sha: "abc123" } } }],
    ["GET /repos/acme/api/branches/factory-console%2Freset-factory", { status: 404, body: { message: "Not Found" } }],
    ["GET /repos/acme/api/contents/.github/workflows/factory-pipeline.yml", { body: fileBody("s1", "name: Factory pipeline\n") }],
    ["GET /repos/acme/api/contents/", { status: 404, body: { message: "Not Found" } }],
    ["DELETE /repos/acme/api/contents/", { body: {} }],
    ["DELETE /repos/acme/api/git/refs/heads/", { status: 204, body: null }],
    ["POST /repos/acme/api/git/refs", { body: { ref: "refs/heads/factory-console/reset-factory" } }],
    ["POST /repos/acme/api/pulls", { body: { number: 12, html_url: "https://github.com/acme/api/pull/12" } }],
  ];

  vi.stubGlobal("fetch", async (url: string | URL, init?: { method?: string; body?: string }) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    // Contents-API writes carry the target branch in the body, not the URL —
    // surface it in the call key so tests can tell direct deletes from
    // fallback-branch deletes.
    let branch = "";
    try {
      const parsed = init?.body ? (JSON.parse(init.body) as { branch?: string }) : null;
      if (parsed?.branch) branch = ` branch=${parsed.branch}`;
    } catch {
      /* not JSON */
    }
    const key = `${method} ${path}${branch}`;
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

const stepRows = async () => await deps.dbh.db.select().from(onboardingRuns);
const repoRow = async () => (await deps.dbh.db.select().from(repos).where(eq(repos.id, repoId)))[0]!;

describe("the reset action", () => {
  it("deletes factory files from the default branch, clears steps, and marks the repo clean", async () => {
    await seedSteps();

    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      mode: "direct",
      removed: [".github/workflows/factory-pipeline.yml"],
      defaultBranch: "main",
    });

    expect(calls.some((c) => c.startsWith("DELETE /repos/acme/api/contents/.github/workflows/factory-pipeline.yml") && c.endsWith("branch=main"))).toBe(true);
    expect(calls.some((c) => c.startsWith("POST /repos/acme/api/pulls"))).toBe(false);
    expect(calls.some((c) => c.startsWith("POST /repos/acme/api/git/refs"))).toBe(false);
    expect(calls.some((c) => c.includes("/merges") || c.includes("/merge"))).toBe(false);
    expect(calls.some((c) => c.includes("CLAUDE.md"))).toBe(false);
    expect(calls.some((c) => c.includes("/actions/secrets"))).toBe(false);
    expect(calls.some((c) => c.includes("/labels"))).toBe(false);

    // Stale working branches are pruned so the next enablement PR can be created.
    expect(calls.some((c) => c.startsWith("DELETE /repos/acme/api/git/refs/heads/factory-console/enable-factory"))).toBe(true);
    expect(calls.some((c) => c.startsWith("DELETE /repos/acme/api/git/refs/heads/factory-console/reset-factory"))).toBe(true);

    // Console-side state reads as clean: only the reset row remains, factory off.
    const rows = await stepRows();
    expect(rows.map((r) => r.step)).toEqual(["reset"]);
    expect(rows[0]).toMatchObject({ step: "reset", status: "ok" });
    expect(rows[0]!.detail).toMatchObject({ mode: "direct", removed: [".github/workflows/factory-pipeline.yml"] });
    expect(await repoRow()).toMatchObject({ factoryEnabled: false, profileSha: null });
  });

  it("falls back to a PR when branch protection refuses the direct delete, and keeps step history", async () => {
    await seedSteps();
    reply(
      "DELETE /repos/acme/api/contents/.github/workflows/factory-pipeline.yml branch=main",
      { message: "Changes must be made through a pull request." },
      409,
    );

    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      mode: "pr",
      prNumber: 12,
      prUrl: "https://github.com/acme/api/pull/12",
      removed: [".github/workflows/factory-pipeline.yml"],
    });

    expect(calls.some((c) => c.startsWith("POST /repos/acme/api/git/refs"))).toBe(true);
    expect(calls.some((c) => c.startsWith("DELETE /repos/acme/api/contents/.github/workflows/factory-pipeline.yml") && c.endsWith("branch=factory-console/reset-factory"))).toBe(true);
    expect(calls.some((c) => c.startsWith("POST /repos/acme/api/pulls"))).toBe(true);
    // Not clean until the PR merges: steps stay, factory flag stays, branches stay.
    expect(calls.some((c) => c.startsWith("DELETE /repos/acme/api/git/refs/heads/"))).toBe(false);
    const rows = await stepRows();
    expect(rows.map((r) => r.step).sort()).toEqual(["labels", "reset", "validate"]);
    expect(rows.find((r) => r.step === "reset")).toMatchObject({ status: "pending" });
    expect(await repoRow()).toMatchObject({ factoryEnabled: true });
  });

  it("treats a repo with no factory files as already clean and clears the recorded steps", async () => {
    await seedSteps();
    reply("GET /repos/acme/api/contents/.github/workflows/factory-pipeline.yml", { message: "Not Found" }, 404);

    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, mode: "clean", removed: [], defaultBranch: "main" });
    expect(calls.some((c) => c.startsWith("DELETE /repos/acme/api/contents/"))).toBe(false);
    expect(calls.some((c) => c.startsWith("POST /repos/acme/api/pulls"))).toBe(false);
    expect(calls.some((c) => c.startsWith("DELETE /repos/acme/api/git/refs/heads/factory-console/enable-factory"))).toBe(true);

    const rows = await stepRows();
    expect(rows.map((r) => r.step)).toEqual(["reset"]);
    expect(rows[0]!.detail).toMatchObject({ mode: "clean", removed: [] });
    expect(await repoRow()).toMatchObject({ factoryEnabled: false, profileSha: null });
  });

  it("walks openspec/ and still leaves CLAUDE.md alone", async () => {
    reply("GET /repos/acme/api/contents/openspec?", [
      { path: "openspec/config.yaml", type: "file", sha: "o1" },
    ]);

    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toEqual([".github/workflows/factory-pipeline.yml", "openspec/config.yaml"]);
    expect(calls.some((c) => c.startsWith("DELETE /repos/acme/api/contents/openspec/config.yaml") && c.endsWith("branch=main"))).toBe(true);
    expect(calls.some((c) => c.includes("CLAUDE.md"))).toBe(false);
  });

  it("promotes a member who administers the repo on GitHub, then resets", async () => {
    const bob = (
      await deps.dbh.db
        .insert(users)
        .values({ ghUserId: 43, login: "bob", encryptedOauthToken: encryptSecret("gho_bob", MASTER_KEY) })
        .returning()
    )[0]!;
    await deps.dbh.db.insert(memberships).values({ orgId, userId: bob.id, role: "member" });
    await deps.dbh.db.insert(sessions).values({ id: "sess-2", userId: bob.id, expiresAt: new Date(Date.now() + 3600_000) });
    // Appended (not unshifted): the bare repo GET must not shadow the more
    // specific /repos/acme/api/* routes above it.
    routes.push(["GET /repos/acme/api", { body: { permissions: { admin: true, push: true, pull: true } } }]);

    const res = await app.inject({
      method: "POST",
      url: `/api/repos/${repoId}/onboarding/reset`,
      headers: { cookie: "console_session=sess-2", "x-console-csrf": "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, mode: "direct" });

    const healed = await deps.dbh.db.select().from(memberships).where(eq(memberships.userId, bob.id));
    expect(healed[0]).toMatchObject({ role: "admin" });
  });

  it("still refuses a member whose GitHub identity does not administer the repo", async () => {
    const eve = (
      await deps.dbh.db
        .insert(users)
        .values({ ghUserId: 44, login: "eve", encryptedOauthToken: encryptSecret("gho_eve", MASTER_KEY) })
        .returning()
    )[0]!;
    await deps.dbh.db.insert(memberships).values({ orgId, userId: eve.id, role: "member" });
    await deps.dbh.db.insert(sessions).values({ id: "sess-3", userId: eve.id, expiresAt: new Date(Date.now() + 3600_000) });
    routes.push(["GET /repos/acme/api", { body: { permissions: { admin: false, push: true, pull: true } } }]);

    const res = await app.inject({
      method: "POST",
      url: `/api/repos/${repoId}/onboarding/reset`,
      headers: { cookie: "console_session=sess-3", "x-console-csrf": "1" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("admin or owner role");

    const unchanged = await deps.dbh.db.select().from(memberships).where(eq(memberships.userId, eve.id));
    expect(unchanged[0]).toMatchObject({ role: "member" });
    // Refusal must leave the repo untouched: nothing was deleted or branched.
    expect(calls.every((c) => c.startsWith("GET ") || c.startsWith("POST /app/installations"))).toBe(true);
  });

  it("reuses an existing reset PR instead of opening a second when falling back", async () => {
    reply(
      "DELETE /repos/acme/api/contents/.github/workflows/factory-pipeline.yml branch=main",
      { message: "Changes must be made through a pull request." },
      409,
    );
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
    expect(res.json()).toMatchObject({ ok: true, mode: "pr", prNumber: 9, prUrl: "https://github.com/acme/api/pull/9" });
    expect(calls.some((c) => c.startsWith("POST /repos/acme/api/git/refs"))).toBe(false);
  });
});
