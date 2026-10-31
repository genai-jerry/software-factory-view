import { generateKeyPairSync } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, gateAssignments, memberships, orgs, projects, pullRequests, repos, sessions, users } from "@console/db";
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
const admin = "console_session=sess-admin";
const member = "console_session=sess-member";
const headers = (cookie: string) => ({ cookie, "x-console-csrf": "1", "content-type": "application/json" });

let app: Awaited<ReturnType<typeof buildApp>>;
let deps: AppDeps;
const id: Record<string, string> = {};

beforeEach(async () => {
  const pg = new PGlite();
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of (await readFile(join(dir, file), "utf8")).split("--> statement-breakpoint")) {
      if (stmt.trim()) await pg.exec(stmt.trim());
    }
  }
  const db = drizzle(pg);
  deps = {
    cfg: loadConfig({ CONSOLE_MASTER_KEY: MASTER_KEY, NODE_ENV: "test" } as never),
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
  const org = (await db.insert(orgs).values({ name: "acme" }).returning())[0]!;
  const person = async (ghUserId: number, login: string, role: string, sid: string) => {
    const u = (await db.insert(users).values({ ghUserId, login, encryptedOauthToken: encryptSecret("t", MASTER_KEY) }).returning())[0]!;
    await db.insert(memberships).values({ orgId: org.id, userId: u.id, role });
    await db.insert(sessions).values({ id: sid, userId: u.id, expiresAt: new Date(Date.now() + 3600_000) });
  };
  await person(1, "jerry", "owner", "sess-admin");
  await person(2, "sowmya", "member", "sess-member");
  const estate = (await db.insert(estates).values({ orgId: org.id, name: "acme", installationId: 99 }).returning())[0]!;
  const project = (await db.insert(projects).values({ orgId: org.id, name: "Beacon" }).returning())[0]!;
  const mkRepo = async (name: string, projectId: string | null) =>
    (await db.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: `r-${name}`, fullName: `acme/${name}`, projectId } as never).returning())[0]!;
  const api = await mkRepo("api", project.id);
  const other = await mkRepo("other", null);
  id.project = project.id;
  id.api = api.id;
  id.estate = estate.id;
  const assign = (repoId: string, gate: string, login: string) =>
    db.insert(gateAssignments).values({ estateId: estate.id, repoId, gate, login });
  await assign(api.id, "release", "jerry");
  // Another project in the same estate names Sowmya: that must not reach acme/api.
  await assign(other.id, "release", "sowmya");
  const mkPr = async (n: number, kind: string, baseRef: string) =>
    (
      await db
        .insert(pullRequests)
        .values({ orgId: org.id, repoId: api.id, number: n, kind, title: "t", headRef: "x", baseRef, state: "open", ghNodeId: `p${n}`, htmlUrl: "u", ghUpdatedAt: new Date() } as never)
        .returning()
    )[0]!.id;
  id.promotion = await mkPr(1, "promotion", "main");
  id.toStaging = await mkPr(2, "other", "staging");
  id.toEpic = await mkPr(3, "task", "factory/epic-34");
  app = await buildApp(deps);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

/** GitHub's contents and merge APIs, enough for these routes. */
function github(file: string | null) {
  const puts: Array<{ url: string; body: { content: string; branch: string; sha?: string } }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT" && String(url).includes("/merge")) return new Response(JSON.stringify({ sha: "abc", merged: true }));
    if (init?.method === "PUT") {
      puts.push({ url: String(url), body: JSON.parse(init.body as string) });
      return new Response("{}", { status: 200 });
    }
    if (file === null) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ content: Buffer.from(file).toString("base64"), encoding: "base64", sha: "s1" }));
  });
  return puts;
}

const merge = (prId: string, cookie: string) => app.inject({ method: "POST", url: `/api/prs/${prId}/merge`, headers: { cookie, "x-console-csrf": "1" } });
const save = (cookie: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/projects/${id.project}/permissions`, headers: headers(cookie), payload: payload as object });

describe("merging to production or staging from Compass", () => {
  it("refuses someone off the repo's production list, even if another project names them", async () => {
    github(null);
    const res = await merge(id.promotion!, member);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("production");
    expect((await merge(id.promotion!, admin)).statusCode).toBe(200);
  });

  it("holds a merge onto staging to the staging list, which falls back to production", async () => {
    github(null);
    expect((await merge(id.toStaging!, member)).statusCode).toBe(403);
    await deps.dbh.db.insert(gateAssignments).values({ estateId: id.estate!, repoId: id.api!, gate: "staging", login: "sowmya" });
    expect((await merge(id.toStaging!, member)).statusCode).toBe(200);
  });

  it("leaves a merge onto an epic branch alone", async () => {
    github(null);
    expect((await merge(id.toEpic!, member)).statusCode).toBe(200);
  });
});

describe("project release permissions", () => {
  it("shows the lists and the people to choose from", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${id.project}/permissions`, headers: { cookie: member } });
    expect(res.json()).toMatchObject({ production: ["jerry"], staging: [], mixed: false, members: ["jerry", "sowmya"], repos: ["acme/api"] });
  });

  it("commits the list to the repo's default branch, keeps the file's other keys, and enforces it at once", async () => {
    const puts = github(JSON.stringify({ spec: ["jerry"], release: ["jerry"] }));
    const res = await save(admin, { production: ["sowmya"], staging: [] });
    expect(res.json()).toMatchObject({ ok: true });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toContain("acme/api/contents/.github");
    expect(puts[0]!.body).toMatchObject({ branch: "main", sha: "s1" });
    expect(JSON.parse(Buffer.from(puts[0]!.body.content, "base64").toString())).toEqual({ spec: ["jerry"], release: ["sowmya"], staging: [] });
    expect((await merge(id.promotion!, admin)).statusCode).toBe(403);
    expect((await merge(id.promotion!, member)).statusCode).toBe(200);
  });

  it("needs an admin, at least one production approver, and real logins", async () => {
    github("{}");
    expect((await save(member, { production: ["jerry"], staging: [] })).statusCode).toBe(403);
    expect((await save(admin, { production: [], staging: ["jerry"] })).statusCode).toBe(400);
    expect((await save(admin, { production: ["not a login"], staging: [] })).statusCode).toBe(400);
  });

  it("reports a repo it could not write, and leaves that repo's list alone", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? new Response("{}", { status: 403 }) : new Response("{}", { status: 404 }));
    const res = await save(admin, { production: ["sowmya"], staging: [] });
    expect(res.json().ok).toBe(false);
    expect(res.json().results[0]).toMatchObject({ repo: "acme/api", ok: false });
    const rows = await deps.dbh.db.select().from(gateAssignments).where(eq(gateAssignments.repoId, id.api!));
    expect(rows.map((r) => r.login)).toEqual(["jerry"]);
  });
});
