import { randomBytes } from "node:crypto";
import { CredentialStore, loadConfig } from "@console/core";
import { auditLog, estates, issues, memberships, orgs, repos, sessions, users } from "@console/db";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * Start the role the factory should already be running on an epic: offered
 * for the states that wait on the factory (intake, planner, architect,
 * dispatch), refused while a run is live or at a state that waits on a
 * person. The dispatch goes to the orchestrator the way the profiler's does.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const ORCH = "https://orch.invalid";
let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const cookie = "console_session=sess-jerry";
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
    NODE_ENV: "test",
    GITHUB_API_URL: "https://gh.invalid",
    ORCHESTRATOR_URL: ORCH,
    ORCHESTRATOR_DISPATCH_TOKEN: "dispatch-token",
    PUBLIC_ORIGIN: "https://sf.example.com",
  } as never);
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
  const jerry = (await d.insert(users).values({ ghUserId: 1, login: "jerry" }).returning())[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await d.insert(memberships).values({ orgId: org.id, userId: jerry.id, role: "owner" });
  await d.insert(sessions).values({ id: "sess-jerry", userId: jerry.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const repo = (await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/app" }).returning())[0]!;
  id.org = org.id;
  id.repo = repo.id;
});

afterEach(() => vi.unstubAllGlobals());

async function epicAt(number: number, factoryState: string, labels: string[]) {
  const d = deps.dbh.db;
  return (
    await d
      .insert(issues)
      .values({ orgId: id.org!, repoId: id.repo!, ghNodeId: `I${number}`, number, title: `Epic ${number}`, state: "open", kind: "epic", factoryState, labels, ghUpdatedAt: new Date() })
      .returning()
  )[0]!;
}

function stubDispatch() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      if (String(url) === `${ORCH}/dispatch`) {
        return new Response(JSON.stringify({ queued: true, dispatch_id: "d-1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }),
  );
  return calls;
}

describe("POST /api/epics/:id/start", () => {
  it("starts intake on an epic sitting at factory:intake with no run, and records it", async () => {
    const epic = await epicAt(115, "factory:intake", ["factory:intake", "factory:expedite"]);
    const calls = stubDispatch();
    const res = await app.inject({ method: "POST", url: `/api/epics/${epic.id}/start`, headers, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: "intake", dispatchId: "d-1" });
    const sent = calls.find((c) => c.url === `${ORCH}/dispatch`)!;
    expect(sent.body).toMatchObject({ owner: "acme", repo: "app", role: "intake", issue: 115 });
    const audit = await deps.dbh.db.select().from(auditLog).where(eq(auditLog.action, "factory.start"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target).toBe("acme/app#115");
  });

  it("picks the role the state waits on", async () => {
    const epic = await epicAt(116, "factory:spec-approved", ["factory:spec-approved"]);
    const calls = stubDispatch();
    const res = await app.inject({ method: "POST", url: `/api/epics/${epic.id}/start`, headers, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(calls.find((c) => c.url === `${ORCH}/dispatch`)!.body).toMatchObject({ role: "planner", issue: 116 });
  });

  it("refuses while a run is live, and at a state that waits on a person", async () => {
    const live = await epicAt(117, "factory:intake", ["factory:intake", "factory:in-progress"]);
    const calls = stubDispatch();
    const busy = await app.inject({ method: "POST", url: `/api/epics/${live.id}/start`, headers, payload: {} });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toContain("already live");
    const gate = await epicAt(118, "factory:spec-ready", ["factory:spec-ready"]);
    const waits = await app.inject({ method: "POST", url: `/api/epics/${gate.id}/start`, headers, payload: {} });
    expect(waits.statusCode).toBe(409);
    expect(calls.filter((c) => c.url === `${ORCH}/dispatch`)).toHaveLength(0);
  });

  it("reports the epic's quiet time and live run on the item", async () => {
    const epic = await epicAt(119, "factory:intake", ["factory:intake"]);
    const res = await app.inject({ method: "GET", url: `/api/epics/${epic.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { epic: { inStateSince: string; running: unknown } };
    expect(typeof body.epic.inStateSince).toBe("string");
    expect(body.epic.running).toBeNull();
  });
});
