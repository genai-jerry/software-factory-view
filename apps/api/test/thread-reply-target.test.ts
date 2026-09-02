import { randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, issues, memberships, orgs, repos, sessions, threads, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * Where a task thread's reply actually lands.
 *
 * A `task/<n>` thread hangs off the epic, but the comment belongs on the task
 * issue — and for a cross-repo epic (FACTORY.md §7) that issue is in another
 * repo. Resolving it inside the epic's repo posted the reply on the **epic**
 * instead, and because the comment carries the thread marker it came straight
 * back into the same thread: the Console showed it, the task issue never did,
 * and an `Approved` meant to start one task read as a gate approval on the
 * epic. Nothing in the response said so — it answered `ok: true`.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const API_URL = "https://gh.test";

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
    await d.insert(users).values({ ghUserId: 1, login: "alice", encryptedOauthToken: encryptSecret("t", MASTER_KEY) }).returning()
  )[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await d.insert(memberships).values({ orgId: org.id, userId: alice.id, role: "owner" });
  await d.insert(sessions).values({ id: "sess-1", userId: alice.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;

  const mkRepo = async (fullName: string, nodeId: string) =>
    (await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: nodeId, fullName }).returning())[0]!;
  // The estate that reproduced this: the epic in the coordination repo, the
  // task in a sibling repo, and the coordination repo carrying an unrelated
  // issue with the very number the thread names.
  const backend = await mkRepo("acme/backend", "R1");
  const ui = await mkRepo("acme/ui", "R2");

  const mkIssue = async (
    repoId: string,
    number: number,
    values: Partial<{ kind: string; parentIssueId: string; title: string }> = {},
  ) =>
    (
      await d
        .insert(issues)
        .values({
          orgId: org.id,
          repoId,
          ghNodeId: `I-${repoId}-${number}`,
          number,
          title: values.title ?? `issue ${number}`,
          kind: values.kind ?? "task",
          state: "open",
          factoryState: "factory:ready",
          parentIssueId: values.parentIssueId ?? null,
          ghUpdatedAt: new Date("2026-09-01T00:00:00Z"),
          ghCreatedAt: new Date("2026-09-01T00:00:00Z"),
          htmlUrl: `https://gh/${number}`,
        })
        .returning()
    )[0]!;

  const epic = await mkIssue(backend.id, 261, { kind: "epic", title: "epic" });
  await mkIssue(ui.id, 215, { parentIssueId: epic.id, title: "task(261): the screen" });
  // Same number, unrelated, in the epic's own repo — what the old lookup found
  // whenever it found anything at all.
  await mkIssue(backend.id, 215, { title: "something else entirely" });
  // A task of this epic with no issue row yet (the projector has not caught up).
  const mkThread = async (topicRef: string) =>
    (await d.insert(threads).values({ orgId: org.id, epicIssueId: epic.id, topicKind: "task", topicRef, title: topicRef }).returning())[0]!;
  id.taskThread = (await mkThread("task/215")).id;
  id.unprojectedThread = (await mkThread("task/999")).id;
  id.epicThread = (
    await d
      .insert(threads)
      .values({ orgId: org.id, epicIssueId: epic.id, topicKind: "gate", topicRef: "gate/design", title: "Gate G2" })
      .returning()
  )[0]!.id;
  id.epic = epic.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Record every GitHub call the route makes, and answer each one. */
function stubGitHub() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ node_id: "C1", html_url: "https://gh/c1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const post = (threadId: string, body: string) =>
  app.inject({ method: "POST", url: `/api/threads/${threadId}/entries`, headers, payload: { body } });

describe("a task thread's reply reaches the task issue", () => {
  it("posts to the task's own repo, not the epic's", async () => {
    const calls = stubGitHub();
    const res = await post(id.taskThread!, "Approved");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, posted: true });
    // acme/ui#215 — never acme/backend#261 (the epic) and never acme/backend#215
    // (an unrelated issue that merely shares the number).
    expect(calls).toEqual([`${API_URL}/repos/acme/ui/issues/215/comments`]);
  });

  it("refuses rather than posting a task reply onto the epic", async () => {
    const calls = stubGitHub();
    const res = await post(id.unprojectedThread!, "Approved");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("#999");
    expect(calls).toEqual([]);
  });

  it("still posts a non-task thread to the epic", async () => {
    const calls = stubGitHub();
    const res = await post(id.epicThread!, "looks good");
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([`${API_URL}/repos/acme/backend/issues/261/comments`]);
  });
});
