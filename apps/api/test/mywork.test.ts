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
  pullRequests,
  repos,
  sessions,
  taskDependencies,
  users,
  webhookDeliveries,
} from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
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

  // A milestone-tracked epic (someone else's) plus its release tracker, for /api/flow.
  const msEpic = await mkIssue({
    number: 15,
    title: "billing export",
    kind: "epic",
    factoryState: "factory:planned",
    author: "sam",
    milestoneTitle: "2026.09",
    milestoneNumber: 1,
  });
  await mkIssue({
    number: 17,
    title: "task(api): export endpoint",
    factoryState: "factory:ready",
    parentIssueId: msEpic.id,
    milestoneTitle: "2026.09",
    milestoneNumber: 1,
  });
  await mkIssue({
    number: 16,
    title: "release(2026.09)",
    kind: "plain",
    factoryState: "factory:release-ready",
    labels: ["factory:release", "factory:release-ready"],
    milestoneTitle: "2026.09",
    milestoneNumber: 1,
  });
  // A closed epic that must not appear in the tree.
  await mkIssue({ number: 18, title: "done epic", kind: "epic", factoryState: "factory:deployed", state: "closed" });

  // #19: a fast-track fix whose PR awaits a human merge — the fast lane has no
  // gate, so the queue must announce the PR itself (the regression: this
  // finished in silence and never showed up anywhere).
  const fastTrack = await mkIssue({
    number: 19,
    title: "login required indicators",
    kind: "epic",
    factoryState: "factory:fast-track",
    labels: ["factory:fast-track"],
    author: "sam",
  });
  await d.insert(pullRequests).values({
    orgId: org.id,
    repoId: repo.id,
    ghNodeId: "P20",
    number: 20,
    title: "feat(login): mark fields required",
    kind: "task",
    issueNumber: 19,
    headRef: "factory/19-login-required",
    baseRef: "main",
    state: "open",
    draft: false,
    htmlUrl: "https://gh/pr/20",
    ghUpdatedAt: new Date("2026-08-10T00:00:00Z"),
  });

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
  id.fastTrack = fastTrack.id;
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

  it("announces a fast-track PR awaiting merge at gate rank", async () => {
    const res = await app.inject({ method: "GET", url: "/api/attention", headers: { cookie } });
    const { entries } = res.json() as { entries: Array<Record<string, unknown>> };
    const ft = entries.find((e) => e.title === "#19 login required indicators")!;
    expect(ft).toBeTruthy();
    expect(ft.kind).toBe("merge");
    expect(ft.rank).toBe(2);
    expect(ft.whyYou).toContain("fast-track PR #20 awaits review and merge");
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

  it("lists the open PR awaiting merge on a fast-track issue", async () => {
    const res = await app.inject({ method: "GET", url: `/api/issues/${id.fastTrack}/peek`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sentence: string; prs: Array<{ number: number; htmlUrl: string }> };
    expect(body.sentence).toContain("fast lane");
    expect(body.prs).toMatchObject([{ number: 20, htmlUrl: "https://gh/pr/20" }]);
  });

  it("404s a foreign-org issue", async () => {
    const res = await app.inject({ method: "GET", url: `/api/issues/${id.foreign}/peek`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe("/api/flow", () => {
  it("builds the milestone tree with rollups, tracker state and a No release node", async () => {
    const res = await app.inject({ method: "GET", url: "/api/flow", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { estates: flowEstates } = res.json() as {
      estates: Array<{ name: string; milestones: Array<Record<string, never>> }>;
    };
    expect(flowEstates).toHaveLength(1); // the foreign estate never appears
    const [estate] = flowEstates;
    const titles = estate!.milestones.map((m) => m["title"]);
    expect(titles).toEqual(["2026.09", "No release"]); // named milestones first, No release last

    const ms = estate!.milestones[0]! as unknown as {
      trackerState: string;
      epics: Array<{ number: number; tasks: Array<{ number: number }>; rollup: { total: number; ready: number } }>;
    };
    expect(ms.trackerState).toBe("factory:release-ready");
    expect(ms.epics.map((e) => e.number)).toEqual([15]);
    expect(ms.epics[0]!.rollup).toMatchObject({ total: 1, ready: 1 });

    const noRelease = estate!.milestones[1]! as unknown as {
      epics: Array<{ number: number; tasks: Array<{ number: number; blockedBy: number[] }> }>;
    };
    const epicNumbers = noRelease.epics.map((e) => e.number);
    expect(epicNumbers).toContain(12);
    expect(epicNumbers).not.toContain(18); // closed epics stay out of the tree
    const epic12 = noRelease.epics.find((e) => e.number === 12)!;
    expect(epic12.tasks.map((t) => t.number)).toEqual([13]);
    expect(epic12.tasks[0]!.blockedBy).toEqual([14]);
  });

  it("shows a fast-track epic with its open PR in the tree", async () => {
    const res = await app.inject({ method: "GET", url: "/api/flow", headers: { cookie } });
    const { estates: flowEstates } = res.json() as {
      estates: Array<{ milestones: Array<{ title: string; epics: Array<{ number: number; state: string; prs: Array<{ number: number; draft: boolean }> }> }> }>;
    };
    const noRelease = flowEstates[0]!.milestones.find((m) => m.title === "No release")!;
    const ft = noRelease.epics.find((e) => e.number === 19)!;
    expect(ft).toBeTruthy();
    expect(ft.state).toBe("factory:fast-track");
    expect(ft.prs).toMatchObject([{ number: 20, draft: false }]);
  });
});

describe("/api/estates ingestion health", () => {
  it("reports never-received, then a pending delivery, then a drained queue", async () => {
    const read = async () => {
      const res = await app.inject({ method: "GET", url: "/api/estates", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      return (res.json() as { ingestion: { lastReceivedAt: string | null; lastProcessedAt: string | null; pending: number } }).ingestion;
    };

    // Nothing delivered yet — the "webhooks never arrived" diagnosis.
    const before = await read();
    expect(before.lastReceivedAt).toBeNull();
    expect(before.pending).toBe(0);

    // A delivery lands but nothing processes it — the "worker down" diagnosis.
    const d = deps.dbh.db;
    await d.insert(webhookDeliveries).values({ deliveryGuid: "g1", event: "issues" });
    const pending = await read();
    expect(pending.lastReceivedAt).not.toBeNull();
    expect(pending.pending).toBe(1);

    // The worker catches up.
    await d.update(webhookDeliveries).set({ processedAt: new Date() }).where(eq(webhookDeliveries.deliveryGuid, "g1"));
    const drained = await read();
    expect(drained.pending).toBe(0);
    expect(drained.lastProcessedAt).not.toBeNull();
  });
});

describe("issue-scoped Q&A", () => {
  it("lists empty conversations with enabled=false when no key is configured", async () => {
    const res = await app.inject({ method: "GET", url: `/api/issues/${id.waiting}/qa`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { conversations: unknown[]; enabled: boolean };
    expect(body.conversations).toEqual([]);
    expect(body.enabled).toBe(false);
  });

  it("503s an ask without the insight key, 404s a foreign issue", async () => {
    const ask = await app.inject({
      method: "POST",
      url: `/api/issues/${id.waiting}/qa`,
      headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { question: "Why is this blocked?" },
    });
    expect(ask.statusCode).toBe(503);
    const foreign = await app.inject({
      method: "POST",
      url: `/api/issues/${id.foreign}/qa`,
      headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { question: "hi" },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("assembles the issue context around the dependency neighbourhood", async () => {
    const { assembleIssueContext } = await import("../src/routes/qa.js");
    const d = deps.dbh.db;
    const issueRow = (await d.select().from(issues).where(eq(issues.id, id.waiting)))[0]!;
    const ctx = {
      userId: "u",
      login: "alice",
      orgIds: [issueRow.orgId],
    } as never;
    const sources = await assembleIssueContext(deps, ctx, issueRow);
    const refs = sources.map((s) => s.ref);
    expect(refs).toContain("issue/13"); // the focus issue
    expect(refs).toContain("issue/14"); // its blocker, one hop out
    const blockerSource = sources.find((s) => s.ref === "issue/14")!;
    expect(blockerSource.content).toContain("blocks this issue");
    expect(blockerSource.content).toContain("@sam");
    expect(refs).not.toContain("deps/omitted"); // under the neighbour cap
  });
});
