import { randomBytes } from "node:crypto";
import { CredentialStore, decryptSecret, encryptSecret, loadConfig } from "@console/core";
import {
  changeArtifacts,
  changes,
  estates,
  issues,
  memberships,
  orgs,
  repos,
  sessions,
  threadEntries,
  threads,
  users,
} from "@console/db";
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
 * The G1/G2 approve control (spec 06 §4): the panel and the guard must agree on
 * what counts as an open question, and a GitHub refusal must come back as
 * GitHub's answer rather than an anonymous 500 — a click that posts nothing and
 * says nothing is the one failure mode the gate panel cannot have.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const API_URL = "https://gh.test";

let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const cookie = "console_session=sess-1";
const id: Record<string, string> = {};

const headers = { cookie, "x-console-csrf": "1", "content-type": "application/json" };

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

  // An epic holding at G1 — the spec gate.
  const epic = (
    await d
      .insert(issues)
      .values({
        orgId: org.id,
        repoId: repo.id,
        ghNodeId: "I1",
        number: 1,
        title: "epic",
        kind: "epic",
        state: "open",
        factoryState: "factory:spec-ready",
        ghUpdatedAt: new Date("2026-08-10T00:00:00Z"),
        ghCreatedAt: new Date("2026-08-01T00:00:00Z"),
        htmlUrl: "https://gh/1",
      })
      .returning()
  )[0]!;

  // The change's artifacts: the spec gate is about proposal + spec; design and
  // tasks belong to the later G2.
  const change = (
    await d.insert(changes).values({ orgId: org.id, estateId: estate.id, epicIssueId: epic.id, slug: "add-thing" }).returning()
  )[0]!;
  for (const kind of ["proposal", "spec", "design", "tasks"]) {
    await d
      .insert(changeArtifacts)
      .values({ orgId: org.id, changeId: change.id, repoId: repo.id, kind, path: `openspec/changes/add-thing/${kind}.md` });
  }

  const mkThread = async (topicKind: string, topicRef: string, title: string) =>
    (await d.insert(threads).values({ orgId: org.id, epicIssueId: epic.id, topicKind, topicRef, title }).returning())[0]!;
  id.proposalThread = (await mkThread("artifact", "artifact/proposal", "Proposal")).id;
  id.designThread = (await mkThread("artifact", "artifact/design", "Design")).id;
  id.org = org.id;
  id.epic = epic.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answer the one POST .../comments call the approve route makes. */
function stubGitHub(status: number, body: unknown) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const approve = (payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/epics/${id.epic}/gate/approve`, headers, payload });

describe("the gate panel and the approve guard agree on open questions", () => {
  it("ignores a question on an artifact belonging to a later gate", async () => {
    // A question on the design doc while the epic holds at G1. The panel does
    // not list it, so the panel offers no acknowledgement — the guard must not
    // block on it either, or approve fails with no reachable way to proceed.
    await deps.dbh.db
      .insert(threadEntries)
      .values({ orgId: id.org!, threadId: id.designThread!, source: "console_note", body: "later", author: "alice" });

    const panel = await app.inject({ method: "GET", url: `/api/epics/${id.epic}/gate`, headers: { cookie } });
    expect(panel.statusCode).toBe(200);
    expect(panel.json().openQuestions).toEqual([]);

    const calls = stubGitHub(201, { node_id: "C1", html_url: "https://gh/1#c1" });
    const res = await approve();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, commentUrl: "https://gh/1#c1" });
    expect(calls).toEqual([`${API_URL}/repos/acme/app/issues/1/comments`]);
  });

  it("blocks on a question the panel does list, and says how many", async () => {
    await deps.dbh.db
      .insert(threadEntries)
      .values({ orgId: id.org!, threadId: id.proposalThread!, source: "console_note", body: "why?", author: "alice" });

    const panel = await app.inject({ method: "GET", url: `/api/epics/${id.epic}/gate`, headers: { cookie } });
    expect(panel.json().openQuestions).toMatchObject([{ topicRef: "artifact/proposal", entryCount: 1 }]);

    const calls = stubGitHub(201, { node_id: "C2", html_url: "https://gh/1#c2" });
    const blocked = await approve();
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().openQuestionCount).toBe(1);
    expect(calls).toEqual([]); // nothing posted

    const acked = await approve({ acknowledgeOpenQuestions: true });
    expect(acked.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe("a GitHub refusal reaches the caller", () => {
  it("reports GitHub's own message instead of a bare 500", async () => {
    stubGitHub(403, { message: "Resource not accessible by integration" });
    const res = await approve({ acknowledgeOpenQuestions: true });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("Resource not accessible by integration");
  });

  it("401s when the user has no OAuth token on file", async () => {
    await deps.dbh.db.update(users).set({ encryptedOauthToken: null }).where(eq(users.login, "alice"));
    const res = await approve({ acknowledgeOpenQuestions: true });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain("sign in again");
    expect(res.json().reauth).toBe(true);
  });

  it("renews an expired authorization mid-approval rather than refusing it", async () => {
    // The failure this replaces: a GitHub App that expires user tokens leaves
    // an 8-hour-old session posting nothing and saying "sign out and back in".
    await deps.dbh.db
      .update(users)
      .set({
        encryptedOauthToken: encryptSecret("ghu_expired", MASTER_KEY),
        encryptedOauthRefreshToken: encryptSecret("ghr_1", MASTER_KEY),
        oauthTokenExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(users.login, "alice"));

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(String(url));
        if (String(url).endsWith("/login/oauth/access_token")) {
          return new Response(
            JSON.stringify({ access_token: "ghu_fresh", expires_in: 28_800, refresh_token: "ghr_2" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // The comment must go out on the renewed token, not the dead one.
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghu_fresh");
        return new Response(JSON.stringify({ node_id: "C3", html_url: "https://gh/1#c3" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const res = await approve({ acknowledgeOpenQuestions: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, commentUrl: "https://gh/1#c3" });
    expect(calls).toEqual([
      "https://github.com/login/oauth/access_token",
      `${API_URL}/repos/acme/app/issues/1/comments`,
    ]);

    // The rotated grant is on the row, so tomorrow's session renews too.
    const row = (await deps.dbh.db.select().from(users).where(eq(users.login, "alice")).limit(1))[0]!;
    expect(decryptSecret(row.encryptedOauthRefreshToken!, MASTER_KEY)).toBe("ghr_2");
  });
});
