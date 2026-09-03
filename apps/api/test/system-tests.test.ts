import { randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, issues, memberships, orgs, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * System test cases in the epic payload (FACTORY.md §4b).
 *
 * A case is a child of the epic exactly as a task is, so the load-bearing
 * fact here is the split: cases must never land in the code-task counts. Get
 * that wrong and an epic with five cases reads as five extra tasks, and a
 * passed case — which the router closes — reads as a task done.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const cookie = "console_session=sess-1";
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
  const alice = (
    await d.insert(users).values({ ghUserId: 1, login: "alice", encryptedOauthToken: encryptSecret("t", MASTER_KEY) }).returning()
  )[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await d.insert(memberships).values({ orgId: org.id, userId: alice.id, role: "owner" });
  await d.insert(sessions).values({ id: "sess-1", userId: alice.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const repo = (
    await d
      .insert(repos)
      .values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/app", systemTests: true, testMode: "gate" })
      .returning()
  )[0]!;
  // The same estate with system tests explicitly off — the shape the Plan
  // tests action must never appear in.
  const offRepo = (
    await d
      .insert(repos)
      .values({ orgId: org.id, estateId: estate.id, ghNodeId: "R2", fullName: "acme/off", systemTests: false })
      .returning()
  )[0]!;

  let n = 0;
  const mk = async (over: Partial<typeof issues.$inferInsert> & { title: string }) =>
    (
      await d
        .insert(issues)
        .values({
          orgId: org.id,
          repoId: repo.id,
          ghNodeId: `I${++n}`,
          number: n,
          state: "open",
          kind: "task",
          ghUpdatedAt: new Date("2026-09-01T00:00:00Z"),
          ghCreatedAt: new Date("2026-09-01T00:00:00Z"),
          htmlUrl: `https://gh/${n}`,
          ...over,
        })
        .returning()
    )[0]!;

  // An epic whose code is finished and whose cases are not: two tasks on the
  // epic branch, three cases — one passed and closed, one runnable, one failed.
  const epic = await mk({ title: "epic", kind: "epic", factoryState: "factory:design-approved" });
  await mk({ title: "task(1): schema", factoryState: "factory:on-epic", parentIssueId: epic.id });
  await mk({ title: "task(1): backend", factoryState: "factory:on-epic", parentIssueId: epic.id });
  await mk({ title: "test(1): ST-1 signs up", kind: "test", factoryState: "factory:test-passed",
             state: "closed", parentIssueId: epic.id });
  const runnable = await mk({ title: "test(1): ST-2 renews", kind: "test",
                              factoryState: "factory:manual-test", parentIssueId: epic.id });
  await mk({ title: "test(1): ST-3 refunds", kind: "test", factoryState: "factory:test-failed",
             parentIssueId: epic.id });
  id.epic = epic.id;
  id.runnable = runnable.id;

  // A second epic with no cases at all — the shape every repo that has not
  // enabled system tests has, and which must read exactly as it always did.
  const plain = await mk({ title: "plain epic", kind: "epic", factoryState: "factory:design-approved" });
  await mk({ title: "task(7): only", factoryState: "factory:on-epic", parentIssueId: plain.id });
  id.plain = plain.id;

  // An in-flight epic with no plan at all: the one the adoption action exists
  // for. Same repo, so the policy is on.
  const adoptable = await mk({ title: "adoptable epic", kind: "epic", factoryState: "factory:design-approved" });
  await mk({ title: "task(8): only", factoryState: "factory:ready", parentIssueId: adoptable.id });
  id.adoptable = adoptable.id;

  // Too early for a plan — no task breakdown to derive `Depends on:` from.
  id.early = (await mk({ title: "early epic", kind: "epic", factoryState: "factory:spec-approved" })).id;

  // An epic in a repo whose policy says no.
  id.off = (await mk({ title: "off epic", kind: "epic", factoryState: "factory:design-approved", repoId: offRepo.id })).id;
});

const get = async (epicId: string) =>
  (await app.inject({ method: "GET", url: `/api/epics/${epicId}`, headers: { cookie } })).json();

describe("an epic's cases are counted apart from its tasks", () => {
  it("keeps cases out of the code-task rollup", async () => {
    const { rollup } = await get(id.epic!);
    // Two tasks, not five: the three cases are children too, and counting
    // them here is exactly the drift this split exists to prevent.
    expect(rollup.total).toBe(2);
    expect(rollup.shipping).toBe(2);
    // The closed, passed case must not read as a task done.
    expect(rollup.done).toBe(0);
  });

  it("rolls the cases up on their own", async () => {
    const { rollup } = await get(id.epic!);
    expect(rollup.tests).toEqual({ total: 3, passed: 1, runnable: 1, failed: 1, outstanding: 2 });
  });

  it("says what the assembled epic is waiting on", async () => {
    const { epic } = await get(id.epic!);
    expect(epic.status).toBe("Assembled · waiting on 2 tests");
  });

  it("leaves an epic with no cases reading exactly as before", async () => {
    const { rollup, epic } = await get(id.plain!);
    expect(rollup.tests).toBeUndefined();
    expect(rollup.total).toBe(1);
    expect(epic.status).toBe("Shipping 0/1");
  });
});

describe("POST /api/issues/:id/test-verdict", () => {
  const post = (issueId: string, body: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/test-verdict`,
      headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: body,
    });

  it("rejects a verdict that is neither passed nor failed", async () => {
    expect((await post(id.runnable!, { verdict: "maybe" })).statusCode).toBe(400);
  });

  it("409s on a case that is not runnable", async () => {
    const { tasks } = await get(id.epic!);
    const failed = tasks.find((t: { title: string }) => t.title.includes("ST-3"));
    expect((await post(failed.id, { verdict: "passed" })).statusCode).toBe(409);
  });

  it("409s on an issue that is not a case at all", async () => {
    expect((await post(id.epic!, { verdict: "passed" })).statusCode).toBe(409);
  });
});

describe("the epic's system-test standing", () => {
  it("offers Plan tests on an in-flight epic with no plan", async () => {
    const { systemTests } = await get(id.adoptable!);
    expect(systemTests.enabled).toBe(true);
    expect(systemTests.mode).toBe("gate");
    expect(systemTests.planned).toBe(false);
    expect(systemTests.planTests).toEqual({ offered: true, reason: null });
  });

  it("does not offer it on an epic that already has cases", async () => {
    const { systemTests } = await get(id.epic!);
    expect(systemTests.planned).toBe(true);
    expect(systemTests.planTests.offered).toBe(false);
  });

  it("does not offer it before the Planner has run", async () => {
    const { systemTests } = await get(id.early!);
    expect(systemTests.planTests.offered).toBe(false);
    expect(systemTests.planTests.reason).toMatch(/Planner/);
  });

  it("does not offer it where the repo runs no system tests", async () => {
    const { systemTests } = await get(id.off!);
    expect(systemTests.enabled).toBe(false);
    expect(systemTests.planTests.offered).toBe(false);
  });
});

describe("POST /api/epics/:id/plan-tests", () => {
  const post = (epicId: string) =>
    app.inject({
      method: "POST",
      url: `/api/epics/${epicId}/plan-tests`,
      headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: {},
    });

  it("409s where the repo runs no system tests", async () => {
    const res = await post(id.off!);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/factory-testing\.json/);
  });

  it("409s before the Planner has run", async () => {
    const res = await post(id.early!);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Planner/);
  });

  it("409s on an epic that already has a plan", async () => {
    expect((await post(id.epic!)).statusCode).toBe(409);
  });

  it("409s on a sub-issue rather than commenting on it", async () => {
    // The endpoint takes an epic id; a case is not one, and the guard — not
    // the route shape — is what has to say so.
    expect((await post(id.runnable!)).statusCode).toBe(409);
  });

  it("404s on an epic in another org", async () => {
    expect((await post("00000000-0000-0000-0000-000000000000")).statusCode).toBe(404);
  });
});
