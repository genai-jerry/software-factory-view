import { randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, issueStateHistory, issues, memberships, orgs, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { lineFor } from "../src/activity.js";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * Activity (redesign board 3b) and Add work (board 3).
 *
 * Pinned: a state move becomes one line that names who did it and what
 * happened to the item, in the reader's words; the feed is one line per
 * move, newest first, with the epic to open; and Add work opens the issue as
 * the acting user with the intake label, plus expedite on the fast lane.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const cookie = "console_session=sess-1";
const headers = { cookie, "x-console-csrf": "1", "content-type": "application/json" };
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
  const cfg = loadConfig({ CONSOLE_MASTER_KEY: MASTER_KEY, GITHUB_APP_WEBHOOK_SECRET: "s", NODE_ENV: "test", GITHUB_API_URL: "https://gh.invalid" } as never);
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
  const jerry = (await d.insert(users).values({ ghUserId: 1, login: "jerry", encryptedOauthToken: encryptSecret("t", MASTER_KEY) }).returning())[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await d.insert(memberships).values({ orgId: org.id, userId: jerry.id, role: "owner" });
  await d.insert(sessions).values({ id: "sess-1", userId: jerry.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const repo = (await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/app" }).returning())[0]!;
  id.repo = repo.id;
  const epic = (
    await d
      .insert(issues)
      .values({ orgId: org.id, repoId: repo.id, ghNodeId: "I1", number: 35, title: "Day-wise calling performance", state: "open", kind: "epic", factoryState: "factory:design-approved", ghUpdatedAt: new Date() })
      .returning()
  )[0]!;
  id.epic = epic.id;
  const task = (
    await d
      .insert(issues)
      .values({ orgId: org.id, repoId: repo.id, ghNodeId: "I2", number: 62, title: "task(35): compute counts", state: "open", kind: "task", parentIssueId: epic.id, factoryState: "factory:on-epic", ghUpdatedAt: new Date() })
      .returning()
  )[0]!;
  await d.insert(issueStateHistory).values([
    { orgId: org.id, issueId: epic.id, fromState: "factory:spec-ready", toState: "factory:spec-approved", actor: "jerry", occurredAt: new Date("2026-10-30T09:00:00Z") },
    { orgId: org.id, issueId: task.id, fromState: "factory:in-test", toState: "factory:on-epic", actor: "acme-console[bot]", occurredAt: new Date("2026-10-31T02:10:00Z") },
    { orgId: org.id, issueId: epic.id, fromState: null, toState: "factory:intake", actor: "jerry", occurredAt: new Date("2026-10-29T14:02:00Z") },
  ]);
});

afterEach(() => vi.unstubAllGlobals());

describe("lineFor", () => {
  it("says who did what to the item in the reader's words", () => {
    const base = { fromState: null, kind: "epic", number: 35, title: "Day-wise", epicTitle: null, epicNumber: null };
    expect(lineFor({ ...base, toState: "factory:spec-approved", actor: "jerry" })).toEqual({ who: "jerry", person: true, text: "jerry approved the plan for Day-wise.", stage: "clarify" });
    expect(lineFor({ ...base, toState: "factory:spec-ready", actor: "acme-console[bot]" })!.text).toBe("The factory finished the plan for Day-wise. Waiting for approval.");
    expect(lineFor({ ...base, kind: "task", number: 62, title: "task(35): compute counts", epicTitle: "Day-wise", epicNumber: 35, toState: "factory:blocked", actor: null })!.text).toBe(
      "The factory stopped on task #62 of Day-wise and asked a question.",
    );
    expect(lineFor({ ...base, kind: "test", number: 68, title: "test(35): ST-3 A status follows through", epicTitle: "Day-wise", epicNumber: 35, toState: "factory:test-failed", actor: "sowmya" })!.text).toBe(
      "sowmya ran test ST-3 of Day-wise: failed. The fix is being built.",
    );
    // A task becoming ready is the dispatcher's housekeeping on an epic; said for the task, not the epic.
    expect(lineFor({ ...base, toState: "factory:ready", actor: null })).toBeNull();
    // A case with no parent link names what it checks instead of its raw title.
    expect(lineFor({ ...base, kind: "test", number: 55, title: "test(34): ST-12 A status moved by a human is read back", toState: "factory:manual-test", actor: null })!.text).toBe(
      "Test ST-12 is ready to run: A status moved by a human is read back.",
    );
  });
});

describe("GET /api/activity", () => {
  it("lists one line per move, newest first, each pointing at its epic", async () => {
    const res = await app.inject({ method: "GET", url: "/api/activity", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { lines } = res.json() as { lines: Array<{ text: string; who: string; epicId: string; stage: string }> };
    expect(lines.map((l) => l.text)).toEqual([
      "The factory built task #62 of Day-wise calling performance.",
      "jerry approved the plan for Day-wise calling performance.",
      "jerry added Day-wise calling performance.",
    ]);
    expect(lines.every((l) => l.epicId === id.epic)).toBe(true);
    expect(lines[0]!.who).toBe("The factory");
  });
});

describe("POST /api/work", () => {
  it("opens the issue as the user with the intake label, and expedite on the fast lane", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({ number: 98, html_url: "https://github.com/acme/app/issues/98", node_id: "I98", title: "x", state: "open", labels: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/work",
      headers,
      payload: { repoId: id.repo, title: "Show day-wise calling performance", body: "Setters add it up by hand.", fast: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, number: 98, repo: "acme/app" });
    const create = calls.find((c) => c.url.endsWith("/repos/acme/app/issues"))!;
    expect(create.body).toEqual({ title: "Show day-wise calling performance", body: "Setters add it up by hand.", labels: ["factory:intake", "factory:expedite"] });
  });

  it("refuses an empty title before touching GitHub", async () => {
    const res = await app.inject({ method: "POST", url: "/api/work", headers, payload: { repoId: id.repo, title: "  " } });
    expect(res.statusCode).toBe(400);
  });
});
