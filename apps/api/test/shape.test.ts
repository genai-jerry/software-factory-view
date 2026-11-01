import { randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import { artifactCache, changeArtifacts, changes, estates, issues, memberships, orgs, projects, repos, sessions, users } from "@console/db";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";
import { retainOrchestratorSecret } from "../src/orchestrator-secrets.js";
import { splitMocks } from "../src/routes/shape.js";

/**
 * Shape: a conversation about an idea, grounded in a repo through the
 * orchestrator's read-only session, with images for its Read tool; the
 * ```html mocks it answers with are shown apart from the prose; the
 * conversation becomes a requirement and then an issue with
 * `factory:intake`, the same door Add work uses. Private to its author.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const jerryCookie = "console_session=sess-jerry";
const otherCookie = "console_session=sess-other";
const headers = (cookie: string) => ({ cookie, "x-console-csrf": "1", "content-type": "application/json" });
const id: Record<string, string> = {};
const PNG_B64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).toString("base64");
const ORCH = "https://orch.invalid";

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
    ORCHESTRATOR_URL: ORCH,
    ORCHESTRATOR_DISPATCH_TOKEN: "dispatch-token",
    PUBLIC_ORIGIN: "https://sf.example.com",
  } as never);
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
  const other = (await d.insert(users).values({ ghUserId: 2, login: "other", encryptedOauthToken: encryptSecret("other-token", MASTER_KEY) }).returning())[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await d.insert(memberships).values([
    { orgId: org.id, userId: jerry.id, role: "owner" },
    { orgId: org.id, userId: other.id, role: "member" },
  ]);
  await d.insert(sessions).values([
    { id: "sess-jerry", userId: jerry.id, expiresAt: new Date(Date.now() + 3600_000) },
    { id: "sess-other", userId: other.id, expiresAt: new Date(Date.now() + 3600_000) },
  ]);
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const repo = (await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/app" }).returning())[0]!;
  id.repo = repo.id;
  id.org = org.id;
  await retainOrchestratorSecret(deps, { orgId: org.id, name: "CLAUDE_CODE_OAUTH_TOKEN", value: "claude-token", updatedBy: "jerry" });
});

afterEach(() => vi.unstubAllGlobals());

/** Answer the orchestrator's /ask and GitHub's issue creation; record every call. */
function stubNetwork(answer: string) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url: String(url), body });
      if (String(url) === `${ORCH}/ask`) {
        return new Response(JSON.stringify({ answer, model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 20 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).endsWith("/repos/acme/app/issues")) {
        return new Response(JSON.stringify({ number: 77, html_url: "https://github.com/acme/app/issues/77", node_id: "I77", title: "x", state: "open", labels: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }),
  );
  return calls;
}

describe("splitMocks", () => {
  it("lifts ```html fences out of the prose and leaves a pointer", () => {
    const { text, mocks } = splitMocks("Here it is.\n\n```html\n<!doctype html><p>hi</p>\n```\n\n- one assumption");
    expect(mocks).toEqual([{ html: "<!doctype html><p>hi</p>\n" }]);
    expect(text).toContain("Mock 1 — shown below");
    expect(text).not.toContain("<!doctype");
  });
});

describe("Shape", () => {
  it("runs a conversation from idea to issue", async () => {
    // Create.
    const created = await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { repoId: id.repo } });
    expect(created.statusCode).toBe(200);
    const convId = (created.json() as { id: string }).id;
    id.conv = convId;

    // Attach a screenshot.
    const att = await app.inject({
      method: "POST",
      url: `/api/shape/${convId}/attachments`,
      headers: headers(jerryCookie),
      payload: { name: "leads page.png", mime: "image/png", dataB64: PNG_B64 },
    });
    expect(att.statusCode).toBe(200);
    const attachment = att.json() as { id: string; name: string; url: string };
    expect(attachment.name).toBe("leads_page.png");
    expect(attachment.url).toBe(`/api/shape/attachments/${attachment.id}`);

    // First message: the orchestrator gets the image, shape mode, and the instructions.
    let calls = stubNetwork("I see the leads table.\n\n```html\n<!doctype html><html><body><h1>Leads</h1></body></html>\n```\n\n- Assumed a 30-day default.");
    const sent = await app.inject({
      method: "POST",
      url: `/api/shape/${convId}/messages`,
      headers: headers(jerryCookie),
      payload: { text: "Show the calling status on the leads page", attachmentIds: [attachment.id] },
    });
    expect(sent.statusCode).toBe(200);
    const ask = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(ask.body).toMatchObject({ owner: "acme", repo: "app", mode: "shape", claude_code_oauth_token: "claude-token" });
    expect(ask.body!.images).toEqual([{ name: "leads_page.png", mime: "image/png", data_b64: PNG_B64 }]);
    expect(String(ask.body!.instructions)).toContain("self-contained HTML document");
    const reply = sent.json() as { message: { bodyHtml: string; mocks: Array<{ html: string }> }; conversation: { title: string } };
    expect(reply.message.mocks[0]!.html).toContain("<h1>Leads</h1>");
    expect(reply.message.bodyHtml).toContain("I see the leads table.");
    expect(reply.message.bodyHtml).not.toContain("<h1>Leads</h1>");
    expect(reply.conversation.title).toBe("Show the calling status on the leads page");

    // The conversation reads back with both messages, the attachment and the mock.
    const got = await app.inject({ method: "GET", url: `/api/shape/${convId}`, headers: { cookie: jerryCookie } });
    const view = got.json() as { conversation: { title: string; repo: string }; messages: Array<{ role: string; attachments: Array<{ url: string }>; mocks: unknown[] }> };
    expect(view.conversation.repo).toBe("acme/app");
    expect(view.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(view.messages[0]!.attachments[0]!.url).toBe(attachment.url);
    expect(view.messages[1]!.mocks).toHaveLength(1);

    // The attachment serves its bytes to its author only.
    const bytes = await app.inject({ method: "GET", url: attachment.url, headers: { cookie: jerryCookie } });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers["content-type"]).toBe("image/png");
    expect(bytes.rawPayload.length).toBe(12);
    expect((await app.inject({ method: "GET", url: attachment.url, headers: { cookie: otherCookie } })).statusCode).toBe(404);

    // Second message carries the earlier turns as context.
    calls = stubNetwork("Where it would live: the leads list component.");
    await app.inject({ method: "POST", url: `/api/shape/${convId}/messages`, headers: headers(jerryCookie), payload: { text: "Where would that live in the code?" } });
    const second = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(String(second.body!.context)).toContain("Person: Show the calling status on the leads page");
    expect(String(second.body!.context)).toContain("You: I see the leads table.");
    expect(second.body!.images).toBeUndefined();

    // The requirement.
    calls = stubNetwork("## What should be built?\nA calling status column.\n\n## Why / who it is for\nSetters.\n\n## Context / constraints\nNone.\n\n## Out of scope\nNone.\n\n## Open questions\nNone\n\n## Mockups\nMock 1 — the leads page with the column.");
    const spec = await app.inject({ method: "POST", url: `/api/shape/${convId}/spec`, headers: headers(jerryCookie), payload: {} });
    expect(spec.statusCode).toBe(200);
    expect((spec.json() as { spec: string }).spec).toContain("## What should be built?");
    const specAsk = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(String(specAsk.body!.instructions)).toContain("## Open questions");
    expect(String(specAsk.body!.context)).toContain("Mock 1:");

    // The person edits it.
    const edited = await app.inject({ method: "PUT", url: `/api/shape/${convId}/spec`, headers: headers(jerryCookie), payload: { spec: "## What should be built?\nA calling status column, sortable." } });
    expect(edited.statusCode).toBe(200);

    // Open as work: an issue with the labels, the spec, and the mock folded in.
    calls = stubNetwork("");
    const work = await app.inject({ method: "POST", url: `/api/shape/${convId}/work`, headers: headers(jerryCookie), payload: { title: "Calling status on the leads page", fast: true } });
    expect(work.statusCode).toBe(200);
    expect(work.json()).toMatchObject({ number: 77, htmlUrl: "https://github.com/acme/app/issues/77" });
    const create = calls.find((c) => c.url.endsWith("/repos/acme/app/issues"))!;
    expect(create.body!.labels).toEqual(["factory:intake", "factory:expedite"]);
    const body = String(create.body!.body);
    expect(body.startsWith("## What should be built?\nA calling status column, sortable.")).toBe(true);
    expect(body).toContain("## Mockups");
    expect(body).toContain("<details><summary>Mock 1</summary>");
    expect(body).toContain("<h1>Leads</h1>");
    expect(body).toContain(`## Attachments`);
    expect(body).toContain(`https://sf.example.com/api/shape/attachments/${attachment.id}`);

    const after = await app.inject({ method: "GET", url: "/api/shape", headers: { cookie: jerryCookie } });
    const list = (after.json() as { conversations: Array<{ title: string; hasSpec: boolean; issueUrl: string | null }> }).conversations;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "Calling status on the leads page", hasSpec: true, issueUrl: "https://github.com/acme/app/issues/77" });
  });

  it("keeps a conversation private to its author", async () => {
    expect((await app.inject({ method: "GET", url: `/api/shape/${id.conv}`, headers: { cookie: otherCookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/shape", headers: { cookie: otherCookie } })).json()).toEqual({ conversations: [] });
  });

  it("refuses an attachment that is not an image or is too large", async () => {
    const pdf = await app.inject({ method: "POST", url: `/api/shape/${id.conv}/attachments`, headers: headers(jerryCookie), payload: { name: "a.pdf", mime: "application/pdf", dataB64: PNG_B64 } });
    expect(pdf.statusCode).toBe(400);
    const big = await app.inject({
      method: "POST",
      url: `/api/shape/${id.conv}/attachments`,
      headers: headers(jerryCookie),
      payload: { name: "big.png", mime: "image/png", dataB64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") },
    });
    expect(big.statusCode).toBe(413);
  });

  it("says what is missing when the factory has no Claude sign-in", async () => {
    const d = deps.dbh.db;
    const org2 = (await d.insert(orgs).values({ name: "lonely" }).returning())[0]!;
    const jerry = (await d.select().from(users).where(eq(users.login, "jerry")).limit(1))[0]!;
    await d.insert(memberships).values({ orgId: org2.id, userId: jerry.id, role: "owner" });
    const estate = (await d.insert(estates).values({ orgId: org2.id, name: "lonely", installationId: 2 }).returning())[0]!;
    const repo = (await d.insert(repos).values({ orgId: org2.id, estateId: estate.id, ghNodeId: "R2", fullName: "lonely/app" }).returning())[0]!;
    const created = await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { repoId: repo.id } });
    const conv = (created.json() as { id: string }).id;
    const res = await app.inject({ method: "POST", url: `/api/shape/${conv}/messages`, headers: headers(jerryCookie), payload: { text: "hello" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("Claude sign-in");
    void issues;
  });
});

describe("Shape about an epic, and the project around a fresh idea", () => {
  it("runs on the epic's branch with its documents in front, and checks the project's other repos out beside it", async () => {
    const d = deps.dbh.db;
    const project = (await d.insert(projects).values({ orgId: id.org!, name: "Acme" }).returning())[0]!;
    await d.update(repos).set({ projectId: project.id, factoryEnabled: true }).where(eq(repos.id, id.repo!));
    const estate = (await d.select().from(estates).where(eq(estates.orgId, id.org!)).limit(1))[0]!;
    await d.insert(repos).values({ orgId: id.org!, estateId: estate.id, ghNodeId: "R-web", fullName: "acme/web", projectId: project.id, factoryEnabled: true });
    await d.insert(repos).values({ orgId: id.org!, estateId: estate.id, ghNodeId: "R-off", fullName: "acme/off", projectId: project.id, factoryEnabled: false });
    const epic = (
      await d
        .insert(issues)
        .values({ orgId: id.org!, repoId: id.repo!, ghNodeId: "I35", number: 35, title: "Day-wise calling performance", state: "open", kind: "epic", factoryState: "factory:design-approved", ghUpdatedAt: new Date() })
        .returning()
    )[0]!;
    const change = (await d.insert(changes).values({ orgId: id.org!, estateId: estate.id, epicIssueId: epic.id, slug: "35-daywise" }).returning())[0]!;
    await d.insert(changeArtifacts).values({ orgId: id.org!, changeId: change.id, repoId: id.repo!, kind: "proposal", path: "openspec/changes/35-daywise/proposal.md", latestSha: "abc1234" });
    await d.insert(artifactCache).values({ orgId: id.org!, repoId: id.repo!, path: "openspec/changes/35-daywise/proposal.md", commitSha: "abc1234", encryptedContent: encryptSecret("## Why\nSetters cannot see the day's bookings.", MASTER_KEY) });

    // About the epic.
    const created = await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { epicId: epic.id } });
    expect(created.statusCode).toBe(200);
    const convId = (created.json() as { id: string }).id;
    const got = await app.inject({ method: "GET", url: `/api/shape/${convId}`, headers: { cookie: jerryCookie } });
    expect((got.json() as { conversation: { epic: unknown; repo: string } }).conversation).toMatchObject({
      repo: "acme/app",
      epic: { id: epic.id, number: 35, title: "Day-wise calling performance", state: "factory:design-approved" },
    });
    const listed = await app.inject({ method: "GET", url: `/api/shape?epicId=${epic.id}`, headers: { cookie: jerryCookie } });
    expect((listed.json() as { conversations: Array<{ id: string; epic: { number: number } }> }).conversations).toMatchObject([{ id: convId, epic: { number: 35 } }]);

    let calls = stubNetwork("Two tasks are left.");
    const sent = await app.inject({ method: "POST", url: `/api/shape/${convId}/messages`, headers: headers(jerryCookie), payload: { text: "What is left before this ships?" } });
    expect(sent.statusCode).toBe(200);
    const ask = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(ask.body).toMatchObject({ branch: "factory/epic-35", mode: "shape", repos: [{ owner: "acme", repo: "web", branch: "factory/epic-35" }] });
    const context = String(ask.body!.context);
    expect(context).toContain("The epic's documents:");
    expect(context).toContain("Setters cannot see the day's bookings.");
    expect(context.indexOf("The epic's documents:")).toBeLessThan(context.indexOf("(the conversation starts here)"));
    expect(context).toContain('epic #35, "Day-wise calling performance"');

    // The spec runs on the branch too, with the documents.
    calls = stubNetwork("## What should be built?\nA change to the epic.");
    const spec = await app.inject({ method: "POST", url: `/api/shape/${convId}/spec`, headers: headers(jerryCookie), payload: {} });
    expect(spec.statusCode).toBe(200);
    const specAsk = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(specAsk.body).toMatchObject({ branch: "factory/epic-35", repos: [{ owner: "acme", repo: "web", branch: "factory/epic-35" }] });
    expect(String(specAsk.body!.context)).toContain("Setters cannot see the day's bookings.");

    // A fresh idea in the same project: no branch, no documents, the siblings on their default branch.
    const fresh = await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { repoId: id.repo } });
    const freshId = (fresh.json() as { id: string }).id;
    calls = stubNetwork("From main.");
    await app.inject({ method: "POST", url: `/api/shape/${freshId}/messages`, headers: headers(jerryCookie), payload: { text: "Where do leads live?" } });
    const freshAsk = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(freshAsk.body!.branch).toBeUndefined();
    expect(freshAsk.body!.repos).toEqual([{ owner: "acme", repo: "web", branch: null }]);
    expect(String(freshAsk.body!.context)).not.toContain("The epic's documents:");
    expect((await app.inject({ method: "GET", url: `/api/shape/${freshId}`, headers: { cookie: jerryCookie } })).json().conversation.epic).toBeNull();
  });
});
