import { generateKeyPairSync, randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, memberships, orgs, repos, sessions, users, onboardingRuns } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { stubFiles } from "../src/routes/onboarding.js";
import type { AppDeps } from "../src/context.js";

/**
 * Re-running the stub step on an ALREADY enabled repo. It used to answer
 * "nothing to do" forever, which left an estate stuck on whatever config it
 * was set up with — a repo enabled before `epics` existed could never be given
 * it from the Console (FACTORY.md §6b). Now it reconciles: it opens a PR
 * carrying the keys the repo is missing, and nothing else.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const PKCS8 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
let repoId: string;
let orgId: string;
let estateId: string;
let calls: string[];
let putBodies: Array<{ path: string; content: string }>;
let routes: Array<[string, { status?: number; body: unknown }]>;

const cookie = "console_session=sess-1";
const post = () =>
  app.inject({
    method: "POST",
    url: `/api/repos/${repoId}/onboarding/stubs`,
    headers: { cookie, "x-console-csrf": "1" },
  });

const reply = (match: string, body: unknown, status = 200) => routes.unshift([match, { status, body }]);

const fileBody = (sha: string, text = "x") => ({
  content: Buffer.from(text, "utf8").toString("base64"),
  sha,
  encoding: "base64",
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

  const user = (
    await deps.dbh.db
      .insert(users)
      .values({ ghUserId: 42, login: "alice", encryptedOauthToken: encryptSecret("gho_test", MASTER_KEY) })
      .returning()
  )[0]!;
  const org = (
    await deps.dbh.db.insert(orgs).values({ name: "acme", orchestrator: "software-factory" }).returning()
  )[0]!;
  orgId = org.id;
  await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  await deps.dbh.db.insert(sessions).values({ id: "sess-1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (
    await deps.dbh.db.insert(estates).values({ orgId: org.id, name: "acme", installationId: 99 }).returning()
  )[0]!;
  estateId = estate.id;
  repoId = (
    await deps.dbh.db
      .insert(repos)
      .values({
        orgId: org.id,
        estateId: estate.id,
        ghNodeId: "R_1",
        fullName: "acme/api",
        defaultBranch: "main",
        factoryEnabled: true,
        profileSha: "p1",
      })
      .returning()
  )[0]!.id;

  calls = [];
  putBodies = [];
  routes = [
    ["POST /app/installations/99/access_tokens", { body: { token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() } }],
    ["GET /repos/acme/api/branches/main", { body: { commit: { sha: "abc123" } } }],
    ["GET /repos/acme/api/branches/factory-console%2Fsync-config", { status: 404, body: { message: "Not Found" } }],
    // Enabled: the orchestrator config already claims the repo.
    [
      "GET /repos/acme/api/contents/.github/factory-orchestrator.json",
      { body: fileBody("s0", `${JSON.stringify({ engine: "langgraph", endpoint: "", runners: { max_parallel: 4 } }, null, 2)}\n`) },
    ],
    // Set up before `epics` existed, and with a renamed integration branch.
    [
      "GET /repos/acme/api/contents/.github/factory-branches.json",
      { body: fileBody("s1", `${JSON.stringify({ staging: "develop", required: true, auto_create: true }, null, 2)}\n`) },
    ],
    // Everything else is already current: served back exactly as generated.
    ["GET /repos/acme/api/contents/", { status: 404, body: { message: "Not Found" } }],
    ["PUT /repos/acme/api/contents/", { body: { content: { sha: "new" } } }],
    ["POST /repos/acme/api/git/refs", { body: { ref: "refs/heads/factory-console/sync-config" } }],
    ["POST /repos/acme/api/pulls", { body: { number: 77, html_url: "https://github.com/acme/api/pull/77" } }],
  ];

  vi.stubGlobal("fetch", async (url: string | URL, init?: { method?: string; body?: string }) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    // Contents-API writes carry the target branch in the body, not the URL —
    // surface it in the call key so tests can tell direct deletes from
    // fallback-branch deletes.
    let branch = "";
    try {
      const parsed = init?.body ? (JSON.parse(init.body) as { branch?: string }) : null;
      if (parsed?.branch) branch = ` branch=${parsed.branch}`;
    } catch {
      /* not JSON */
    }
    const key = `${method} ${path}${branch}`;
    calls.push(key);
    if (method === "PUT" && path.includes("/contents/")) {
      const parsed = JSON.parse(init!.body!) as { content: string };
      putBodies.push({ path, content: parsed.content });
    }
    const hit = routes.find(([match]) => key.includes(match));
    if (!hit) throw new Error(`unstubbed GitHub call: ${key}`);
    const [, res] = hit;
    return new Response(res.status === 204 ? null : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

const stepRows = async () => await deps.dbh.db.select().from(onboardingRuns);

/** What the route would write for this org — the same call it makes internally. */
const generatedFiles = () =>
  stubFiles(
    { spec: [], design: [], implementation: [], testers: [], staging: [], release: [] },
    "software-factory",
    { defaultBranch: "main", stagingBranch: null },
  );
const repoRow = async () => (await deps.dbh.db.select().from(repos).where(eq(repos.id, repoId)))[0]!;

describe("stub step re-run on an enabled repo", () => {
  it("opens a sync PR for the missing policy key and leaves the repo's own values alone", async () => {
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, prNumber: 77 });

    // It branches for the sync rather than reusing the long-merged
    // enablement branch.
    expect(calls.some((c) => c.includes("POST /repos/acme/api/git/refs"))).toBe(true);
    const writes = calls.filter((c) => c.startsWith("PUT /repos/acme/api/contents/"));
    expect(writes.every((c) => c.includes("branch=factory-console/sync-config"))).toBe(true);

    // factory-branches.json is missing `epics`, so it travels...
    expect(writes.some((c) => c.includes(".github/factory-branches.json"))).toBe(true);
    // ...and the write keeps this repo's renamed integration branch.
    const body = putBodies.find((b) => b.path.includes("factory-branches.json"));
    const merged = JSON.parse(Buffer.from(body!.content, "base64").toString("utf8")) as Record<string, unknown>;
    expect(merged["epics"]).toBe(true);
    expect(merged["staging"]).toBe("develop");

    const row = (await stepRows()).find((r) => r.step === "stubs");
    expect(row?.status).toBe("ok");
    expect((row?.detail as { synced?: string[] }).synced).toContain(".github/factory-branches.json");
  });

  it("reports in-sync and opens nothing when the repo already has every key", async () => {
    reply(
      "GET /repos/acme/api/contents/.github/factory-branches.json",
      fileBody("s1", `${JSON.stringify({ staging: "develop", required: true, auto_create: true, epics: false }, null, 2)}\n`),
    );
    // Serve every other generated file back verbatim so nothing else drifts.
    for (const [path, content] of Object.entries(generatedFiles())) {
      reply(`GET /repos/acme/api/contents/${path}`, fileBody(`sha-${path}`, content));
    }

    const res = await post();
    expect(res.json()).toMatchObject({ ok: true, inSync: true });
    expect(calls.some((c) => c.startsWith("PUT /repos/acme/api/contents/"))).toBe(false);
    expect(calls.some((c) => c.includes("POST /repos/acme/api/pulls"))).toBe(false);
    // epics:false is the repo's answer, not a gap to fill.
    const row = (await stepRows()).find((r) => r.step === "stubs");
    expect((row?.detail as { inSync?: boolean }).inSync).toBe(true);
  });
});


describe("adopting system tests through the same sync", () => {
  it("carries the policy file to a repo that predates it", async () => {
    // The whole point of the additive sync: a repo enabled before system
    // tests existed has no .github/factory-testing.json at all, and the file
    // is what turns the Test Planner on. A missing file travels whole.
    const res = await post();
    expect(res.statusCode).toBe(200);
    const write = putBodies.find((b) => b.path.includes("factory-testing.json"));
    expect(write, "the policy file should be in the sync PR").toBeTruthy();
    const written = JSON.parse(Buffer.from(write!.content, "base64").toString("utf8")) as Record<string, unknown>;
    expect(written["system_tests"]).toBe(true);
    expect(written["mode"]).toBe("gate");
  });

  it("adds the Test Planner's model chain without touching a hand-tuned one", async () => {
    // A repo that has retuned its chains keeps every one of them; only the
    // role it had never heard of is added.
    reply(
      "GET /repos/acme/api/contents/.github/factory-models.json",
      fileBody("m1", `${JSON.stringify({ planner: ["claude-sonnet-5"], implementer: ["claude-sonnet-5"] }, null, 2)}\n`),
    );
    await post();
    const write = putBodies.find((b) => b.path.includes("factory-models.json"));
    const merged = JSON.parse(Buffer.from(write!.content, "base64").toString("utf8")) as Record<string, string[]>;
    expect(merged["testplanner"]).toEqual(["claude-fable-5", "claude-opus-5", "claude-sonnet-5"]);
    expect(merged["planner"]).toEqual(["claude-sonnet-5"]);
    expect(merged["implementer"]).toEqual(["claude-sonnet-5"]);
  });

  it("leaves a repo that has already answered the question alone", async () => {
    // system_tests:false is a decision, not a gap. Additive means the sync
    // must not flip it back on — and the generated `_comment` this
    // hand-written file lacks must not drag it into a PR on its own.
    for (const [path, content] of Object.entries(generatedFiles())) {
      reply(`GET /repos/acme/api/contents/${path}`, fileBody(`sha-${path}`, content));
    }
    reply(
      "GET /repos/acme/api/contents/.github/factory-testing.json",
      fileBody("t1", `${JSON.stringify({ system_tests: false, mode: "gate" }, null, 2)}\n`),
    );
    await post();
    expect(putBodies.some((b) => b.path.includes("factory-testing.json"))).toBe(false);
  });
});
