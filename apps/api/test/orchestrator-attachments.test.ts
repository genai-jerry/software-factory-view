import { randomBytes } from "node:crypto";
import { CredentialStore, loadConfig } from "@console/core";
import { estates, orgs, repos, shapeAttachments, shapeConversations, users, workAttachments } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * The orchestrator fetches the images people attached to an issue in the
 * Compass — Add work's and Shape's — behind the dispatch token, so a role's
 * run can view them. Nothing on these routes is for a browser.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const auth = { authorization: "Bearer dispatch-token" };
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
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
    ORCHESTRATOR_URL: "https://orch.invalid",
    ORCHESTRATOR_DISPATCH_TOKEN: "dispatch-token",
  } as never);
  deps = {
    cfg,
    dbh: { db, sql: null as never, close: async () => undefined },
    credentials: new CredentialStore({ masterKey: MASTER_KEY, apiUrl: "https://api.invalid", load: async () => null, env: { appId: "1", privateKeyPem: "x", webhookSecret: "s", clientId: "c", clientSecret: "cs" } }),
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  app = await buildApp(deps);

  const d = deps.dbh.db;
  const jerry = (await d.insert(users).values({ ghUserId: 1, login: "jerry" }).returning())[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const repo = (await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/app" }).returning())[0]!;
  const t0 = new Date("2026-11-01T10:00:00Z");
  const later = new Date("2026-11-01T11:00:00Z");
  // Add work: two images on issue 115, one on issue 116.
  const w1 = (await d.insert(workAttachments).values({ orgId: org.id, userId: jerry.id, repoId: repo.id, name: "shot.png", mime: "image/png", bytesB64: PNG, size: 8, issueUrl: "https://github.com/acme/app/issues/115", createdAt: t0 }).returning())[0]!;
  await d.insert(workAttachments).values({ orgId: org.id, userId: jerry.id, repoId: repo.id, name: "flow.png", mime: "image/png", bytesB64: PNG, size: 8, issueUrl: "https://github.com/acme/app/issues/115", createdAt: later });
  await d.insert(workAttachments).values({ orgId: org.id, userId: jerry.id, repoId: repo.id, name: "other.png", mime: "image/png", bytesB64: PNG, size: 8, issueUrl: "https://github.com/acme/app/issues/116", createdAt: later });
  await d.insert(workAttachments).values({ orgId: org.id, userId: jerry.id, repoId: repo.id, name: "unfiled.png", mime: "image/png", bytesB64: PNG, size: 8, issueUrl: null, createdAt: later });
  // Shape: a conversation opened as issue 115, with one image.
  const conv = (await d.insert(shapeConversations).values({ orgId: org.id, userId: jerry.id, repoId: repo.id, title: "Idea", issueUrl: "https://github.com/acme/app/issues/115" }).returning())[0]!;
  const s1 = (await d.insert(shapeAttachments).values({ orgId: org.id, conversationId: conv.id, name: "mock.png", mime: "image/webp", bytesB64: PNG, size: 8, createdAt: new Date("2026-11-01T10:30:00Z") }).returning())[0]!;
  id.w1 = w1.id;
  id.s1 = s1.id;
});

describe("GET /api/orchestrator/attachments", () => {
  it("needs the dispatch token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/orchestrator/attachments?repo=acme/app&issue=115" });
    expect(res.statusCode).toBe(401);
    const bytes = await app.inject({ method: "GET", url: `/api/orchestrator/attachments/work/${id.w1}`, headers: { authorization: "Bearer wrong" } });
    expect(bytes.statusCode).toBe(401);
  });

  it("lists the issue's images from Add work and Shape together, newest first", async () => {
    const res = await app.inject({ method: "GET", url: "/api/orchestrator/attachments?repo=acme/app&issue=115", headers: auth });
    expect(res.statusCode).toBe(200);
    const list = (res.json() as { attachments: Array<{ name: string; source: string; mime: string; url: string }> }).attachments;
    expect(list.map((a) => [a.name, a.source])).toEqual([
      ["flow.png", "work"],
      ["mock.png", "shape"],
      ["shot.png", "work"],
    ]);
    expect(list[1]).toMatchObject({ mime: "image/webp", url: `/api/orchestrator/attachments/shape/${id.s1}` });
  });

  it("serves the bytes of either kind, and 404s the rest", async () => {
    const work = await app.inject({ method: "GET", url: `/api/orchestrator/attachments/work/${id.w1}`, headers: auth });
    expect(work.statusCode).toBe(200);
    expect(work.headers["content-type"]).toBe("image/png");
    expect(work.rawPayload.toString("base64")).toBe(PNG);
    const shape = await app.inject({ method: "GET", url: `/api/orchestrator/attachments/shape/${id.s1}`, headers: auth });
    expect(shape.statusCode).toBe(200);
    expect(shape.headers["content-type"]).toBe("image/webp");
    const wrongKind = await app.inject({ method: "GET", url: `/api/orchestrator/attachments/comment/${id.w1}`, headers: auth });
    expect(wrongKind.statusCode).toBe(404);
    const unknownRepo = await app.inject({ method: "GET", url: "/api/orchestrator/attachments?repo=acme/none&issue=1", headers: auth });
    expect(unknownRepo.statusCode).toBe(404);
    const none = await app.inject({ method: "GET", url: "/api/orchestrator/attachments?repo=acme/app&issue=999", headers: auth });
    expect((none.json() as { attachments: unknown[] }).attachments).toEqual([]);
  });
});
