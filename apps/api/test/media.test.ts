import { randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, memberships, orgs, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * The media proxy (`/api/media/:repoId?url=`). An issue's uploaded images
 * (github.com/user-attachments/…) are served to a user with access and 404
 * for an App installation token, so the signed-in person's token must go
 * first — the proxy fetched with the installation token and every image in
 * every epic body rendered broken.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const cookie = "console_session=sess-1";
const id: Record<string, string> = {};
const ASSET = "https://github.com/user-attachments/assets/6e43d622-0bf6-47e4-8cf7-815138a1eff3";

beforeAll(async () => {
  const pg = new PGlite();
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of (await readFile(join(migrationsDir, file), "utf8")).split("--> statement-breakpoint")) {
      if (stmt.trim()) await pg.exec(stmt.trim());
    }
  }
  const db = drizzle(pg) as never;
  const cfg = loadConfig({ CONSOLE_MASTER_KEY: MASTER_KEY, GITHUB_APP_WEBHOOK_SECRET: "s", NODE_ENV: "test", GITHUB_API_URL: "https://gh.invalid" } as never);
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
  const jerry = (await d.insert(users).values({ ghUserId: 1, login: "jerry", encryptedOauthToken: encryptSecret("user-token", MASTER_KEY) }).returning())[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await d.insert(memberships).values({ orgId: org.id, userId: jerry.id, role: "owner" });
  await d.insert(sessions).values({ id: "sess-1", userId: jerry.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const repo = (await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/app" }).returning())[0]!;
  id.repo = repo.id;
});

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/media/:repoId", () => {
  it("fetches an uploaded image with the signed-in user's token", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
        seen.push(`${auth} ${url}`);
        if (auth === "Bearer user-token" && url === ASSET) {
          return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
        }
        return new Response("Not Found", { status: 404, statusText: "Not Found" });
      }),
    );
    const res = await app.inject({ method: "GET", url: `/api/media/${id.repo}?url=${encodeURIComponent(ASSET)}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(seen[0]).toBe(`Bearer user-token ${ASSET}`);
  });

  it("says what failed when no token can fetch it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404, statusText: "Not Found" })));
    const res = await app.inject({ method: "GET", url: `/api/media/${id.repo}?url=${encodeURIComponent(ASSET)}`, headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/404/);
  });

  it("refuses a host that is not GitHub media", async () => {
    const res = await app.inject({ method: "GET", url: `/api/media/${id.repo}?url=${encodeURIComponent("https://example.com/x.png")}`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });
});
