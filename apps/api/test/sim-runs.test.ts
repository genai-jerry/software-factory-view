import { generateKeyPairSync } from "node:crypto";
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

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const PKCS8 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const cookie = "console_session=sess-1";
const headers = { cookie, "x-console-csrf": "1", "content-type": "application/json" };

let app: Awaited<ReturnType<typeof buildApp>>;
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
  const deps: AppDeps = {
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
  const mkRepo = async (name: string, over: Record<string, unknown> = {}) =>
    (
      await db
        .insert(repos)
        .values({ orgId: org.id, estateId: estate.id, ghNodeId: `r-${name}`, fullName: `acme/${name}`, ...over } as never)
        .returning()
    )[0]!;
  id.api = (await mkRepo("api", { stagingBranch: "staging", systemTests: true })).id;
  id.connectors = (await mkRepo("connectors", { systemTests: true })).id;
  id.web = (await mkRepo("web", { systemTests: true })).id;
  // A repo whose file says tests are off is never read.
  id.off = (await mkRepo("off", { systemTests: false })).id;
  app = await buildApp(deps);
});

afterEach(() => vi.unstubAllGlobals());

const testingFile = (body: unknown) => ({
  content: Buffer.from(JSON.stringify(body)).toString("base64"),
  encoding: "base64",
  sha: "f1",
});
const SIMULATE = { simulate: { run_repo: "acme/infra", status_context: "acme/sim-scenarios" }, system_tests: true };

type Answer = { status: number; body?: unknown };
/** Answer GitHub by method + path; anything unlisted is a 404. Records every call. */
function stubGitHub(routes: Record<string, Answer>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      const path = new URL(String(url)).pathname;
      calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
      const hit = routes[`${method} ${path}`] ?? { status: 404, body: { message: "Not Found" } };
      return new Response(hit.body === undefined ? null : JSON.stringify(hit.body), {
        status: hit.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const BASE: Record<string, Answer> = {
  "GET /repos/acme/api/contents/.github/factory-testing.json": { status: 200, body: testingFile(SIMULATE) },
  "GET /repos/acme/connectors/contents/.github/factory-testing.json": { status: 200, body: testingFile(SIMULATE) },
  "GET /repos/acme/web/contents/.github/factory-testing.json": { status: 200, body: testingFile({ system_tests: true }) },
  "GET /repos/acme/infra": { status: 200, body: { default_branch: "main", full_name: "acme/infra" } },
  "GET /repos/acme/api/commits/staging/status": {
    status: 200,
    body: {
      sha: "abc123",
      statuses: [
        { context: "ci", state: "success", description: "ok", target_url: null },
        {
          context: "acme/sim-scenarios",
          state: "failure",
          description: "2 of 37 scenarios failed: a, b",
          target_url: "https://github.com/acme/infra/actions/runs/9",
        },
      ],
    },
  },
};

describe("GET /api/sim-runs", () => {
  it("lists each repo with a simulate block, its run repo's mode and the latest run on its staging head", async () => {
    const calls = stubGitHub({ ...BASE, "GET /repos/acme/infra/actions/variables/SIM_SCENARIOS": { status: 200, body: { value: "manual" } } });
    const res = await app.inject({ method: "GET", url: "/api/sim-runs", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { sims } = res.json() as { sims: Array<Record<string, unknown>> };
    expect(sims.map((s) => s.repo)).toEqual(["acme/api", "acme/connectors"]);
    expect(sims[0]).toEqual({
      repo: "acme/api",
      runRepo: "acme/infra",
      statusContext: "acme/sim-scenarios",
      mode: "manual",
      reason: null,
      latest: {
        state: "failure",
        description: "2 of 37 scenarios failed: a, b",
        url: "https://github.com/acme/infra/actions/runs/9",
        sha: "abc123",
      },
    });
    // A repo with no recorded staging branch is read at `staging`; it has no status yet.
    expect(sims[1]).toMatchObject({ repo: "acme/connectors", mode: "manual", latest: null });
    expect(calls.some((c) => c.path.startsWith("/repos/acme/off/"))).toBe(false);
    // The variable is read once per run repo, not once per service.
    expect(calls.filter((c) => c.path.endsWith("/variables/SIM_SCENARIOS"))).toHaveLength(1);
  });

  it("reads no variable as automatic", async () => {
    stubGitHub(BASE);
    const res = await app.inject({ method: "GET", url: `/api/sim-runs?repo=${id.api}`, headers: { cookie } });
    const { sims } = res.json() as { sims: Array<Record<string, unknown>> };
    expect(sims).toHaveLength(1);
    expect(sims[0]).toMatchObject({ repo: "acme/api", mode: "automatic", reason: null });
  });

  it("answers a refused read with no mode and the reason, rather than failing the page", async () => {
    stubGitHub({
      ...BASE,
      "GET /repos/acme/infra/actions/variables/SIM_SCENARIOS": {
        status: 403,
        body: { message: "Resource not accessible by integration" },
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/sim-runs", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const sim = (res.json() as { sims: Array<{ mode: unknown; reason: string }> }).sims[0]!;
    expect(sim.mode).toBeNull();
    expect(sim.reason).toContain("Resource not accessible by integration");
    expect(sim.reason).toContain("Variables: write and Actions: write on acme/infra");
  });

  it("does not call a run repo it cannot see automatic", async () => {
    const routes = { ...BASE };
    delete routes["GET /repos/acme/infra"];
    stubGitHub(routes);
    const res = await app.inject({ method: "GET", url: "/api/sim-runs", headers: { cookie } });
    const sim = (res.json() as { sims: Array<{ mode: unknown; reason: string }> }).sims[0]!;
    expect(sim.mode).toBeNull();
    expect(sim.reason).toContain("acme/infra");
  });
});

describe("POST /api/sim-runs/mode", () => {
  it("sets SIM_SCENARIOS=manual, creating it when it does not exist", async () => {
    const calls = stubGitHub({ ...BASE, "POST /repos/acme/infra/actions/variables": { status: 201, body: {} } });
    const res = await app.inject({
      method: "POST", url: "/api/sim-runs/mode", headers, payload: { runRepo: "acme/infra", mode: "manual" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runRepo: "acme/infra", mode: "manual" });
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /repos/acme/infra/actions/variables/SIM_SCENARIOS",
      "POST /repos/acme/infra/actions/variables",
    ]);
    expect(writes[1]!.body).toEqual({ name: "SIM_SCENARIOS", value: "manual" });
  });

  it("goes back to automatic by deleting the variable", async () => {
    const calls = stubGitHub({ ...BASE, "DELETE /repos/acme/infra/actions/variables/SIM_SCENARIOS": { status: 204 } });
    const res = await app.inject({
      method: "POST", url: "/api/sim-runs/mode", headers, payload: { runRepo: "acme/infra", mode: "automatic" },
    });
    expect(res.statusCode).toBe(200);
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("refuses a run repo no repo of the user's names", async () => {
    const calls = stubGitHub(BASE);
    const res = await app.inject({
      method: "POST", url: "/api/sim-runs/mode", headers, payload: { runRepo: "evil/infra", mode: "manual" },
    });
    expect(res.statusCode).toBe(404);
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("refuses a mode it does not know", async () => {
    stubGitHub(BASE);
    const res = await app.inject({ method: "POST", url: "/api/sim-runs/mode", headers, payload: { runRepo: "acme/infra", mode: "off" } });
    expect(res.statusCode).toBe(400);
  });

  it("says which permissions are missing when GitHub refuses the write", async () => {
    stubGitHub({
      ...BASE,
      "PATCH /repos/acme/infra/actions/variables/SIM_SCENARIOS": { status: 403, body: { message: "Resource not accessible by integration" } },
    });
    const res = await app.inject({
      method: "POST", url: "/api/sim-runs/mode", headers, payload: { runRepo: "acme/infra", mode: "manual" },
    });
    expect(res.statusCode).toBe(403);
    const { error } = res.json() as { error: string };
    expect(error).toContain("Resource not accessible by integration");
    expect(error).toContain("Variables: write and Actions: write on acme/infra");
    expect(error).toContain("your own write access");
  });
});

describe("POST /api/sim-runs/run", () => {
  it("dispatches sim-scenarios.yml on the run repo's default branch with no inputs", async () => {
    const calls = stubGitHub({
      ...BASE,
      "POST /repos/acme/infra/actions/workflows/sim-scenarios.yml/dispatches": { status: 204 },
    });
    const res = await app.inject({ method: "POST", url: "/api/sim-runs/run", headers, payload: { runRepo: "acme/infra" } });
    expect(res.statusCode).toBe(200);
    const dispatch = calls.find((c) => c.method === "POST")!;
    expect(dispatch.path).toBe("/repos/acme/infra/actions/workflows/sim-scenarios.yml/dispatches");
    expect(dispatch.body).toEqual({ ref: "main", inputs: {} });
  });

  it("says which permissions are missing when GitHub refuses the dispatch", async () => {
    stubGitHub(BASE); // the dispatch answers 404
    const res = await app.inject({ method: "POST", url: "/api/sim-runs/run", headers, payload: { runRepo: "acme/infra" } });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toContain("Actions: write on acme/infra");
  });

  it("refuses a run repo no repo of the user's names", async () => {
    const calls = stubGitHub(BASE);
    const res = await app.inject({ method: "POST", url: "/api/sim-runs/run", headers, payload: { runRepo: "acme/web" } });
    expect(res.statusCode).toBe(404);
    expect(calls.some((c) => c.path.includes("/dispatches"))).toBe(false);
  });
});
