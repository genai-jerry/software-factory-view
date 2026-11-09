import { generateKeyPairSync } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, issues, memberships, orgs, pullRequests, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const PKCS8 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const cookie = "console_session=sess-1";
const RUN = "factory:in-progress";

let app: Awaited<ReturnType<typeof buildApp>>;
let deps: AppDeps;
const id: Record<string, string> = {};

beforeEach(async () => {
  const pg = new PGlite();
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of (await readFile(join(migrationsDir, file), "utf8")).split("--> statement-breakpoint")) {
      if (stmt.trim()) await pg.exec(stmt.trim());
    }
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
      env: { appId: "1", privateKeyPem: PKCS8, webhookSecret: "s", clientId: "c", clientSecret: "cs" },
    }),
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  const user = (
    await db.insert(users).values({ ghUserId: 1, login: "alice", encryptedOauthToken: encryptSecret("t", MASTER_KEY) }).returning()
  )[0]!;
  const org = (await db.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  await db.insert(sessions).values({ id: "sess-1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (await db.insert(estates).values({ orgId: org.id, name: "acme", installationId: 99 }).returning())[0]!;
  const mkRepo = async (name: string) =>
    (await db.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: `r-${name}`, fullName: `acme/${name}` } as never).returning())[0]!;
  const api = await mkRepo("api");
  const web = await mkRepo("web");
  let n = 100;
  const mk = async (repoId: string, over: Record<string, unknown>) =>
    (
      await db
        .insert(issues)
        .values({
          orgId: org.id, repoId, number: ++n, kind: "task", title: `t${n}`, state: "open", labels: [],
          ghNodeId: `n${n}`, ghId: n, ghCreatedAt: new Date(), ghUpdatedAt: new Date(), ...over,
        } as never)
        .returning()
    )[0]!;
  const epic = await mk(api.id, { number: 34, kind: "epic", title: "Booker status", factoryState: "factory:design-approved", labels: [RUN] });
  id.epic = epic.id;
  id.review = (await mk(api.id, { number: 40, title: "task(34): The status map", factoryState: "factory:in-review", labels: [RUN], parentIssueId: epic.id })).id;
  await mk(api.id, { number: 41, title: "task(34): idle", factoryState: "factory:in-review", parentIssueId: epic.id });
  await mk(api.id, { number: 42, title: "task(34): closed", state: "closed", factoryState: "factory:in-test", labels: [RUN], parentIssueId: epic.id });
  await mk(api.id, { number: 43, kind: "test", title: "test(34): ST-1 case", factoryState: "factory:manual-test", labels: [RUN], parentIssueId: epic.id });
  id.webTask = (await mk(web.id, { number: 7, title: "task(34): The panel", factoryState: "factory:ready", labels: [RUN], parentIssueId: epic.id })).id;
  id.apiRepo = api.id;
  id.org = org.id;
  id.webRepo = web.id;
  app = await buildApp(deps);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

const envs = {
  sessions: {
    total: 4,
    in_use: [
      { run_id: "r40", role: "reviewer", issue: 40, repo: "acme/api", environment: "acme/api#40", since: "2026-11-06T05:00:00+00:00" },
      { run_id: "x", role: "qa", issue: 1, repo: "someone/else", environment: "someone/else#1", since: null },
    ],
    waiting: [{ run_id: "r7", role: "implementer", issue: 7, repo: "acme/web", environment: "acme/web#7", since: "2026-11-06T05:01:00+00:00" }],
  },
  environments: [
    { id: "acme/api@staging", kind: "staging", repo: "acme/api", number: null, epic: null, last_used_at: "2026-11-06T04:00:00+00:00",
      active: { run_id: "rel", role: "release", issue: 34, state: "running", since: "2026-11-06T05:02:00+00:00" },
      queue: [{ run_id: "relw", role: "release", issue: 7, repo: "acme/web", state: "waiting", since: "2026-11-06T05:04:00+00:00" }], notes: [{ at: "2026-11-06T04:00:00+00:00", role: "release", issue: 34, run_id: "old", outcome: "success", summary: "Merged onto staging." }] },
    { id: "acme/api#34", kind: "epic", repo: "acme/api", number: 34, epic: null, last_used_at: "2026-11-06T03:00:00+00:00", active: null, queue: [], notes: [] },
    { id: "acme/api#40", kind: "task", repo: "acme/api", number: 40, epic: "acme/api#34", last_used_at: "2026-11-06T05:00:00+00:00",
      active: { run_id: "r40", role: "reviewer", issue: 40, state: "running", since: "2026-11-06T05:00:00+00:00" },
      queue: [{ run_id: "r40b", role: "qa", issue: 40, state: "waiting", since: "2026-11-06T05:03:00+00:00" }], notes: [] },
    { id: "acme/api#41", kind: "task", repo: "acme/api", number: 41, epic: "acme/api#34", last_used_at: "2026-11-05T05:00:00+00:00", active: null, queue: [], notes: [] },
    { id: "acme/web#7", kind: "task", repo: "acme/web", number: 7, epic: "acme/api#34", last_used_at: null, active: null, queue: [], notes: [] },
    { id: "someone/else#1", kind: "issue", repo: "someone/else", number: 1, epic: null, last_used_at: null, active: null, queue: [], notes: [] },
  ],
};

const stub = (body: unknown = envs) => {
  deps.cfg.ORCHESTRATOR_URL = "http://127.0.0.1:8080";
  deps.cfg.ORCHESTRATOR_DISPATCH_TOKEN = "op";
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 200 }));
};
const environments = async (qs = "") => app.inject({ method: "GET", url: `/api/environments${qs}`, headers: { cookie } });

describe("GET /api/environments", () => {
  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/environments" })).statusCode).toBe(401);
  });

  it("groups tasks into their epic's lane and names everything by title", async () => {
    stub();
    const body = (await environments()).json();
    expect(body.available).toBe(true);
    expect(body.staging).toHaveLength(1);
    expect(body.staging[0]).toMatchObject({ title: "Staging", active: { role: "Release Manager", title: "Booker status", state: "running" } });
    // a sibling repo's task waiting on this staging is named from its own repo
    expect(body.staging[0].queue[0]).toMatchObject({ role: "Release Manager", title: "The panel", state: "waiting" });
    expect(body.staging[0].notes[0]).toMatchObject({ summary: "Merged onto staging.", outcome: "success", role: "Release Manager" });
    expect(body.lanes).toHaveLength(1);
    const lane = body.lanes[0];
    expect(lane).toMatchObject({ title: "Booker status", epicId: id.epic, tasksTotal: 4, tasksMerged: 1 });
    expect(lane.epic).toMatchObject({ kind: "epic", title: "Booker status" });
    // the busy task first, then by last use; the sibling-repo task is in the lane too
    expect(lane.tasks.map((t: { title: string }) => t.title)).toEqual(["The status map", "idle", "The panel"]);
    expect(lane.tasks[0].queue[0]).toMatchObject({ role: "QA", state: "waiting" });
    // another tenant's environment is left out
    expect(body.other).toEqual([]);
  });

  it("lists on each staging the epics merged there since its last promotion, from the pull requests", async () => {
    const db = deps.dbh.db as unknown as ReturnType<typeof drizzle>;
    let n = 500;
    const pr = (repoId: string, title: string, kind: string, mergedAt: string, baseRef = "staging") =>
      db.insert(pullRequests).values({
        orgId: id.org, repoId, ghNodeId: `pr${++n}`, number: n, title, kind, headRef: "h", baseRef, state: "closed",
        mergedAt: new Date(mergedAt), ghUpdatedAt: new Date(),
      } as never);
    const old = (await db.insert(issues).values({
      orgId: id.org, repoId: id.apiRepo, number: 35, kind: "plain", title: "Day-wise calls", state: "open", labels: [],
      factoryState: "factory:in-staging", ghNodeId: "n35", ghId: 35, ghCreatedAt: new Date(), ghUpdatedAt: new Date(),
    } as never).returning())[0]!;
    expect(old).toBeTruthy();
    // 35 integrated, then promoted (its label still says in-staging); 34 integrated after the promotion
    await pr(id.apiRepo, "release(35): integrate factory/epic-35 into staging", "other", "2026-11-01T00:00:00Z");
    await pr(id.apiRepo, "release(35): promote staging to main", "promotion", "2026-11-03T00:00:00Z", "main");
    await pr(id.apiRepo, "release(34): integrate factory/epic-34 into staging", "other", "2026-11-06T00:00:00Z");
    // the web half of epic 34, in its sibling repo
    await pr(id.webRepo, "release(34): integrate factory/epic-34 into staging", "other", "2026-11-06T00:00:00Z");
    stub({
      ...envs,
      environments: [
        ...envs.environments,
        { id: "acme/web@staging", kind: "staging", repo: "acme/web", number: null, epic: null, last_used_at: null, active: null, queue: [], notes: [] },
      ],
    });
    const body = (await environments()).json();
    const on = Object.fromEntries(body.staging.map((s: { repo: string; onStaging: unknown }) => [s.repo, s.onStaging]));
    expect(on["acme/api"]).toEqual([{ ref: "acme/api#34", title: "Booker status" }]);
    expect(on["acme/web"]).toEqual([{ ref: "acme/api#34", title: "Booker status" }]);
  });

  it("lists on each card the pull requests behind it: a task's own, an epic's, and what is on staging", async () => {
    const db = deps.dbh.db as unknown as ReturnType<typeof drizzle>;
    let n = 600;
    const pr = (over: Record<string, unknown>) =>
      db.insert(pullRequests).values({
        orgId: id.org, repoId: id.apiRepo, ghNodeId: `pr${++n}`, number: n, title: `pr ${n}`, kind: "task", headRef: "h", baseRef: "staging",
        state: "closed", mergedAt: null, htmlUrl: `https://github.com/acme/api/pull/${n}`, ghUpdatedAt: new Date("2026-11-04T00:00:00Z"), ...over,
      } as never);
    // the task's: its spec, merged into the epic branch, and a fix still open
    await pr({ title: "task(34): The status map", issueNumber: 40, headRef: "factory/40-the-status-map", baseRef: "factory/epic-34", mergedAt: new Date("2026-11-02T00:00:00Z") });
    await pr({ title: "fix(34): status map colours", issueNumber: 40, headRef: "factory/40-colours", baseRef: "factory/epic-34", state: "open" });
    // another task of the epic, merged; and a task of some other epic
    await pr({ title: "task(34): idle", issueNumber: 41, headRef: "factory/41-idle", baseRef: "factory/epic-34", mergedAt: new Date("2026-11-03T00:00:00Z") });
    await pr({ title: "task(99): elsewhere", issueNumber: 99, headRef: "factory/99-x", baseRef: "factory/epic-99", mergedAt: new Date("2026-11-03T00:00:00Z") });
    // the epic's own: its spec, and its release onto staging
    await pr({ title: "spec(34): booker status", kind: "spec", issueNumber: 34, headRef: "factory/34-spec", baseRef: "factory/epic-34", mergedAt: new Date("2026-10-20T00:00:00Z") });
    await pr({ title: "release(34): integrate factory/epic-34 into staging", kind: "other", issueNumber: 34, headRef: "factory/epic-34", mergedAt: new Date("2026-11-06T00:00:00Z") });
    // staging's: an older epic promoted (so not listed), the promotions (never listed: they leave staging),
    // a fix merged onto staging since, and one still open onto it
    await pr({ title: "release(35): integrate factory/epic-35 into staging", kind: "other", issueNumber: 35, headRef: "factory/epic-35", mergedAt: new Date("2026-11-01T00:00:00Z") });
    await pr({ title: "release(35): promote staging to main", kind: "promotion", headRef: "staging", baseRef: "main", mergedAt: new Date("2026-11-03T00:00:00Z") });
    await pr({ title: "release(34): promote staging to main", kind: "promotion", headRef: "staging", baseRef: "main", state: "open", ghUpdatedAt: new Date("2026-11-07T00:00:00Z") });
    await pr({ title: "Pin kombu", kind: "other", headRef: "fix/pin-kombu", mergedAt: new Date("2026-11-05T00:00:00Z") });
    await pr({ title: "Quiet hours", kind: "other", headRef: "fix/quiet-hours", state: "open", ghUpdatedAt: new Date("2026-11-07T00:00:00Z") });
    stub();
    const body = (await environments()).json();
    const brief = (c: { pulls: Array<{ number: number; state: string; title: string }> }) => c.pulls.map((p) => `${p.state} ${p.title}`);
    const task = body.lanes[0].tasks.find((t: { id: string }) => t.id === "acme/api#40");
    expect(brief(task)).toEqual(["open fix(34): status map colours", "merged task(34): The status map"]);
    expect(task.pulls[1]).toMatchObject({ number: 601, mergedAt: "2026-11-02T00:00:00.000Z", headRef: "factory/40-the-status-map", baseRef: "factory/epic-34", url: "https://github.com/acme/api/pull/601" });
    expect(brief(body.lanes[0].epic)).toEqual([
      "merged release(34): integrate factory/epic-34 into staging",
      "open fix(34): status map colours",
      "merged task(34): idle",
      "merged task(34): The status map",
      "merged spec(34): booker status",
    ]);
    const staging = body.staging.find((s: { repo: string }) => s.repo === "acme/api");
    expect(brief(staging)).toEqual([
      "open Quiet hours",
      "merged release(34): integrate factory/epic-34 into staging",
      "merged Pin kombu",
    ]);
    expect(staging.pulls.every((p: { baseRef: string }) => p.baseRef === "staging")).toBe(true);
    // a card the Console has no pull requests for says so with an empty list
    expect(body.lanes[0].tasks.find((t: { id: string }) => t.id === "acme/web#7").pulls).toEqual([]);
  });

  it("says on each remembered run which pull requests it merged, and onto which branch", async () => {
    const db = deps.dbh.db as unknown as ReturnType<typeof drizzle>;
    let n = 700;
    const pr = (title: string, baseRef: string, mergedAt: string) =>
      db.insert(pullRequests).values({
        orgId: id.org, repoId: id.apiRepo, ghNodeId: `pr${++n}`, number: n, title, kind: "other", headRef: `h${n}`, baseRef, state: "closed",
        mergedAt: new Date(mergedAt), htmlUrl: `https://github.com/acme/api/pull/${n}`, ghUpdatedAt: new Date(),
      } as never);
    // the run `old` ran 03:30–04:00: it assembled the epic, then put it onto staging; a later merge is not its
    await pr("task(34): closed", "factory/epic-34", "2026-11-06T03:40:00Z");
    await pr("release(34): integrate factory/epic-34 into staging", "staging", "2026-11-06T03:58:00Z");
    await pr("fix: something else", "staging", "2026-11-06T04:30:00Z");
    deps.cfg.ORCHESTRATOR_URL = "http://127.0.0.1:8080";
    deps.cfg.ORCHESTRATOR_DISPATCH_TOKEN = "op";
    vi.stubGlobal("fetch", async (url: string) => {
      const body = String(url).endsWith("/runs")
        ? [{ id: "old", repo: "acme/api", issue: 34, role: "release", outcome: "success", started_at: "2026-11-06T03:30:00+00:00", finished_at: "2026-11-06T04:00:00+00:00" }]
        : envs;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const body = (await environments()).json();
    const staging = body.staging.find((s: { repo: string }) => s.repo === "acme/api");
    expect(staging.notes[0].merged).toEqual([
      { number: 701, title: "task(34): closed", baseRef: "factory/epic-34", url: "https://github.com/acme/api/pull/701" },
      { number: 702, title: "release(34): integrate factory/epic-34 into staging", baseRef: "staging", url: "https://github.com/acme/api/pull/702" },
    ]);
  });

  it("names the model each run used, live and finished", async () => {
    deps.cfg.ORCHESTRATOR_URL = "http://127.0.0.1:8080";
    deps.cfg.ORCHESTRATOR_DISPATCH_TOKEN = "op";
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      const body = u.includes("/runs?active=true")
        ? [{ id: "r40", repo: "acme/api", issue: 40, role: "reviewer", started_at: "2026-11-06T05:00:00+00:00", model: "claude-sonnet-5-5" }]
        : u.endsWith("/runs")
          ? [{ id: "old", repo: "acme/api", issue: 34, role: "release", outcome: "success", model: "claude-opus-5-5", started_at: "2026-11-06T03:30:00+00:00", finished_at: "2026-11-06T04:00:00+00:00" }]
          : envs;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const body = (await environments()).json();
    expect(body.staging[0].notes[0].model).toBe("claude-opus-5-5"); // finished: from the past list
    expect(body.sessions.inUse.find((s: { runId: string }) => s.runId === "r40").model).toBe("claude-sonnet-5-5"); // live: from the active list
    expect(body.staging[0].notes[0].runId).toBe("old");
  });

  it("gives a remembered run no merges when the orchestrator no longer lists it", async () => {
    stub(); // the stub answers /runs with the environments body, which is no list of runs
    const body = (await environments()).json();
    expect(body.staging[0].notes[0].merged).toEqual([]);
  });

  it("counts every session in use but names only this org's", async () => {
    stub();
    const { sessions } = (await environments()).json();
    expect(sessions.total).toBe(4);
    expect(sessions.inUse).toHaveLength(2);
    expect(sessions.inUse[0]).toMatchObject({ role: "Reviewer", title: "The status map" });
    expect(sessions.inUse[1]).toMatchObject({ role: "Another team's run", title: null });
    expect(sessions.waiting).toEqual([expect.objectContaining({ role: "Implementer", title: "The panel" })]);
  });

  it("follows the repo focus, keeping a sibling-repo task with its epic", async () => {
    stub();
    const web = (await environments(`?repo=${id.webRepo}`)).json();
    expect(web.staging).toEqual([]);
    expect(web.lanes[0].tasks.map((t: { title: string }) => t.title)).toEqual(["The panel"]);
  });

  it("says when the orchestrator cannot list its environments", async () => {
    deps.cfg.ORCHESTRATOR_URL = "http://127.0.0.1:8080";
    deps.cfg.ORCHESTRATOR_DISPATCH_TOKEN = "op";
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    expect((await environments()).json()).toMatchObject({ available: false, lanes: [] });
  });
});
