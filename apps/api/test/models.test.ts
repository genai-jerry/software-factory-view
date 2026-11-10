import { randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { estates, memberships, orchestratorSecrets, orgs, projects, repos, sessions, users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";
import { forgetListedModels } from "../src/claude-models.js";
import { askModels, checkChains, expandChains } from "../src/model-settings.js";

/**
 * Compass → Models: the org sets a chain per phase, a project overrides any
 * phase, and the orchestrator reads the merged chains for a repository.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const DISPATCH = "dispatch-secret";
let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const id: Record<string, string> = {};
const owner = { cookie: "console_session=o", "x-console-csrf": "1", "content-type": "application/json" };
const member = { cookie: "console_session=m", "x-console-csrf": "1", "content-type": "application/json" };

beforeAll(async () => {
  process.env.ORCHESTRATOR_DISPATCH_TOKEN = DISPATCH;
  const pg = new PGlite();
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of (await readFile(join(dir, f), "utf8")).split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt.trim());
  }
  const db = drizzle(pg) as never;
  deps = {
    cfg: loadConfig({ CONSOLE_MASTER_KEY: MASTER_KEY, GITHUB_APP_WEBHOOK_SECRET: "s", NODE_ENV: "test", ORCHESTRATOR_DISPATCH_TOKEN: DISPATCH } as never),
    dbh: { db, sql: null as never, close: async () => undefined },
    credentials: new CredentialStore({
      masterKey: MASTER_KEY,
      apiUrl: "https://gh.test",
      load: async () => null,
      env: { appId: "1", privateKeyPem: "x", webhookSecret: "s", clientId: "c", clientSecret: "cs" },
    }),
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  app = await buildApp(deps);
  const d = deps.dbh.db;
  const o = (await d.insert(users).values({ ghUserId: 1, login: "jerry", encryptedOauthToken: encryptSecret("t", MASTER_KEY) }).returning())[0]!;
  const m = (await d.insert(users).values({ ghUserId: 2, login: "sam", encryptedOauthToken: encryptSecret("t", MASTER_KEY) }).returning())[0]!;
  const org = (await d.insert(orgs).values({ name: "genai" }).returning())[0]!;
  id.org = org.id;
  await d.insert(memberships).values([
    { orgId: org.id, userId: o.id, role: "owner" },
    { orgId: org.id, userId: m.id, role: "member" },
  ]);
  await d.insert(sessions).values([
    { id: "o", userId: o.id, expiresAt: new Date(Date.now() + 3600_000) },
    { id: "m", userId: m.id, expiresAt: new Date(Date.now() + 3600_000) },
  ]);
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "genai", installationId: 1 }).returning())[0]!;
  id.beacon = (await d.insert(projects).values({ orgId: org.id, name: "Beacon" }).returning())[0]!.id;
  id.lens = (await d.insert(projects).values({ orgId: org.id, name: "Lens" }).returning())[0]!.id;
  await d.insert(repos).values([
    { orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "genai/beacon-api", projectId: id.beacon, factoryEnabled: true },
    { orgId: org.id, estateId: estate.id, ghNodeId: "R2", fullName: "genai/lens", projectId: id.lens, factoryEnabled: true },
  ]);
});

const put = (scope: string, chains: unknown, headers = owner) =>
  app.inject({ method: "PUT", url: `/api/orgs/${id.org}/models/${scope}`, headers, payload: { chains } });
const pulled = async (repo: string) =>
  app.inject({ method: "GET", url: `/api/orchestrator/models?repo=${encodeURIComponent(repo)}`, headers: { authorization: `Bearer ${DISPATCH}` } });

describe("Compass → Models", () => {
  it("lists the phases and what is set, to anyone in the org; only an admin changes it", async () => {
    const got = (await app.inject({ method: "GET", url: `/api/orgs/${id.org}/models`, headers: member })).json();
    expect(got.canEdit).toBe(false);
    expect(got.phases.map((p: { id: string }) => p.id)).toEqual(["talk", "clarify", "design", "build", "test", "release", "fastlane", "support"]);
    const design = got.phases.find((p: { id: string }) => p.id === "design");
    expect(design.steps.map((s: { key: string }) => s.key)).toEqual(["planner", "architect", "testplanner"]);
    expect(got.projects.map((p: { name: string }) => p.name)).toEqual(["Beacon", "Lens"]);
    expect((await put("org", { implementer: ["claude-opus-5-5"] }, member)).statusCode).toBe(403);
  });

  it("merges the org's chains with a project's, phase by phase, for the orchestrator", async () => {
    expect((await put("org", { implementer: ["claude-opus-5-5", "claude-sonnet-5-5"], reviewer: ["claude-sonnet-5-5"], shape: ["claude-opus-5-5"] })).statusCode).toBe(200);
    expect((await put(id.beacon!, { implementer: ["claude-fable-5-1"] })).statusCode).toBe(200);

    expect((await pulled("genai/beacon-api")).json().models).toEqual({
      implementer: ["claude-fable-5-1"],
      reviewer: ["claude-sonnet-5-5"],
      shape: ["claude-opus-5-5"],
    });
    expect((await pulled("genai/lens")).json().models.implementer).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect((await pulled("genai/unknown")).statusCode).toBe(404);
    const anon = await app.inject({ method: "GET", url: "/api/orchestrator/models?repo=genai/lens" });
    expect(anon.statusCode).toBe(401);

    const view = (await app.inject({ method: "GET", url: `/api/orgs/${id.org}/models`, headers: owner })).json();
    expect(view.org.updatedBy).toBe("jerry");
    expect(view.projects.find((p: { name: string }) => p.name === "Beacon").chains).toEqual({ implementer: ["claude-fable-5-1"] });
  });

  it("sets a phase once for every step in it, and a step on its own where it needs to", async () => {
    await put("org", { "phase:design": ["claude-fable-5-1", "claude-opus-5-5"], "phase:build": ["claude-opus-5-5"], reviewer: ["claude-sonnet-5-5"] });
    await put(id.beacon!, { "phase:build": ["claude-sonnet-5-5"], architect: ["claude-opus-5-5"] });
    const beacon = (await pulled("genai/beacon-api")).json().models;
    expect(beacon).toEqual({
      planner: ["claude-fable-5-1", "claude-opus-5-5"], // org phase
      architect: ["claude-opus-5-5"], // project step
      testplanner: ["claude-fable-5-1", "claude-opus-5-5"],
      implementer: ["claude-sonnet-5-5"], // project phase beats the org's
      reviewer: ["claude-sonnet-5-5"], // project phase beats the org's step too
    });
    const lens = (await pulled("genai/lens")).json().models;
    expect(lens.implementer).toEqual(["claude-opus-5-5"]);
    expect(lens.reviewer).toEqual(["claude-sonnet-5-5"]);
    expect(lens.intake).toBeUndefined(); // nobody set Clarify: the repo's file decides
    expect(expandChains({ "phase:talk": ["a"] }, { investigate: ["b"] })).toEqual({ shape: ["a"], investigate: ["b"], ask: ["a"] });
  });

  it("gives Shape, Investigate and Questions the Conversations chain unless one sets its own", async () => {
    await put("org", { "phase:talk": ["claude-sonnet-5-5"], shape: ["claude-opus-5-5"] });
    await put(id.beacon!, {});
    expect(await askModels(deps, id.org!, id.beacon!, "shape")).toEqual(["claude-opus-5-5"]);
    expect(await askModels(deps, id.org!, id.beacon!, "investigate")).toEqual(["claude-sonnet-5-5"]);
    expect(await askModels(deps, id.org!, null, "ask")).toEqual(["claude-sonnet-5-5"]);
    await put("org", {});
    expect(await askModels(deps, id.org!, null, "ask")).toBeUndefined();
  });

  it("refuses an unknown phase, a bad id, a long chain and a project from elsewhere", async () => {
    expect((await put("org", { nonsense: ["claude-opus-5-5"] })).json().error).toMatch(/no phase called/);
    expect((await put("org", { implementer: ["rm -rf /"] })).json().error).toMatch(/not a model id/);
    expect((await put("org", { implementer: ["a", "b", "c", "d", "e"] })).json().error).toMatch(/at most 4/);
    expect((await put("00000000-0000-0000-0000-000000000000", {})).statusCode).toBe(404);
    expect(checkChains({ qa: [" claude-opus-5-5 ", "claude-opus-5-5", ""] })).toEqual({ chains: { qa: ["claude-opus-5-5"] } });
  });
});

describe("the models Claude lists for the stored credential", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetListedModels();
  });
  const available = (q = "") => app.inject({ method: "GET", url: `/api/orgs/${id.org}/models/available${q}`, headers: member });

  it("says so when no credential is stored", async () => {
    const got = (await available()).json();
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/No Claude credential/);
  });

  it("asks the Models API with the Claude sign-in, newest first, and caches it", async () => {
    await deps.dbh.db.insert(orchestratorSecrets).values({ orgId: id.org!, name: "CLAUDE_CODE_OAUTH_TOKEN", encryptedValue: encryptSecret("sk-ant-oat-x", MASTER_KEY), updatedBy: "jerry" });
    const seen: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), headers: new Headers(init?.headers) });
        return new Response(
          JSON.stringify({
            data: [
              { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-09-01T00:00:00Z", deprecated_at: null },
              { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-10-01T00:00:00Z", deprecated_at: null },
              { type: "model", id: "claude-old", display_name: "Old", created_at: "2026-11-01T00:00:00Z", deprecated_at: "2026-11-02T00:00:00Z" },
            ],
            has_more: false,
            first_id: "a",
            last_id: "b",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const got = (await available()).json();
    expect(got).toMatchObject({ ok: true, source: "claude-sign-in" });
    expect(got.models.map((m: { id: string }) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-old"]);
    expect(seen[0]!.url).toContain("/v1/models");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer sk-ant-oat-x");
    expect(seen[0]!.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(seen[0]!.headers.get("x-api-key")).toBeNull();
    await available();
    expect(seen).toHaveLength(1);
    await available("?refresh=1");
    expect(seen).toHaveLength(2);
  });

  it("says when Claude refuses the credential", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad" } }), { status: 401, headers: { "content-type": "application/json" } })));
    const got = (await available("?refresh=1")).json();
    expect(got).toMatchObject({ ok: false });
    expect(got.error).toMatch(/refused the stored credential/);
  });
});
