import { randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { comments, estates, issueStateHistory, issues, memberships, orgs, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * The task start gate is three moments under one label (see
 * core/start-gate.ts). The Console read only the label, so a task that had
 * already been approved kept offering Approve — and pressing it again posts a
 * second `Approved`, which the router takes as a second implementer start.
 * These pin the payload every tab reads, and the guard behind the button.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const API_URL = "https://gh.test";

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
  const cfg = loadConfig({
    CONSOLE_MASTER_KEY: MASTER_KEY,
    GITHUB_APP_WEBHOOK_SECRET: "s",
    GITHUB_API_URL: API_URL,
    NODE_ENV: "test",
  } as never);
  deps = {
    cfg,
    dbh: { db, sql: null as never, close: async () => undefined },
    credentials: new CredentialStore({
      masterKey: MASTER_KEY,
      apiUrl: API_URL,
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
          ghUpdatedAt: new Date("2026-08-31T09:00:00Z"),
          ghCreatedAt: new Date("2026-08-31T08:00:00Z"),
          htmlUrl: `https://gh/${over.number}`,
          ...over,
        })
        .returning()
    )[0]!;

  const epic = await mkIssue({ number: 250, title: "epic", kind: "epic", factoryState: "factory:design-approved" });
  const task = await mkIssue({
    number: 198,
    title: "task(250): contact column",
    factoryState: "factory:ready",
    labels: ["factory:ready"],
    parentIssueId: epic.id,
  });
  id.org = org.id;
  id.epic = epic.id;
  id.task = task.id;
});

/** Put the task back at an untouched start gate. */
async function resetGate() {
  const d = deps.dbh.db;
  await d.delete(comments).where(eq(comments.issueId, id.task!));
  await d.delete(issueStateHistory).where(eq(issueStateHistory.issueId, id.task!));
  await d.update(issues).set({ labels: ["factory:ready"] }).where(eq(issues.id, id.task!));
}

const approvedAt = async (at: Date, nodeId = "C1") => {
  await deps.dbh.db.insert(comments).values({
    orgId: id.org!,
    issueId: id.task!,
    ghNodeId: nodeId,
    ghId: 1,
    author: "alice",
    body: "Approved",
    isApproval: true,
    htmlUrl: "https://gh/198#c1",
    ghCreatedAt: at,
    ghUpdatedAt: at,
  });
};

const markRunning = () =>
  deps.dbh.db.update(issues).set({ labels: ["factory:ready", "factory:in-progress"] }).where(eq(issues.id, id.task!));

const workspaceTask = async () => {
  const res = await app.inject({ method: "GET", url: `/api/epics/${id.epic}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return (res.json().tasks as Array<{ number: number }>).find((t) => t.number === 198)!;
};

const treeNode = async () => {
  const res = await app.inject({ method: "GET", url: `/api/epics/${id.epic}/tree`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return (res.json().nodes as Array<{ number: number }>).find((n) => n.number === 198)!;
};

const approve = () =>
  app.inject({
    method: "POST",
    url: `/api/issues/${id.task}/approve`,
    headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
    payload: {},
  });

beforeEach(resetGate);
afterEach(() => vi.unstubAllGlobals());

describe("the start gate the tabs read", () => {
  it("asks for an approval while nothing has been approved", async () => {
    expect(await workspaceTask()).toMatchObject({ startStatus: "awaiting", approvable: true });
    expect(await treeNode()).toMatchObject({ startStatus: "awaiting", approvable: true });
  });

  it("stops asking once an approval is on the issue", async () => {
    await approvedAt(new Date());
    expect(await workspaceTask()).toMatchObject({ startStatus: "approved", approvable: false });
    expect(await treeNode()).toMatchObject({ startStatus: "approved", approvable: false });
  });

  it("says a run is live while the implementer works, though the label still reads ready", async () => {
    await approvedAt(new Date());
    await markRunning();
    expect(await workspaceTask()).toMatchObject({ startStatus: "running", approvable: false });
  });

  it("asks again when an approval has gone unrouted for too long", async () => {
    await approvedAt(new Date(Date.now() - 60 * 60_000));
    expect(await workspaceTask()).toMatchObject({ startStatus: "stalled", approvable: true });
  });

  it("ignores an approval from before the task came back to ready", async () => {
    await approvedAt(new Date(Date.now() - 60 * 60_000));
    await deps.dbh.db.insert(issueStateHistory).values({
      orgId: id.org!,
      issueId: id.task!,
      toState: "factory:ready",
      sourceEventId: "e1",
      occurredAt: new Date(Date.now() - 30 * 60_000),
    });
    expect(await workspaceTask()).toMatchObject({ startStatus: "awaiting", approvable: true });
  });

  it("keeps the task out of the attention queue once it is approved", async () => {
    const listed = async () => {
      const res = await app.inject({ method: "GET", url: "/api/attention", headers: { cookie } });
      return (res.json().entries as Array<{ issueId: string }>).some((e) => e.issueId === id.task);
    };
    expect(await listed()).toBe(true);
    await approvedAt(new Date());
    expect(await listed()).toBe(false);
  });
});

describe("POST /api/issues/:id/approve refuses a second start", () => {
  function stubGitHub(body: unknown) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } });
      }),
    );
    return calls;
  }

  it("posts the approval and records it, so the button does not come back", async () => {
    const now = new Date().toISOString();
    const calls = stubGitHub({
      id: 4242,
      node_id: "C-live",
      body: "Approved",
      user: { login: "alice" },
      created_at: now,
      updated_at: now,
      html_url: "https://gh/198#c-live",
    });
    const res = await approve();
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([`${API_URL}/repos/acme/app/issues/198/comments`]);
    // No webhook has arrived yet, and the tabs still refetch immediately.
    expect(await workspaceTask()).toMatchObject({ startStatus: "approved", approvable: false });
  });

  it("409s rather than posting a second Approved while a run is live", async () => {
    await approvedAt(new Date());
    await markRunning();
    const calls = stubGitHub({});
    const res = await approve();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ startStatus: "running" });
    expect(res.json().error).toContain("already running");
    expect(calls).toEqual([]);
  });

  it("409s on a double press before the run has started", async () => {
    await approvedAt(new Date());
    const calls = stubGitHub({});
    const res = await approve();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ startStatus: "approved" });
    expect(calls).toEqual([]);
  });

  it("lets an unrouted approval be retried", async () => {
    await approvedAt(new Date(Date.now() - 60 * 60_000));
    const now = new Date().toISOString();
    const calls = stubGitHub({
      id: 4343,
      node_id: "C-retry",
      body: "Approved",
      user: { login: "alice" },
      created_at: now,
      updated_at: now,
      html_url: "https://gh/198#c-retry",
    });
    const res = await approve();
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
