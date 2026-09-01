import { randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { auditLog, estates, gateAssignments, issues, memberships, orgs, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * Expedite mode through the API (change `add-expedite-mode-console`).
 *
 * Three things have to hold and none of them are visible from a single route:
 * the queue must stop asking for the approvals the factory now gives itself,
 * gate GS must reach the right people on an estate that has never heard of it,
 * and the marker must be written under the acting user's own token — the
 * factory checks who applied it, so an App-written label would be reverted and
 * the Console would have lied about who asked.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const API_URL = "https://gh.test";
const USER_TOKEN = "alice-oauth-token";

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
    await d
      .insert(users)
      .values({ ghUserId: 1, login: "alice", encryptedOauthToken: encryptSecret(USER_TOKEN, MASTER_KEY) })
      .returning()
  )[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await d.insert(memberships).values({ orgId: org.id, userId: alice.id, role: "owner" });
  await d.insert(sessions).values({ id: "sess-1", userId: alice.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const repo = (
    await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/app" }).returning()
  )[0]!;

  // Deliberately no `staging` row: this estate's approver file predates gate
  // GS, so GS has to find alice through the `release` list or reach nobody.
  await d.insert(gateAssignments).values([
    { estateId: estate.id, repoId: repo.id, gate: "spec", login: "alice" },
    { estateId: estate.id, repoId: repo.id, gate: "release", login: "alice" },
    { estateId: estate.id, repoId: repo.id, gate: "implementation", login: "alice" },
  ]);

  const mk = async (over: Partial<typeof issues.$inferInsert> & { number: number; title: string }) =>
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

  // #100 — an expedited epic mid-build, with one ready task and one halted one.
  const fastEpic = await mk({
    number: 100,
    title: "expedited epic",
    kind: "epic",
    factoryState: "factory:design-approved",
    labels: ["factory:design-approved", "factory:expedite"],
  });
  const fastReady = await mk({ number: 101, title: "task(api): send", factoryState: "factory:ready", parentIssueId: fastEpic.id });
  await mk({ number: 102, title: "task(api): halted", factoryState: "factory:blocked", parentIssueId: fastEpic.id });

  // #200 — the same shape without the marker: everything still surfaces.
  const plainEpic = await mk({ number: 200, title: "plain epic", kind: "epic", factoryState: "factory:spec-ready" });
  await mk({ number: 201, title: "task(api): plain", factoryState: "factory:ready", parentIssueId: plainEpic.id });

  // #300 — expedited at G1: the factory approves that itself.
  await mk({
    number: 300,
    title: "expedited at the spec gate",
    kind: "epic",
    factoryState: "factory:spec-ready",
    labels: ["factory:spec-ready", "factory:expedite"],
  });

  // #400 / #500 — gate GS, non-expedited and expedited. Both must surface.
  const gsEpic = await mk({ number: 400, title: "assembled epic", kind: "epic", factoryState: "factory:epic-ready" });
  await mk({ number: 401, title: "task(api): landed", factoryState: "factory:on-epic", parentIssueId: gsEpic.id });
  await mk({
    number: 500,
    title: "assembled expedited epic",
    kind: "epic",
    factoryState: "factory:epic-ready",
    labels: ["factory:epic-ready", "factory:expedite"],
  });

  // #600 — G3, unchanged by any of this.
  await mk({ number: 600, title: "on staging", kind: "epic", factoryState: "factory:in-staging" });

  // #700 — the fast lane, where there is nothing to waive.
  await mk({
    number: 700,
    title: "fast-track fix",
    kind: "epic",
    factoryState: "factory:fast-track",
    labels: ["factory:fast-track"],
  });

  id.fastEpic = fastEpic.id;
  id.fastReady = fastReady.id;
  id.plainEpic = plainEpic.id;
  id.gsEpic = gsEpic.id;
  id.fastTrack = (await d.select().from(issues).where(eq(issues.number, 700)))[0]!.id;
});

afterEach(() => vi.unstubAllGlobals());

/** Record every GitHub call the route makes, with the identity it used. */
function stubGitHub(status = 200, body: unknown = {}) {
  const calls: Array<{ method: string; url: string; auth: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(url),
        auth: init?.headers?.["authorization"] ?? null,
      });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const attention = async () => {
  const res = await app.inject({ method: "GET", url: "/api/attention", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { entries: Array<Record<string, unknown>> }).entries;
};

describe("the queue asks only for what a human still owes", () => {
  it("drops an expedited epic's task-start and G1 items, and keeps everyone else's", async () => {
    const entries = await attention();
    const titles = entries.map((e) => e.title);

    // The factory starts #101 itself; the same task under a plain epic still asks.
    expect(titles).not.toContain("#101 task(api): send");
    expect(titles).toContain("#201 task(api): plain");
    // G1 on an expedited epic is the factory's own approval now.
    expect(titles).not.toContain("#300 expedited at the spec gate");
    expect(titles).toContain("#200 plain epic");
  });

  it("keeps a halted agent, staging and production visible on an expedited epic", async () => {
    const entries = await attention();
    const byTitle = (t: string) => entries.find((e) => e.title === t);

    const halted = byTitle("#102 task(api): halted")!;
    expect(halted.kind).toBe("blocked");
    expect(halted.expedited).toBe(true);

    // G3 is untouched by expedite in either direction.
    expect(byTitle("#600 on staging")!.kind).toBe("merge");
  });

  it("surfaces gate GS to the release approvers where the estate has no staging list", async () => {
    const entries = await attention();
    for (const title of ["#400 assembled epic", "#500 assembled expedited epic"]) {
      const gs = entries.find((e) => e.title === title)!;
      expect(gs, title).toBeTruthy();
      expect(gs.kind).toBe("gate");
      expect(gs.rank).toBe(2);
      expect(gs.state).toBe("factory:epic-ready");
      expect(gs.whyYou).toContain("release to staging is waiting on you");
      expect(gs.whyYou).toContain("release approver list");
      expect(gs.link).toContain("?tab=gate");
    }
    expect(entries.find((e) => e.title === "#500 assembled expedited epic")!.expedited).toBe(true);
  });

  it("restores today's items the moment the marker comes off", async () => {
    const d = deps.dbh.db;
    await d.update(issues).set({ labels: ["factory:design-approved"] }).where(eq(issues.id, id.fastEpic!));
    const after = await attention();
    const restored = after.find((e) => e.title === "#101 task(api): send")!;
    expect(restored).toBeTruthy();
    expect(restored.kind).toBe("task-start");
    expect(restored.expedited).toBe(false);

    await d.update(issues).set({ labels: ["factory:design-approved", "factory:expedite"] }).where(eq(issues.id, id.fastEpic!));
    expect((await attention()).some((e) => e.title === "#101 task(api): send")).toBe(false);
  });
});

describe("the toggle writes the marker as the user", () => {
  it("applies the label on the acting user's token, and records who asked", async () => {
    const calls = stubGitHub(200, {});
    const res = await app.inject({
      method: "POST",
      url: `/api/epics/${id.plainEpic}/expedite`,
      headers,
      payload: { on: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, on: true, changed: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${API_URL}/repos/acme/app/issues/200/labels`);
    // The whole point: the human's own identity, never the App's.
    expect(calls[0]!.auth).toBe(`Bearer ${USER_TOKEN}`);

    const audit = await deps.dbh.db.select().from(auditLog).where(eq(auditLog.action, "epic.expedite.on"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target).toBe("acme/app#200");
    expect(audit[0]!.payload["actor"]).toBe("alice");
  });

  it("shows the marker, its flip and the toggle's state on the workspace payload", async () => {
    const res = await app.inject({ method: "GET", url: `/api/epics/${id.plainEpic}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { expedite: { on: boolean; available: boolean; lastFlip: { actor: string; on: boolean } } };
    expect(body.expedite.on).toBe(true);
    expect(body.expedite.available).toBe(true);
    expect(body.expedite.lastFlip).toMatchObject({ actor: "alice", on: true });
  });

  it("removes it with a DELETE, and does nothing at all when it is already off", async () => {
    // 200 rather than 204: a Response cannot carry a body with 204, and the
    // client treats either as success.
    const calls = stubGitHub(200, {});
    const off = await app.inject({
      method: "POST",
      url: `/api/epics/${id.plainEpic}/expedite`,
      headers,
      payload: { on: false },
    });
    expect(off.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({ method: "DELETE", auth: `Bearer ${USER_TOKEN}` });
    expect(calls[0]!.url).toContain("/issues/200/labels/factory%3Aexpedite");

    const again = await app.inject({
      method: "POST",
      url: `/api/epics/${id.plainEpic}/expedite`,
      headers,
      payload: { on: false },
    });
    expect(again.json()).toMatchObject({ ok: true, on: false, changed: false });
    expect(calls).toHaveLength(1); // no second GitHub call
  });

  it("refuses where the factory would, with the reason", async () => {
    const calls = stubGitHub(200, {});
    const fastLane = await app.inject({
      method: "POST",
      url: `/api/epics/${id.fastTrack}/expedite`,
      headers,
      payload: { on: true },
    });
    expect(fastLane.statusCode).toBe(409);
    expect(fastLane.json().error).toContain("fast lane");

    const task = await app.inject({
      method: "POST",
      url: `/api/epics/${id.fastReady}/expedite`,
      headers,
      payload: { on: true },
    });
    expect(task.statusCode).toBe(409);
    expect(task.json().error).toContain("its tasks inherit it");
    expect(calls).toEqual([]); // nothing reached GitHub
  });
});

describe("gate GS", () => {
  it("panels the assembly and names the standing-in approvers", async () => {
    const res = await app.inject({ method: "GET", url: `/api/epics/${id.gsEpic}/gate`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const g = res.json() as {
      gate: string;
      label: string;
      commentApprovable: boolean;
      approvers: string[];
      approversFrom: string | null;
      assembly: { tasks: Array<{ number: number }>; allGreen: boolean; report: unknown };
    };
    expect(g.gate).toBe("staging");
    expect(g.label).toBe("GS");
    expect(g.commentApprovable).toBe(true);
    expect(g.approvers).toEqual(["alice"]);
    expect(g.approversFrom).toBe("release");
    expect(g.assembly.tasks).toMatchObject([{ number: 401 }]);
    expect(g.assembly.allGreen).toBe(true);
    expect(g.assembly.report).toBeNull();
  });

  it("approves by posting the literal `Approved` as the user", async () => {
    const calls = stubGitHub(201, { node_id: "C1", html_url: "https://gh/400#c1" });
    const res = await app.inject({ method: "POST", url: `/api/epics/${id.gsEpic}/gate/approve`, headers, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_URL}/repos/acme/app/issues/400/comments`);
    expect(calls[0]!.auth).toBe(`Bearer ${USER_TOKEN}`);

    const audit = await deps.dbh.db.select().from(auditLog).where(eq(auditLog.action, "gate.approve.staging"));
    expect(audit).toHaveLength(1);
  });

  it("leaves G3 exactly as it was — the merge is the gate", async () => {
    const g3 = (await deps.dbh.db.select().from(issues).where(eq(issues.number, 600)))[0]!;
    const panel = await app.inject({ method: "GET", url: `/api/epics/${g3.id}/gate`, headers: { cookie } });
    expect(panel.json()).toMatchObject({ gate: "release", label: "G3", commentApprovable: false, assembly: null });

    const calls = stubGitHub(201, {});
    const res = await app.inject({ method: "POST", url: `/api/epics/${g3.id}/gate/approve`, headers, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("not comment-approvable");
    expect(calls).toEqual([]);
  });
});
