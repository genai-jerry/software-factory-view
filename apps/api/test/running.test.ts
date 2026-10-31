import { generateKeyPairSync } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, issues, memberships, orgs, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
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
  id.webRepo = web.id;
  app = await buildApp(deps);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

const get = async (qs = "") =>
  app.inject({ method: "GET", url: `/api/running${qs}`, headers: { cookie } });

describe("GET /api/running", () => {
  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/running" })).statusCode).toBe(401);
  });

  it("lists running tasks and epics with their role, and leaves out everything else", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const items = res.json().running as Array<Record<string, unknown>>;
    const byNumber = Object.fromEntries(items.map((i) => [`${i.repo}#${i.number}`, i]));
    expect(Object.keys(byNumber).sort()).toEqual(["acme/api#34", "acme/api#40", "acme/web#7"]);
    expect(byNumber["acme/api#34"]).toMatchObject({ kind: "epic", role: "Dispatcher", epicId: id.epic, epicNumber: 34 });
    expect(byNumber["acme/api#40"]).toMatchObject({
      kind: "task", role: "Reviewer", title: "The status map", epicId: id.epic, epicNumber: 34, epicTitle: "Booker status",
    });
    // A task in a sibling repo points at its epic in the first.
    expect(byNumber["acme/web#7"]).toMatchObject({ role: "Implementer", epicId: id.epic, epicNumber: 34 });
  });

  it("follows the repo filter, counting a task in a sibling repo with its epic", async () => {
    // Focused on acme/api, the epic's task in acme/web still shows: the epic
    // is waiting on it. Focused on acme/web alone, that task is its own repo's.
    const apiFocus = (await get(`?repo=${id.apiRepo}`)).json().running as Array<{ repo: string; number: number }>;
    expect(apiFocus.map((i) => `${i.repo}#${i.number}`).sort()).toEqual(["acme/api#34", "acme/api#40", "acme/web#7"]);
    const webFocus = (await get(`?repo=${id.webRepo}`)).json().running as Array<{ repo: string }>;
    expect(webFocus.map((i) => i.repo)).toEqual(["acme/web"]);
    expect((await get("?repo=00000000-0000-0000-0000-000000000000")).json()).toEqual({ running: [] });
  });

  it("names the live run and the role the orchestrator reports", async () => {
    deps.cfg.ORCHESTRATOR_URL = "http://127.0.0.1:8080";
    deps.cfg.ORCHESTRATOR_DISPATCH_TOKEN = "op";
    vi.stubGlobal("fetch", async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8080/runs?active=true");
      return new Response(
        JSON.stringify([
          { id: "old", repo: "acme/web", issue: 7, role: "implementer", started_at: "2026-10-30 10:00:00" },
          { id: "new", repo: "acme/web", issue: 7, role: "reviewer", started_at: "2026-10-30 11:00:00" },
          { id: "r40", repo: "acme/api", issue: 40, role: "qa", started_at: "2026-10-30 11:30:00" },
        ]),
        { status: 200 },
      );
    });
    const items = (await get()).json().running as Array<{ repo: string; number: number; role: string; runId: string | null }>;
    const by = Object.fromEntries(items.map((i) => [`${i.repo}#${i.number}`, i]));
    expect(by["acme/web#7"]).toMatchObject({ runId: "new", role: "Reviewer" }); // the newest run, in the orchestrator's word
    expect(by["acme/api#40"]).toMatchObject({ runId: "r40", role: "QA" });
    expect(by["acme/api#34"]).toMatchObject({ runId: null, role: "Dispatcher" }); // no run listed: the stage's guess
  });
});

describe("GET /api/runs/recent", () => {
  const stubRuns = () => {
    deps.cfg.ORCHESTRATOR_URL = "http://127.0.0.1:8080";
    deps.cfg.ORCHESTRATOR_DISPATCH_TOKEN = "op";
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify([
          { id: "live", repo: "acme/api", issue: 40, role: "qa", outcome: "running", started_at: "2026-10-30 11:50:00", finished_at: null },
          { id: "r1", repo: "acme/api", issue: 40, role: "reviewer", outcome: "success", model: "claude-sonnet-5-5", has_log: true,
            started_at: "2026-10-30 11:00:00.123456", finished_at: "2026-10-30 11:04:12.5" },
          { id: "r2", repo: "acme/web", issue: 7, role: "implementer", outcome: "error", has_log: false,
            error: "Claude usage limit reached:   \"You've hit your session limit\"", started_at: "2026-10-30 10:00:00", finished_at: "2026-10-30 10:00:45" },
          { id: "r3", repo: "acme/api", issue: 34, role: "dispatch", outcome: "timeout", started_at: "2026-10-30 09:00:00", finished_at: "2026-10-30 09:45:00" },
          { id: "other", repo: "someone/else", issue: 1, role: "qa", outcome: "success", started_at: "2026-10-30 08:00:00", finished_at: "2026-10-30 08:01:00" },
        ]),
        { status: 200 },
      ),
    );
  };
  const recent = async (qs = "") => app.inject({ method: "GET", url: `/api/runs/recent${qs}`, headers: { cookie } });

  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/runs/recent" })).statusCode).toBe(401);
  });

  it("lists finished runs on this org's repos, with what they were on and how they ended", async () => {
    stubRuns();
    const body = (await recent()).json() as { runs: Array<Record<string, unknown>>; hasMore: boolean };
    // The live run and another tenant's repo are left out.
    expect(body.runs.map((r) => r.runId)).toEqual(["r1", "r2", "r3"]);
    expect(body.hasMore).toBe(false);
    expect(body.runs[0]).toMatchObject({
      repo: "acme/api", number: 40, title: "The status map", role: "Reviewer", outcome: "success",
      seconds: 252, model: "claude-sonnet-5-5", hasLog: true, epicId: id.epic, epicNumber: 34,
    });
    expect(body.runs[0]!.startedAt).toBe("2026-10-30T11:00:00.123Z");
    expect(body.runs[1]).toMatchObject({ role: "Implementer", outcome: "error", hasLog: false, seconds: 45 });
    expect(body.runs[1]!.error).toBe('Claude usage limit reached: "You\'ve hit your session limit"');
    expect(body.runs[2]).toMatchObject({ kind: "epic", role: "Dispatcher", outcome: "timeout" });
  });

  it("shows ten at a time, and says when there are more", async () => {
    stubRuns();
    const page = (await recent("?limit=2")).json() as { runs: unknown[]; hasMore: boolean };
    expect(page.runs).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(((await recent("?limit=0")).json() as { runs: unknown[] }).runs).toHaveLength(3); // bad limit: the default of 10
  });

  it("follows the repo focus, counting a sibling-repo task with its epic", async () => {
    stubRuns();
    const apiFocus = (await recent(`?repo=${id.apiRepo}`)).json().runs as Array<{ runId: string }>;
    expect(apiFocus.map((r) => r.runId)).toEqual(["r1", "r2", "r3"]); // r2 is acme/web#7, a task of the acme/api epic
    const webFocus = (await recent(`?repo=${id.webRepo}`)).json().runs as Array<{ runId: string }>;
    expect(webFocus.map((r) => r.runId)).toEqual(["r2"]);
  });

  it("shows nothing when the orchestrator cannot be reached", async () => {
    deps.cfg.ORCHESTRATOR_URL = "http://127.0.0.1:8080";
    deps.cfg.ORCHESTRATOR_DISPATCH_TOKEN = "op";
    vi.stubGlobal("fetch", async () => { throw new Error("down"); });
    expect((await recent()).json()).toEqual({ runs: [], hasMore: false });
  });
});
