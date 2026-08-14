import { generateKeyPairSync, randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, memberships, orgs, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * First-time sign-in: the App is not installed anywhere the user can see, so
 * /api/installations used to return []. The Console now lists the accounts and
 * repositories GitHub will let that user pick, so they can install from the UI.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const PKCS8 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
let calls: string[];
let github: Record<string, { status?: number; body: unknown }>;

const cookie = "console_session=sess-1";

const repo = (over: Partial<{ id: number; node_id: string; full_name: string; default_branch: string; private: boolean; owner: { id: number; login: string; type: string; avatar_url?: string } }>) => ({
  id: 1,
  node_id: "R_1",
  full_name: "alice/notes",
  default_branch: "main",
  private: false,
  owner: { id: 42, login: "alice", type: "User", avatar_url: "https://example/a.png" },
  ...over,
});

beforeEach(async () => {
  const pg = new PGlite();
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt.trim());
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
      env: { appId: "1", privateKeyPem: PKCS8, webhookSecret: "w", clientId: "Iv1.x", clientSecret: "s" },
    }),
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  app = await buildApp(deps);

  await deps.dbh.db.insert(users).values({
    ghUserId: 42,
    login: "alice",
    avatarUrl: "https://example/a.png",
    encryptedOauthToken: encryptSecret("gho_test", MASTER_KEY),
  });
  const user = (await deps.dbh.db.select().from(users))[0]!;
  await deps.dbh.db.insert(sessions).values({ id: "sess-1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });

  calls = [];
  github = {
    "/app": { body: { id: 1, slug: "factory-console", name: "Factory Console", html_url: "https://github.com/apps/factory-console", client_id: "Iv1.x" } },
    "/user/installations": { body: { installations: [] } },
    "/user": { body: { id: 42, login: "alice", name: "Alice", avatar_url: "https://example/a.png" } },
    "/user/repos": { body: [] },
    "/users/alice/repos": { body: [repo({})] },
    "/user/orgs": { status: 403, body: { message: "Forbidden" } },
    "/user/memberships/orgs": { status: 403, body: { message: "Forbidden" } },
    "/users/alice/orgs": { body: [{ id: 7, login: "acme", avatar_url: "https://example/o.png" }] },
    "/orgs/acme/repos": {
      body: [
        repo({
          id: 2,
          node_id: "R_2",
          full_name: "acme/api",
          owner: { id: 7, login: "acme", type: "Organization", avatar_url: "https://example/o.png" },
        }),
        repo({
          id: 3,
          node_id: "R_3",
          full_name: "acme/web",
          private: true,
          owner: { id: 7, login: "acme", type: "Organization", avatar_url: "https://example/o.png" },
        }),
      ],
    },
  };

  vi.stubGlobal("fetch", async (url: string | URL, init?: { method?: string }) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const pathname = path.split("?")[0];
    const hit =
      github[pathname] ??
      Object.entries(github).find(([k]) => pathname === k || pathname.startsWith(`${k}/`))?.[1];
    if (!hit) throw new Error(`unstubbed GitHub call: ${init?.method ?? "GET"} ${path}`);
    return new Response(hit.status === 204 ? null : JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

const list = () => app.inject({ method: "GET", url: "/api/installations", headers: { cookie } });

describe("GET /api/installations", () => {
  it("rejects an anonymous caller", async () => {
    expect((await app.inject({ method: "GET", url: "/api/installations" })).statusCode).toBe(401);
  });

  it("lists the signed-in user's accounts and repos when the App is not installed yet", async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);
    const body = res.json() as { installations: Array<{ account: string; installationId: number | null; repos: Array<{ fullName: string; id: number }>; installUrl: string | null }> };
    const byAccount = Object.fromEntries(body.installations.map((a) => [a.account, a]));

    expect(byAccount.alice).toMatchObject({
      installationId: null,
      accountType: "User",
      accountId: 42,
    });
    expect(byAccount.alice.repos.map((r) => r.fullName)).toEqual(["alice/notes"]);
    expect(byAccount.alice.installUrl).toBe("https://github.com/apps/factory-console/installations/new/permissions?target_id=42");

    expect(byAccount.acme).toMatchObject({
      installationId: null,
      accountType: "Organization",
      accountId: 7,
    });
    expect(byAccount.acme.repos.map((r) => r.fullName)).toEqual(["acme/api", "acme/web"]);
    expect(byAccount.acme.installUrl).toContain("target_id=7");
  });

  it("keeps an existing installation and merges extra repos onto it", async () => {
    github["/user/installations"] = {
      body: {
        installations: [{ id: 99, account: { id: 7, login: "acme", type: "Organization", avatar_url: "https://example/o.png" } }],
      },
    };
    github["/user/installations/99/repositories"] = {
      body: {
        repositories: [
          { id: 2, node_id: "R_2", full_name: "acme/api", default_branch: "main", private: false },
        ],
      },
    };

    const org = (await deps.dbh.db.insert(orgs).values({ name: "acme" }).returning())[0]!;
    const user = (await deps.dbh.db.select().from(users))[0]!;
    await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
    const estate = (await deps.dbh.db.insert(estates).values({ orgId: org.id, name: "acme", installationId: 99 }).returning())[0]!;
    await deps.dbh.db.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R_2", fullName: "acme/api" });

    const res = await list();
    expect(res.statusCode).toBe(200);
    const acme = res.json().installations.find((a: { account: string }) => a.account === "acme");
    expect(acme.installationId).toBe(99);
    expect(acme.estateId).toBe(estate.id);
    expect(acme.repos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fullName: "acme/api", connected: true, nodeId: "R_2" }),
        expect.objectContaining({ fullName: "acme/web", connected: false, nodeId: "R_3" }),
      ]),
    );
  });
});
