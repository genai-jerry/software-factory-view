import { generateKeyPairSync } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, issues, memberships, orgs, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  app = await buildApp(deps);
});

afterEach(async () => {
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

  it("follows the repo filter", async () => {
    const only = (await get(`?repo=${id.apiRepo}`)).json().running as Array<{ repo: string }>;
    expect(only.length).toBe(2);
    expect(only.every((i) => i.repo === "acme/api")).toBe(true);
    expect((await get("?repo=00000000-0000-0000-0000-000000000000")).json()).toEqual({ running: [] });
  });
});
