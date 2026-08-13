import { randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import {
  comments,
  estates,
  gateAssignments,
  issues,
  issueStateHistory,
  memberships,
  orgs,
  repos,
  sessions,
  taskDependencies,
  users,
} from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * The individual view (plan 08 WP1/WP4): attention ranking and ownership,
 * /api/my-work grouping, peek scoping. Seeds one org for alice plus a foreign
 * org that must never leak into her responses.
 */

const MASTER_KEY = randomBytes(32).toString("base64");

let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const cookie = "console_session=sess-1";

// Seeded ids used across tests.
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

  const mkIssue = async (over: Partial<typeof issues.$inferInsert> & { number: number; title: string }) =>
    (
      await d
        .insert(issues)
        .values({
          orgId: org.id,
          repoId: repo.id,
          ghNodeId: `I${over.number}`,
          state: "open",
          kind: "task",
          ghUpdatedAt: new Date("2026-08-10T00:00:00Z"),
          ghCreatedAt: new Date("2026-08-01T00:00:00Z"),
          htmlUrl: `https://gh/${over.number}`,
          ...over,
        })
        .returning()
    )[0]!;

  // #10: blocked, assigned to alice, halted out of in-review, with an agent question.
  const blockedMine = await mkIssue({ number: 10, title: "mine blocked", factoryState: "factory:blocked", assignees: ["alice"] });
  await d.insert(issueStateHistory).values([
    { orgId: org.id, issueId: blockedMine.id, toState: "factory:in-review", occurredAt: new Date("2026-08-05T00:00:00Z"), sourceEventId: "e1" },
    { orgId: org.id, issueId: blockedMine.id, toState: "factory:blocked", occurredAt: new Date("2026-08-08T00:00:00Z"), sourceEventId: "e2" },
  ]);
  await d.insert(comments).values({
    orgId: org.id,
    issueId: blockedMine.id,
    ghNodeId: "C1",
    ghId: 1,
    author: "bot",
    body: "### Question\nWhich currency should refunds use?\n<!-- factory-agent -->",
    isAgent: true,
    ghCreatedAt: new Date("2026-08-08T00:01:00Z"),
    ghUpdatedAt: new Date("2026-08-08T00:01:00Z"),
  });

  // #11: blocked, nobody's — broadcast, but older than #10.
  await mkIssue({ number: 11, title: "orphan blocked", factoryState: "factory:blocked", author: "someone", ghUpdatedAt: new Date("2026-07-01T00:00:00Z") });

  // #12: epic at spec-ready; alice is on the spec list.
  const epic = await mkIssue({ number: 12, title: "epic", kind: "epic", factoryState: "factory:spec-ready", author: "alice" });
  await d.insert(gateAssignments).values({ estateId: estate.id, repoId: repo.id, gate: "spec", login: "alice" });

  // #13 (alice's task) blocked by #14 (someone else's, open, in review).
  const waiting = await mkIssue({ number: 13, title: "my waiting task", factoryState: "factory:ready", assignees: ["alice"], parentIssueId: epic.id });
  const blocker = await mkIssue({ number: 14, title: "their blocker", factoryState: "factory:in-review", assignees: ["sam"] });
  await d.insert(taskDependencies).values({ orgId: org.id, blockedIssueId: waiting.id, blockerIssueId: blocker.id, source: "github" });

  // Foreign org data that must never appear for alice.
  const otherOrg = (await d.insert(orgs).values({ name: "other" }).returning())[0]!;
  const otherEstate = (await d.insert(estates).values({ orgId: otherOrg.id, name: "other", installationId: 2 }).returning())[0]!;
  const otherRepo = (
    await d.insert(repos).values({ orgId: otherOrg.id, estateId: otherEstate.id, ghNodeId: "R2", fullName: "other/app" }).returning()
  )[0]!;
  const foreign = (
    await d
      .insert(issues)
      .values({
        orgId: otherOrg.id,
        repoId: otherRepo.id,
        ghNodeId: "IX",
        number: 1,
        title: "foreign",
        state: "open",
        kind: "task",
        factoryState: "factory:blocked",
        assignees: ["alice"],
        ghUpdatedAt: new Date(),
        htmlUrl: "https://gh/x",
      })
      .returning()
  )[0]!;

  id.blockedMine = blockedMine.id;
  id.epic = epic.id;
  id.waiting = waiting.id;
  id.blocker = blocker.id;
  id.foreign = foreign.id;
});

describe("/api/attention ranking", () => {
  it("owned blocked outranks gates outranks broadcast, with the agent question surfaced", async () => {
    const res = await app.inject({ method: "GET", url: "/api/attention", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json() as { entries: Array<Record<string, unknown>> };
    const titles = entries.map((e) => [e.rank, e.title]);
    // rank 1: #10 (owned blocked); rank 2: #12 gate; rank 3: #13 task-start; rank 4: #11 broadcast.
    expect(titles[0]).toEqual([1, "#10 mine blocked"]);
    expect(entries[0]!.whyYou).toContain("assigned to you");
    expect(entries[0]!.question).toBe("Which currency should refunds use?");
    // Blocked age counts from the label event, not ghUpdatedAt.
    expect(entries[0]!.ageDays).toBeGreaterThanOrEqual(1);
    expect(entries.find((e) => e.title === "#11 orphan blocked")!.rank).toBe(4);
    expect(entries.find((e) => e.title === "#12 epic")!.rank).toBe(2);
    // Nothing from the foreign org.
    expect(entries.some((e) => e.title === "#1 foreign")).toBe(false);
  });
});

describe("/api/my-work", () => {
  it("returns mine (assignee ∪ author) and waitingOn with the named blocker", async () => {
    const res = await app.inject({ method: "GET", url: "/api/my-work", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mine: Array<Record<string, unknown>>; waitingOn: Array<Record<string, unknown>> };
    const mineNumbers = body.mine.map((m) => m.number).sort();
    expect(mineNumbers).toEqual([10, 12, 13]); // assigned, authored, assigned — not #11, not foreign
    const epicRow = body.mine.find((m) => m.number === 12)!;
    expect(epicRow.phase).toBe("specifying");
    expect(epicRow.whyMine).toBe("author");

    expect(body.waitingOn).toHaveLength(1);
    const w = body.waitingOn[0]! as { number: number; blocker: { number: number; assignees: string[]; phase: string } };
    expect(w.number).toBe(13);
    expect(w.blocker.number).toBe(14);
    expect(w.blocker.assignees).toEqual(["sam"]);
    expect(w.blocker.phase).toBe("building");
  });
});

describe("/api/issues/:id/peek", () => {
  it("renders sentence, deps and blocked question for an owned issue", async () => {
    const res = await app.inject({ method: "GET", url: `/api/issues/${id.waiting}/peek`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, never>;
    expect(body["sentence"]).toContain("implementation start");
    expect((body["deps"] as { blockedBy: unknown[] }).blockedBy).toHaveLength(1);

    const blocked = await app.inject({ method: "GET", url: `/api/issues/${id.blockedMine}/peek`, headers: { cookie } });
    const b = blocked.json() as { blocked: { question: string } };
    expect(b.blocked.question).toBe("Which currency should refunds use?");
  });

  it("404s a foreign-org issue", async () => {
    const res = await app.inject({ method: "GET", url: `/api/issues/${id.foreign}/peek`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});
