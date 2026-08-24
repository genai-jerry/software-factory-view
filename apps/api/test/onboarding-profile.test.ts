import { generateKeyPairSync, randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { auditLog, estates, memberships, orgs, repos, sessions, users, onboardingRuns } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

/**
 * The profile step. It is the one onboarding step the Console cannot do itself
 * — writing a profile means reading the code — so what it does instead is ask:
 * file an issue that starts the Profiler inside the repo's own Actions. These
 * tests pin what it files, and what it refuses to file.
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
/** Every GitHub request the route made, in order: "METHOD /path". */
let calls: string[];
/** path-substring → response, consulted in insertion order. */
let routes: Array<[string, { status?: number; body: unknown }]>;

const cookie = "console_session=sess-1";
const post = () =>
  app.inject({
    method: "POST",
    url: `/api/repos/${repoId}/onboarding/profile`,
    // No content-type: this route takes no body, and Fastify rejects an
    // empty one when the header claims JSON.
    headers: { cookie, "x-console-csrf": "1" },
  });

const reply = (match: string, body: unknown, status = 200) => routes.unshift([match, { status, body }]);

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
  const org = (await deps.dbh.db.insert(orgs).values({ name: "acme" }).returning())[0]!;
  orgId = org.id;
  await deps.dbh.db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  await deps.dbh.db.insert(sessions).values({ id: "sess-1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (
    await deps.dbh.db.insert(estates).values({ orgId: org.id, name: "acme", installationId: 99 }).returning()
  )[0]!;
  repoId = (
    await deps.dbh.db
      .insert(repos)
      .values({ orgId: org.id, estateId: estate.id, ghNodeId: "R_1", fullName: "acme/api", defaultBranch: "main" })
      .returning()
  )[0]!.id;

  calls = [];
  // Defaults describe the happy path: enabled repo, no profile, no issue yet.
  routes = [
    ["/access_tokens", { body: { token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() } }],
    [".factory/profile.json", { status: 404, body: { message: "Not Found" } }],
    ["factory-pipeline.yml", { body: { content: Buffer.from("permissions:\n").toString("base64"), sha: "s1", encoding: "base64" } }],
    ["/actions/secrets/ANTHROPIC_API_KEY", { status: 204, body: {} }],
    ["/labels", { body: { name: "factory:profile" } }],
    ["/issues?", { body: [] }],
    ["/issues", { body: { number: 7, html_url: "https://github.com/acme/api/issues/7", state: "open", labels: [] } }],
  ];

  vi.stubGlobal("fetch", async (url: string | URL, init?: { method?: string }) => {
    // Two hosts reach this stub: the installation client on the configured API
    // URL, and the user client on the default one.
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const hit = routes.find(([match]) => path.includes(match));
    if (!hit) throw new Error(`unstubbed GitHub call: ${init?.method ?? "GET"} ${path}`);
    const [, res] = hit;
    return new Response(res.status === 204 ? null : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

const stepRow = async () => (await deps.dbh.db.select().from(onboardingRuns))[0];

describe("the profile step", () => {
  it("files one issue carrying the trigger label, as the user", async () => {
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, issueNumber: 7, rerun: false });

    // Filed under the user's own token, not the App's: the router ignores
    // bot-authored issues on `opened`, so an App-filed issue would start
    // nothing and the button would silently do nothing.
    const filed = calls.find((c) => c.startsWith("POST /repos/acme/api/issues"));
    expect(filed).toBeTruthy();
    // The label has to exist before it can be applied — repos onboarded before
    // the Profiler existed never re-ran setup-labels.sh.
    expect(calls).toContain("POST /repos/acme/api/labels");

    const step = await stepRow();
    expect(step).toMatchObject({ step: "profile", status: "pending" });
    expect(step!.detail).toMatchObject({ issueNumber: 7 });
  });

  it("re-runs the Profiler when a profile is already on the default branch", async () => {
    reply(".factory/profile.json", { content: Buffer.from("{}").toString("base64"), sha: "p1", encoding: "base64" });

    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, issueNumber: 7, rerun: false });
    expect(calls.find((c) => c.startsWith("POST /repos/acme/api/issues"))).toBeTruthy();
    expect(await stepRow()).toMatchObject({ status: "pending" });
  });

  it("refuses before the enablement PR is merged, and says why", async () => {
    reply("factory-pipeline.yml", { message: "Not Found" }, 404);

    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not merged yet/);
    expect(calls.some((c) => c.includes("/repos/") && c.startsWith("POST"))).toBe(false);
  });

  it("refuses without Anthropic credentials on the repo", async () => {
    reply("/actions/secrets/CLAUDE_CODE_OAUTH_TOKEN", { message: "Not Found" }, 404);
    reply("/actions/secrets/ANTHROPIC_API_KEY", { message: "Not Found" }, 404);

    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/ANTHROPIC_API_KEY/);
    expect(calls.some((c) => c.includes("/repos/") && c.startsWith("POST"))).toBe(false);
  });

  it("when Software Factory is selected, starts from a langgraph claim and a Console-stored token", async () => {
    await deps.dbh.db.update(orgs).set({ orchestrator: "software-factory" }).where(eq(orgs.id, orgId));
    const secret = await app.inject({
      method: "POST",
      url: `/api/repos/${repoId}/onboarding/secret`,
      headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { name: "ANTHROPIC_API_KEY", value: "sk-ant-console" },
    });
    expect(secret.statusCode).toBe(200);
    expect(secret.json()).toMatchObject({ stored: true, githubActions: false });
    expect(calls.some((c) => c.includes("/actions/secrets"))).toBe(false);

    reply(
      "factory-orchestrator.json",
      { content: Buffer.from(JSON.stringify({ engine: "langgraph" })).toString("base64"), sha: "o1", encoding: "base64" },
    );

    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, issueNumber: 7 });
    expect(calls.some((c) => c.includes("factory-pipeline.yml"))).toBe(false);
    expect(calls.some((c) => c.includes("/actions/secrets"))).toBe(false);
    const profile = (await deps.dbh.db.select().from(onboardingRuns)).find((s) => s.step === "profile");
    expect((profile!.detail as { dispatchError?: string }).dispatchError).toMatch(/ORCHESTRATOR_URL is not set/);
  });

  it("when Software Factory is selected, refuses before the langgraph claim is on the default branch", async () => {
    await deps.dbh.db.update(orgs).set({ orchestrator: "software-factory" }).where(eq(orgs.id, orgId));
    await app.inject({
      method: "POST",
      url: `/api/repos/${repoId}/onboarding/secret`,
      headers: { cookie, "x-console-csrf": "1", "content-type": "application/json" },
      payload: { name: "ANTHROPIC_API_KEY", value: "sk-ant-console" },
    });
    reply("factory-orchestrator.json", { message: "Not Found" }, 404);

    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/factory-orchestrator.json/);
    expect(calls.some((c) => c.includes("/repos/") && c.startsWith("POST"))).toBe(false);
  });

  it("re-runs on the existing issue instead of filing a second", async () => {
    reply("/issues?", [{ number: 7, html_url: "https://github.com/acme/api/issues/7", state: "open", labels: [] }]);

    const res = await post();
    expect(res.json()).toMatchObject({ ok: true, issueNumber: 7, rerun: true });
    expect(calls.some((c) => c === "POST /repos/acme/api/issues")).toBe(false);
    // Remove-then-add: adding a label that is already there emits no event, and
    // a re-run button that starts nothing is worse than no button.
    expect(calls).toContain("DELETE /repos/acme/api/issues/7/labels/factory%3Aprofile");
    expect(calls).toContain("POST /repos/acme/api/issues/7/labels");
  });

  it("reopens a closed profile issue rather than starting a new thread", async () => {
    reply("/issues?", [{ number: 7, html_url: "https://github.com/acme/api/issues/7", state: "closed", labels: [] }]);
    reply("/issues/7", { number: 7, state: "open" });

    await post();
    expect(calls).toContain("PATCH /repos/acme/api/issues/7");
  });

  it("stamps requestedAt so the worker can attribute the Actions run it starts", async () => {
    await post();
    const step = await stepRow();
    expect(typeof (step!.detail as { requestedAt?: unknown }).requestedAt).toBe("string");
  });

  it("reuses the singleton issue by title after the Profiler dropped the label", async () => {
    reply("/issues?", [
      {
        number: 7,
        html_url: "https://github.com/acme/api/issues/7",
        state: "open",
        title: "Factory: repo profile",
        labels: [],
      },
    ]);
    reply("labels=factory%3Aprofile", []);

    const res = await post();
    expect(res.json()).toMatchObject({ ok: true, issueNumber: 7, rerun: true });
    expect(calls.some((c) => c === "POST /repos/acme/api/issues")).toBe(false);
  });
});

/**
 * Merging the Profiler's PR from the Console. The click is the human act the
 * step points at, so it runs as the signed-in user; and the Console only ever
 * merges the PR its own webhook flow recorded — never one it went looking for.
 */
describe("the profile merge", () => {
  const merge = () =>
    app.inject({
      method: "POST",
      url: `/api/repos/${repoId}/onboarding/profile/merge`,
      headers: { cookie, "x-console-csrf": "1" },
    });

  const seedStep = async (detail: Record<string, unknown>, status = "pending") => {
    const repo = (await deps.dbh.db.select().from(repos))[0]!;
    await deps.dbh.db.insert(onboardingRuns).values({
      orgId: repo.orgId,
      estateId: repo.estateId,
      repoId: repo.id,
      step: "profile",
      status,
      detail,
      updatedAt: new Date(),
    });
  };

  it("refuses while no open Profiler PR is recorded", async () => {
    await seedStep({ issueNumber: 7 }); // asked, but no PR has arrived yet

    const res = await merge();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/no open Profiler PR/);
    expect(calls.some((c) => c.includes("/merge"))).toBe(false);
  });

  it("merges the recorded PR as the user and closes the step", async () => {
    await seedStep({ issueNumber: 7, prNumber: 12, prUrl: "https://github.com/acme/api/pull/12", prState: "open" });
    reply("/pulls/12/merge", { sha: "m1", merged: true });

    const res = await merge();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, sha: "m1", prNumber: 12 });
    expect(calls).toContain("PUT /repos/acme/api/pulls/12/merge");

    const step = await stepRow();
    expect(step).toMatchObject({ status: "ok" });
    expect(step!.detail).toMatchObject({ prState: "merged", mergedBy: "alice", mergeSha: "m1" });
    // The signature is auditable, like every gate merge.
    expect((await deps.dbh.db.select().from(auditLog))[0]).toMatchObject({
      action: "pr.merge",
      target: "acme/api#12",
    });
  });

  it("relays GitHub's refusal and leaves the step untouched", async () => {
    await seedStep({ issueNumber: 7, prNumber: 12, prState: "open" });
    reply("/pulls/12/merge", { message: "Pull Request is not mergeable" }, 405);

    const res = await merge();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/GitHub declined the merge/);
    expect(await stepRow()).toMatchObject({ status: "pending" });
  });
});
