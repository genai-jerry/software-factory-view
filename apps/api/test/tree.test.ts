import { randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, gateAssignments, issues, memberships, orgs, repos, sessions, taskDependencies, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * The epic dependency tree (plan 11 §1): cross-repo nodes and edges, the
 * waiting/approvable flags, and the start-gate guard rails on
 * POST /api/issues/:id/approve.
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
    await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/app" }).returning()
  )[0]!;
  const sibling = (
    await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R2", fullName: "acme/api" }).returning()
  )[0]!;
  id.estate = estate.id;
  id.org = org.id;

  const mkIssue = async (repoId: string, over: Partial<typeof issues.$inferInsert> & { number: number; title: string }) =>
    (
      await d
        .insert(issues)
        .values({
          orgId: org.id,
          repoId,
          ghNodeId: `I${repoId === repo.id ? "a" : "b"}${over.number}`,
          state: "open",
          kind: "task",
          ghUpdatedAt: new Date("2026-08-10T00:00:00Z"),
          ghCreatedAt: new Date("2026-08-01T00:00:00Z"),
          htmlUrl: `https://gh/${over.number}`,
          ...over,
        })
        .returning()
    )[0]!;

  const epic = await mkIssue(repo.id, { number: 1, title: "epic", kind: "epic", factoryState: "factory:design-approved" });
  const t2 = await mkIssue(repo.id, {
    number: 2,
    title: "task(1): schema",
    factoryState: "factory:ready",
    parentIssueId: epic.id,
  });
  const t3 = await mkIssue(repo.id, { number: 3, title: "task(1): backend", parentIssueId: epic.id });
  // Cross-repo sub-issue, blocked by #3 in the epic's repo.
  const t4 = await mkIssue(sibling.id, { number: 4, title: "task(1): consumer", parentIssueId: epic.id });
  await d.insert(taskDependencies).values([
    { orgId: org.id, blockedIssueId: t3.id, blockerIssueId: t2.id, source: "github" },
    { orgId: org.id, blockedIssueId: t4.id, blockerIssueId: t3.id, source: "body" },
  ]);
  id.epic = epic.id;
  id.ready = t2.id;
  id.blocked = t3.id;
  id.cross = t4.id;

  // A second epic, mid-build: nothing closed, an agent on every task. The
  // badge derived from its rollup is what this fixture exists for.
  const building = await mkIssue(repo.id, {
    number: 10,
    title: "epic mid-build",
    kind: "epic",
    factoryState: "factory:design-approved",
  });
  await mkIssue(repo.id, { number: 11, title: "task(10): a", factoryState: "factory:in-review", parentIssueId: building.id });
  await mkIssue(repo.id, { number: 12, title: "task(10): b", factoryState: "factory:in-test", parentIssueId: building.id });
  await mkIssue(repo.id, { number: 13, title: "task(10): c", factoryState: "factory:on-epic", parentIssueId: building.id });
  await mkIssue(repo.id, { number: 14, title: "task(10): d", factoryState: "factory:ready", parentIssueId: building.id });
  id.building = building.id;
});

describe("GET /api/epics/:id/tree", () => {
  it("returns nodes with cross-repo flags, edges both ways, and action capability", async () => {
    const res = await app.inject({ method: "GET", url: `/api/epics/${id.epic}/tree`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.epic).toMatchObject({ number: 1, repo: "acme/app", gate: null });
    expect(body.startGate).toMatchObject({ amApprover: true, approvers: [] });

    const byNumber = Object.fromEntries((body.nodes as Array<{ number: number }>).map((n) => [n.number, n]));
    expect(byNumber[2]).toMatchObject({ approvable: true, waiting: false, crossRepo: false });
    expect(byNumber[2]).toMatchObject({ blocks: [{ number: 3 }] });
    expect(byNumber[3]).toMatchObject({ approvable: false, waiting: true, blockedBy: [{ number: 2, inTree: true }] });
    expect(byNumber[4]).toMatchObject({
      crossRepo: true,
      repo: "acme/api",
      waiting: true,
      blockedBy: [{ number: 3, repo: "acme/app" }],
    });
  });
});

/**
 * The Tree is not the only tab that shows a ready task — the Tasks list and
 * the task's thread show it too, and each renders the same Approve button.
 * They read it off the workspace payload, so it has to carry the same two
 * facts the tree does: which tasks are approvable, and whether I may approve.
 */
describe("GET /api/epics/:id carries the same start gate as the tree", () => {
  it("flags approvable tasks and names the start-gate approvers", async () => {
    const res = await app.inject({ method: "GET", url: `/api/epics/${id.epic}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.startGate).toMatchObject({ amApprover: true, approvers: [] });
    const byNumber = Object.fromEntries((body.tasks as Array<{ number: number }>).map((t) => [t.number, t]));
    expect(byNumber[2]).toMatchObject({ approvable: true });
    expect(byNumber[3]).toMatchObject({ approvable: false });
  });
});

/**
 * `factory:design-approved` sits on the epic for the whole build and a task
 * closes only at the very end of the line, so the done count on its own reads
 * "0/4" — nothing has happened — for an epic with an agent on every task. The
 * rollup knows better and both payloads that carry a status say so.
 */
describe("the epic status counts the tasks agents are on", () => {
  it("reports the in-flight tasks the done count cannot see", async () => {
    for (const url of [`/api/epics/${id.building}`, `/api/epics/${id.building}/tree`]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json().epic.status).toBe("Building 0/4 · 3 in flight");
      expect(res.json().epic.nextStep.how).toMatch(/0 of 4 tasks done, 3 in flight/);
    }
  });

  it("ships the count on the rollup so the board reads it without re-deriving it", async () => {
    const res = await app.inject({ method: "GET", url: `/api/epics/${id.building}/tree`, headers: { cookie } });
    expect(res.json().epic.rollup).toMatchObject({ total: 4, done: 0, ready: 1, inReview: 1, inTest: 1, shipping: 1, inFlight: 3 });
  });
});

describe("POST /api/issues/:id/approve", () => {
  const post = (issueId: string) =>
    app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/approve`,
      headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: {},
    });

  it("409s on a task that is not at factory:ready", async () => {
    const res = await post(id.blocked);
    expect(res.statusCode).toBe(409);
  });

  it("403s when the implementation gate names someone else", async () => {
    await deps.dbh.db
      .insert(gateAssignments)
      .values({ estateId: id.estate!, repoId: null, gate: "implementation", login: "sam" });
    const res = await post(id.ready);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("sam");

    // …and the workspace payload says so up front, so the button in every tab
    // is disabled with the same reason rather than failing on the click.
    const ws = await app.inject({ method: "GET", url: `/api/epics/${id.epic}`, headers: { cookie } });
    expect(ws.json().startGate).toMatchObject({ amApprover: false, approvers: ["sam"] });
  });
});
