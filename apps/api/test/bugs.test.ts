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
 * Bug reports in the epic payload (FACTORY.md §4c).
 *
 * A report is a third kind of child, and the load-bearing facts are the two
 * splits it needs: a report must never land in the code-task counts (the task
 * that FIXES it is the code, and counting both double-counts the work), and it
 * must never land among the cases (nobody planned it, and a case list that
 * grows a row a tester wrote is not a plan any more).
 *
 * Then the ladder: the factory refuses `Bug` in five shapes, and the Console
 * has to refuse it in the same five before the click rather than after.
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
      .values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/app", systemTests: true, bugReports: true, testMode: "gate" })
      .returning()
  )[0]!;
  // The same estate with the policy explicitly off — the shape the Report a
  // bug action must never appear in.
  const offRepo = (
    await d
      .insert(repos)
      .values({ orgId: org.id, estateId: estate.id, ghNodeId: "R2", fullName: "acme/off", systemTests: false, bugReports: false })
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

  // An epic under test: two tasks assembled, one case, and three bugs — one
  // being fixed, one waiting for its re-test, one verified and closed.
  const epic = await mk({ title: "epic", kind: "epic", factoryState: "factory:design-approved" });
  await mk({ title: "task(1): schema", factoryState: "factory:on-epic", parentIssueId: epic.id });
  await mk({ title: "task(1): fix bug #4", factoryState: "factory:on-epic", parentIssueId: epic.id });
  await mk({ title: "test(1): ST-1 signs up", kind: "test", factoryState: "factory:manual-test", parentIssueId: epic.id });
  const fixing = await mk({ title: "bug(1): totals off by a cent", kind: "bug",
                            factoryState: "factory:bug-open", parentIssueId: epic.id });
  const retest = await mk({ title: "bug(1): discount ignored", kind: "bug",
                            factoryState: "factory:bug-retest", parentIssueId: epic.id });
  await mk({ title: "bug(1): stale cache", kind: "bug", factoryState: "factory:bug-verified",
             state: "closed", parentIssueId: epic.id });
  id.epic = epic.id;
  id.fixing = fixing.id;
  id.retest = retest.id;

  // An epic with nothing built yet: too early for a bug — what the reporter
  // has is a requirement.
  id.early = (await mk({ title: "early epic", kind: "epic", factoryState: "factory:spec-approved" })).id;

  // A shipped epic: a defect in it is a new issue, or an incident.
  id.shipped = (await mk({ title: "shipped epic", kind: "epic", factoryState: "factory:deployed" })).id;

  // An epic in a repo whose policy says no.
  id.off = (await mk({ title: "off epic", kind: "epic", factoryState: "factory:design-approved", repoId: offRepo.id })).id;
});

const get = async (epicId: string) =>
  (await app.inject({ method: "GET", url: `/api/epics/${epicId}`, headers: { cookie } })).json();

describe("an epic's bugs are counted apart from its tasks and its cases", () => {
  it("keeps reports out of the code-task rollup", async () => {
    const { rollup } = await get(id.epic!);
    // Two tasks — the schema task and the one that fixes a bug. The three
    // reports are children too, and counting them here would double-count the
    // repair work that is already on the board as a task.
    expect(rollup.total).toBe(2);
    expect(rollup.shipping).toBe(2);
  });

  it("rolls the reports up on their own", async () => {
    const { rollup } = await get(id.epic!);
    expect(rollup.bugs).toEqual({ total: 3, fixing: 1, retest: 1, verified: 1, open: 2 });
  });

  it("keeps reports off the task board and out of the case list", async () => {
    const { tasks, bugs } = await get(id.epic!);
    expect(tasks.some((t: { kind: string }) => t.kind === "bug")).toBe(false);
    expect(tasks.filter((t: { kind: string }) => t.kind === "test")).toHaveLength(1);
    expect(bugs.rows).toHaveLength(3);
  });

  it("leaves an epic with no reports reading exactly as before", async () => {
    const { rollup, bugs } = await get(id.early!);
    expect(rollup.bugs).toBeUndefined();
    expect(bugs.rows).toHaveLength(0);
  });
});

describe("whether a bug may be raised here", () => {
  it("offers it on an epic under test", async () => {
    const { bugs } = await get(id.epic!);
    expect(bugs.enabled).toBe(true);
    expect(bugs.report).toEqual({ offered: true, reason: null });
  });

  it("does not offer it before the epic has built anything", async () => {
    const { bugs } = await get(id.early!);
    expect(bugs.report.offered).toBe(false);
    expect(bugs.report.reason).toMatch(/has not built any yet/);
  });

  it("does not offer it on a shipped epic", async () => {
    const { bugs } = await get(id.shipped!);
    expect(bugs.report.offered).toBe(false);
    expect(bugs.report.reason).toMatch(/shipped/);
  });

  it("does not offer it where the repo runs no bug reports", async () => {
    const { bugs } = await get(id.off!);
    expect(bugs.enabled).toBe(false);
    expect(bugs.report.offered).toBe(false);
  });
});

describe("POST /api/epics/:id/bugs", () => {
  const post = (epicId: string, body: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/epics/${epicId}/bugs`,
      headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: body,
    });

  it("400s without a title", async () => {
    expect((await post(id.epic!, { report: "the total stayed at 100.00" })).statusCode).toBe(400);
  });

  it("400s without the report itself", async () => {
    // `Bug` is the one control that reads past its first line, which is the
    // only reason a report can carry its evidence at all. An empty one would
    // file a fix task quoting nothing.
    const res = await post(id.epic!, { title: "discount ignored" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/what you saw/);
  });

  it("409s where the repo runs no bug reports", async () => {
    const res = await post(id.off!, { title: "x", report: "y" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/factory-testing\.json/);
  });

  it("409s before the epic has built anything", async () => {
    expect((await post(id.early!, { title: "x", report: "y" })).statusCode).toBe(409);
  });

  it("409s on a sub-issue rather than commenting on it", async () => {
    expect((await post(id.retest!, { title: "x", report: "y" })).statusCode).toBe(409);
  });

  it("404s on an epic in another org", async () => {
    expect((await post("00000000-0000-0000-0000-000000000000", { title: "x", report: "y" })).statusCode).toBe(404);
  });
});

describe("POST /api/issues/:id/test-verdict on a bug", () => {
  const post = (issueId: string, body: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/test-verdict`,
      headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: body,
    });

  it("409s on a report whose fix has not landed", async () => {
    // A verdict means nothing until there is something to re-test.
    expect((await post(id.fixing!, { verdict: "passed" })).statusCode).toBe(409);
  });

  it("409s on the epic itself", async () => {
    expect((await post(id.epic!, { verdict: "passed" })).statusCode).toBe(409);
  });
});
