import { randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, memberships, onboardingRuns, orgs, projects, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";
import { greenfieldProfile } from "../src/routes/new-repo.js";

/**
 * A repository for a new product: created as the person, the factory's files
 * committed onto its default branch, staging cut from it, labels made, and
 * registered in a project with the factory on.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const API = "https://gh.test";
let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
let orgId = "";
let estateId = "";
let otherEstateId = "";
let calls: Array<{ method: string; path: string; body: Record<string, unknown> | null; auth: string }> = [];
let createStatus = 201;
let queued: unknown[] = [];
const admin = { cookie: "console_session=a", "x-console-csrf": "1" };

function stubGitHub() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const h = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method, path: u.pathname, body, auth: h.authorization ?? h.Authorization ?? "" });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (u.pathname === "/user") return json({ id: 1, login: "jerry", name: null, avatar_url: "" });
      if (u.pathname === "/user/installations")
        return json({ installations: [{ id: 11, account: { login: "jerry", type: "User" } }, { id: 22, account: { login: "someone", type: "User" } }] });
      if (method === "POST" && u.pathname === "/user/repos") {
        if (createStatus !== 201) return json({ message: "no" }, createStatus);
        return json({ id: 9, node_id: "R_new", full_name: "jerry/lens", default_branch: "main", html_url: "https://github.com/jerry/lens", private: true }, 201);
      }
      if (method === "GET" && u.pathname === "/repos/jerry/lens/branches/main") return json({ commit: { sha: "abc123" } });
      if (method === "PUT" && u.pathname.startsWith("/repos/jerry/lens/contents/")) return json({ content: {} }, 201);
      if (method === "POST" && u.pathname === "/repos/jerry/lens/git/refs") return json({}, 201);
      if (method === "POST" && u.pathname === "/repos/jerry/lens/labels") return json({}, 201);
      return json({ message: "Not Found" }, 404);
    }),
  );
}

beforeAll(async () => {
  process.env.NEW_REPO_POLL_MS = "1";
  const pg = new PGlite();
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of (await readFile(join(dir, file), "utf8")).split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt.trim());
  }
  const db = drizzle(pg) as never;
  const cfg = loadConfig({ CONSOLE_MASTER_KEY: MASTER_KEY, GITHUB_APP_WEBHOOK_SECRET: "s", GITHUB_API_URL: API, NODE_ENV: "test" } as never);
  const credentials = new CredentialStore({
    masterKey: MASTER_KEY,
    apiUrl: API,
    load: async () => null,
    env: { appId: "1", privateKeyPem: "x", webhookSecret: "s", clientId: "c", clientSecret: "cs" },
  });
  credentials.auth = (async () => ({ installationToken: async () => "inst-token" })) as never;
  deps = {
    cfg,
    dbh: { db, sql: null as never, close: async () => undefined },
    credentials,
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async (...a: unknown[]) => void queued.push(a) } as never,
  };
  app = await buildApp(deps);
  const d = deps.dbh.db;
  const jerry = (await d.insert(users).values({ ghUserId: 1, login: "jerry", encryptedOauthToken: encryptSecret("user-token", MASTER_KEY) }).returning())[0]!;
  const org = (await d.insert(orgs).values({ name: "genai" }).returning())[0]!;
  orgId = org.id;
  await d.insert(memberships).values({ orgId, userId: jerry.id, role: "owner" });
  await d.insert(sessions).values({ id: "a", userId: jerry.id, expiresAt: new Date(Date.now() + 3600_000) });
  estateId = (await d.insert(estates).values({ orgId, name: "jerry", installationId: 11 }).returning())[0]!.id;
  otherEstateId = (await d.insert(estates).values({ orgId, name: "someone", installationId: 22 }).returning())[0]!.id;
});

beforeEach(() => {
  createStatus = 201;
  queued = [];
  stubGitHub();
});
afterEach(() => vi.unstubAllGlobals());

const create = (body: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/orgs/${orgId}/repos`, headers: admin, payload: body });

describe("creating a repository for a new product", () => {
  it("lists where it can go: your own account, not someone else's", async () => {
    const got = (await app.inject({ method: "GET", url: `/api/orgs/${orgId}/repo-homes`, headers: admin })).json();
    expect(got.accounts).toEqual([
      { estateId, login: "jerry", type: "User", canCreate: true },
      { estateId: otherEstateId, login: "someone", type: "User", canCreate: false },
    ]);
  });

  it("creates it as you, commits the factory files, cuts staging, makes labels, and turns the factory on in a project", async () => {
    const res = await create({ estateId, name: "lens", description: "Translate text from the camera", projectName: "Lens" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fullName: "jerry/lens", setUp: true });

    const made = calls.find((c) => c.method === "POST" && c.path === "/user/repos")!;
    expect(made.body).toMatchObject({ name: "lens", private: true, auto_init: true });
    expect(made.auth).toContain("user-token");

    const files = calls.filter((c) => c.method === "PUT").map((c) => decodeURIComponent(c.path.replace("/repos/jerry/lens/contents/", "")));
    expect(files).toEqual(expect.arrayContaining([".github/factory-orchestrator.json", ".github/factory-approvers.json", ".factory/profile.json"]));
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.every((c) => c.body!.branch === "main" && c.auth.includes("inst-token"))).toBe(true);
    const profile = JSON.parse(Buffer.from(String(puts.find((c) => c.path.endsWith("profile.json"))!.body!.content), "base64").toString());
    expect(profile).toMatchObject({ repo: "jerry/lens", commands: { test: null, build: null, lint: null } });
    const approvers = JSON.parse(Buffer.from(String(puts.find((c) => c.path.endsWith("factory-approvers.json"))!.body!.content), "base64").toString());
    expect(approvers.spec).toEqual(["jerry"]); // no approvers set yet: the person who made it

    const staging = calls.find((c) => c.method === "POST" && c.path === "/repos/jerry/lens/git/refs")!;
    expect(staging.body).toEqual({ ref: "refs/heads/staging", sha: "abc123" });
    // Files first, then staging, so staging carries them.
    expect(calls.indexOf(staging)).toBeGreaterThan(calls.lastIndexOf(puts.at(-1)!));
    expect(calls.filter((c) => c.path === "/repos/jerry/lens/labels").length).toBeGreaterThan(5);

    const repo = (await deps.dbh.db.select().from(repos).where(eq(repos.fullName, "jerry/lens")))[0]!;
    expect(repo.factoryEnabled).toBe(true);
    const project = (await deps.dbh.db.select().from(projects).where(eq(projects.id, repo.projectId!)))[0]!;
    expect(project.name).toBe("Lens");
    const steps = (await deps.dbh.db.select().from(onboardingRuns).where(eq(onboardingRuns.repoId, repo.id))).map((s) => `${s.step}:${s.status}`);
    expect(steps.sort()).toEqual(["labels:ok", "profile:ok", "stubs:ok"]);
    expect(queued).toHaveLength(1); // OpenSpec's scaffold, merged as soon as it opens
    expect((queued[0] as unknown[])[1]).toMatchObject({ repoId: repo.id, autoMerge: true });
  });

  it("refuses someone else's personal account, and a bad name", async () => {
    expect((await create({ estateId: otherEstateId, name: "lens" })).statusCode).toBe(403);
    expect((await create({ estateId, name: "no spaces" })).statusCode).toBe(400);
    expect(calls.some((c) => c.path === "/user/repos")).toBe(false);
  });

  it("says what to do when the App lacks the permission, and when the name is taken", async () => {
    createStatus = 403;
    expect((await create({ estateId, name: "lens2" })).json().error).toMatch(/Administration \(read and write\) permission/);
    createStatus = 422;
    expect((await create({ estateId, name: "lens2" })).json().error).toMatch(/already exists/);
  });
});

it("writes a valid profile for a repository with no code", () => {
  const p = JSON.parse(greenfieldProfile("jerry/lens", "", null, "main"));
  expect(Object.keys(p)).toEqual(expect.arrayContaining(["repo", "stack", "branches", "commands"]));
  expect(p.branches).toEqual({ default: "main", staging: null });
});
