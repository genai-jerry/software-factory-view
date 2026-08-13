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
 * Projects (repo grouping) and the ?repo= / ?project= focus filter that every
 * view honours. Two repos in one org: one in a project, one outside it.
 */

const MASTER_KEY = randomBytes(32).toString("base64");

let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const cookie = "console_session=sess-1";
const memberCookie = "console_session=sess-2";
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
  const bob = (
    await d.insert(users).values({ ghUserId: 2, login: "bob", encryptedOauthToken: encryptSecret("t", MASTER_KEY) }).returning()
  )[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await d.insert(memberships).values([
    { orgId: org.id, userId: alice.id, role: "owner" },
    { orgId: org.id, userId: bob.id, role: "member" },
  ]);
  await d.insert(sessions).values([
    { id: "sess-1", userId: alice.id, expiresAt: new Date(Date.now() + 3600_000) },
    { id: "sess-2", userId: bob.id, expiresAt: new Date(Date.now() + 3600_000) },
  ]);
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const api = (
    await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/api" }).returning()
  )[0]!;
  const web = (
    await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R2", fullName: "acme/web" }).returning()
  )[0]!;

  const mk = async (repoId: string, number: number, title: string) =>
    (
      await d
        .insert(issues)
        .values({
          orgId: org.id,
          repoId,
          ghNodeId: `I${number}`,
          number,
          title,
          state: "open",
          kind: "epic",
          factoryState: "factory:intake",
          author: "alice",
          ghUpdatedAt: new Date(),
          ghCreatedAt: new Date(),
          htmlUrl: `https://gh/${number}`,
        })
        .returning()
    )[0]!;
  await mk(api.id, 1, "api epic");
  await mk(web.id, 2, "web epic");

  id.org = org.id;
  id.api = api.id;
  id.web = web.id;
});

describe("projects", () => {
  it("creates a project, assigns a repo, and lists membership", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { orgId: id.org, name: "Platform" },
    });
    expect(created.statusCode).toBe(200);
    id.project = (created.json() as { id: string }).id;

    const dupe = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { orgId: id.org, name: "Platform" },
    });
    expect(dupe.statusCode).toBe(409);

    const assigned = await app.inject({
      method: "POST",
      url: `/api/repos/${id.api}/project`,
      headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { projectId: id.project },
    });
    expect(assigned.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    const body = list.json() as {
      projects: Array<{ id: string; name: string; repos: Array<{ fullName: string }> }>;
      unassigned: Array<{ fullName: string }>;
    };
    expect(body.projects[0]!.repos.map((r) => r.fullName)).toEqual(["acme/api"]);
    expect(body.unassigned.map((r) => r.fullName)).toEqual(["acme/web"]);
  });

  it("requires an admin/owner role to create or assign", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: memberCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { orgId: id.org, name: "Nope" },
    });
    expect(create.statusCode).toBe(403);
    const assign = await app.inject({
      method: "POST",
      url: `/api/repos/${id.web}/project`,
      headers: { cookie: memberCookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { projectId: id.project },
    });
    expect(assign.statusCode).toBe(403);
  });
});

describe("focus filter", () => {
  const numbers = (body: unknown) => (body as { cards: Array<{ number: number }> }).cards.map((c) => c.number).sort();

  it("board: unfiltered shows both repos; ?repo= narrows to one", async () => {
    const all = await app.inject({ method: "GET", url: "/api/board", headers: { cookie } });
    expect(numbers(all.json())).toEqual([1, 2]);

    const oneRepo = await app.inject({ method: "GET", url: `/api/board?repo=${id.api}`, headers: { cookie } });
    expect(numbers(oneRepo.json())).toEqual([1]);
  });

  it("board: ?project= narrows to the project's repos", async () => {
    const byProject = await app.inject({ method: "GET", url: `/api/board?project=${id.project}`, headers: { cookie } });
    expect(numbers(byProject.json())).toEqual([1]);
  });

  it("a repo filter beats a project filter when both are sent", async () => {
    const both = await app.inject({
      method: "GET",
      url: `/api/board?repo=${id.web}&project=${id.project}`,
      headers: { cookie },
    });
    expect(numbers(both.json())).toEqual([2]);
  });

  it("an unknown or foreign id matches nothing rather than everything", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/board?repo=00000000-0000-0000-0000-000000000000",
      headers: { cookie },
    });
    expect(numbers(res.json())).toEqual([]);
  });

  it("my-work and flow honour the same filter", async () => {
    const mine = await app.inject({ method: "GET", url: `/api/my-work?repo=${id.api}`, headers: { cookie } });
    const mineBody = mine.json() as { mine: Array<{ number: number; repo: string }> };
    expect(mineBody.mine.map((m) => m.repo)).toEqual(["acme/api"]);

    const flow = await app.inject({ method: "GET", url: `/api/flow?repo=${id.web}`, headers: { cookie } });
    const flowBody = flow.json() as {
      estates: Array<{ milestones: Array<{ epics: Array<{ number: number }> }> }>;
    };
    const epicNumbers = flowBody.estates.flatMap((e) => e.milestones.flatMap((m) => m.epics.map((x) => x.number)));
    expect(epicNumbers).toEqual([2]);
  });

  it("deleting a project releases its repos without touching them", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: `/api/projects/${id.project}`,
      headers: { cookie, "x-console-csrf": "1" },
    });
    expect(del.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    const body = list.json() as { projects: unknown[]; unassigned: Array<{ fullName: string }> };
    expect(body.projects).toHaveLength(0);
    expect(body.unassigned.map((r) => r.fullName).sort()).toEqual(["acme/api", "acme/web"]);
  });
});
