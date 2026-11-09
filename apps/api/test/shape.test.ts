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
import { settlePendingAnswers, settleStale, splitMocks } from "../src/routes/shape.js";
import { shapeConversations, shapeMessages } from "@console/db";

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
function stubNetwork(answer: string, ask: { session?: string; resumed?: boolean } = {}, delayMs = 0) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url: String(url), body });
      if (String(url) === `${ORCH}/ask`) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return new Response(JSON.stringify({ answer, model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 20 }, ...ask }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const repoIssues = /\/repos\/acme\/(app|web)\/issues$/.exec(String(url));
      if (repoIssues) {
        const repo = repoIssues[1];
        return new Response(JSON.stringify({ number: 77, html_url: `https://github.com/acme/${repo}/issues/77`, node_id: "I77", title: "x", state: "open", labels: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }),
  );
  return calls;
}

/** POST a message (202, pending), then wait for the background answer. */
async function say(convId: string, payload: Record<string, unknown>, cookie = jerryCookie) {
  const res = await app.inject({ method: "POST", url: `/api/shape/${convId}/messages`, headers: headers(cookie), payload });
  await settlePendingAnswers();
  return res;
}

/** POST the spec (202), then wait for it to be written. */
async function writeSpec(convId: string) {
  const res = await app.inject({ method: "POST", url: `/api/shape/${convId}/spec`, headers: headers(jerryCookie), payload: {} });
  await settlePendingAnswers();
  return res;
}

async function view(convId: string, cookie = jerryCookie) {
  return (await app.inject({ method: "GET", url: `/api/shape/${convId}`, headers: { cookie } })).json();
}

/** What the orchestrator writes for a requirement: the form, then the OpenSpec draft. */
const REQUIREMENT = [
  "## Problem / need\nA calling status column.",
  "## Desired outcome\n- Setters see who was called today.",
  "## Affected repositories\n- acme/app: the leads page.",
  "## Rough size\nFeature (single repo)",
  "## Open questions\nNone",
  "## Mockups\nMock 1 — the leads page with the column.",
  "## OpenSpec change: calling-status-column",
  "````openspec proposal.md\n## Why\nSetters call the same lead twice.\n\n## Interpretations taken\n1. Today means the setter's own day.\n````",
  "````openspec specs/lead-calling-status/spec.md\n## ADDED Requirements\n\n### Requirement: Calling status\nThe leads page SHALL show today's calling status.\n\n#### Scenario: A lead called today\n- **WHEN** a setter calls a lead\n- **THEN** it shows Called today\n````",
].join("\n\n");

describe("splitMocks", () => {
  it("lifts ```html fences out of the prose and leaves a pointer", () => {
    const { text, mocks } = splitMocks("Here it is.\n\n```html\n<!doctype html><p>hi</p>\n```\n\n- one assumption");
    expect(mocks).toEqual([{ html: "<!doctype html><p>hi</p>\n" }]);
    expect(text).toContain("Mock 1 — shown below");
    expect(text).not.toContain("<!doctype");
  });

  it("lifts ```mermaid fences out as diagrams, after the mocks", () => {
    const { text, mocks, diagrams } = splitMocks("The flow.\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n```html\n<p>m</p>\n```\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```");
    expect(mocks).toHaveLength(1);
    expect(diagrams).toEqual([{ code: "flowchart TD\n  A --> B" }, { code: "sequenceDiagram\n  A->>B: hi" }]);
    expect(text).toContain("Diagram 1 — shown below");
    expect(text).toContain("Diagram 2 — shown below");
    expect(text).not.toContain("flowchart");
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
    // The answer takes a moment, as a real one does, so the pending state is visible.
    let calls = stubNetwork("I see the leads table.\n\n```html\n<!doctype html><html><body><h1>Leads</h1></body></html>\n```\n\n```mermaid\nflowchart LR\n  A[\"Leads page\"] --> B[\"Status column\"]\n```\n\n- Assumed a 30-day default.", {}, 150);
    // The request comes back at once with a pending answer; the work runs behind it.
    const sent = await app.inject({
      method: "POST",
      url: `/api/shape/${convId}/messages`,
      headers: headers(jerryCookie),
      payload: { text: "Show the calling status on the leads page", attachmentIds: [attachment.id] },
    });
    expect(sent.statusCode).toBe(202);
    const accepted = sent.json() as { message: { id: string; role: string; status: string; body: string }; conversation: { title: string } };
    expect(accepted.message).toMatchObject({ role: "assistant", status: "pending", body: "" });
    expect(accepted.conversation.title).toBe("Show the calling status on the leads page");
    // A second question while one is being answered is refused.
    const busy = await say(convId, { text: "And?" });
    expect(busy.statusCode).toBe(409);
    await settlePendingAnswers();
    const ask = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(ask.body).toMatchObject({ owner: "acme", repo: "app", mode: "shape", claude_code_oauth_token: "claude-token" });
    expect(ask.body!.images).toEqual([{ name: "leads_page.png", mime: "image/png", data_b64: PNG_B64 }]);
    expect(String(ask.body!.instructions)).toContain("self-contained HTML document");

    // The conversation reads back with both messages, the attachment and the mock, the answer done.
    const got = await app.inject({ method: "GET", url: `/api/shape/${convId}`, headers: { cookie: jerryCookie } });
    const shown = got.json() as {
      conversation: { title: string; repo: string };
      messages: Array<{ id: string; role: string; status: string; bodyHtml: string; attachments: Array<{ url: string }>; mocks: Array<{ html: string }>; diagrams: Array<{ code: string }> }>;
    };
    expect(shown.conversation.repo).toBe("acme/app");
    expect(shown.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(shown.messages[0]!.attachments[0]!.url).toBe(attachment.url);
    expect(shown.messages[1]!.id).toBe(accepted.message.id);
    expect(shown.messages[1]!.status).toBe("done");
    expect(shown.messages[1]!.mocks[0]!.html).toContain("<h1>Leads</h1>");
    // The diagram is drawn by the page, not flattened into chains in the prose.
    expect(shown.messages[1]!.diagrams).toEqual([{ code: 'flowchart LR\n  A["Leads page"] --> B["Status column"]' }]);
    expect(shown.messages[1]!.bodyHtml).toContain("Diagram 1 — shown below");
    expect(shown.messages[1]!.bodyHtml).not.toContain("Status column");
    expect(shown.messages[1]!.bodyHtml).toContain("I see the leads table.");
    expect(shown.messages[1]!.bodyHtml).not.toContain("<h1>Leads</h1>");

    // The attachment serves its bytes to its author only.
    const bytes = await app.inject({ method: "GET", url: attachment.url, headers: { cookie: jerryCookie } });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers["content-type"]).toBe("image/png");
    expect(bytes.rawPayload.length).toBe(12);
    expect((await app.inject({ method: "GET", url: attachment.url, headers: { cookie: otherCookie } })).statusCode).toBe(404);

    // Second message: the orchestrator reported no session, so it starts
    // cold again and carries the earlier turns as context.
    calls = stubNetwork("Where it would live: the leads list component.");
    await say(convId, { text: "Where would that live in the code?" });
    const second = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(String(second.body!.context)).toContain("Person: Show the calling status on the leads page");
    expect(String(second.body!.context)).toContain("You: I see the leads table.");
    expect(second.body!.images).toBeUndefined();
    expect(second.body!.session).toBeUndefined();
    expect(second.body!.conversation).toBe(convId);

    // The requirement.
    calls = stubNetwork(REQUIREMENT);
    const spec = await app.inject({ method: "POST", url: `/api/shape/${convId}/spec`, headers: headers(jerryCookie), payload: {} });
    expect(spec.statusCode).toBe(202);
    expect(spec.json()).toEqual({ specStatus: "pending" });
    await settlePendingAnswers();
    expect((await view(convId)).conversation).toMatchObject({ specStatus: "done", specError: null });
    expect(String((await view(convId)).conversation.spec)).toContain("## OpenSpec change: calling-status-column");
    const specAsk = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(String(specAsk.body!.instructions)).toContain("## Open questions");
    expect(String(specAsk.body!.instructions)).toContain("#### Scenario: <name>");
    expect(String(specAsk.body!.context)).toContain("Mock 1:");

    // The person edits it.
    const edited = await app.inject({ method: "PUT", url: `/api/shape/${convId}/spec`, headers: headers(jerryCookie), payload: { spec: REQUIREMENT.replace("A calling status column.", "A calling status column, sortable.") } });
    expect(edited.statusCode).toBe(200);

    // Open as work: an issue with the labels, the spec, and the mock folded in.
    calls = stubNetwork("");
    const work = await app.inject({ method: "POST", url: `/api/shape/${convId}/work`, headers: headers(jerryCookie), payload: { title: "Calling status on the leads page", fast: true } });
    expect(work.statusCode).toBe(200);
    expect(work.json()).toMatchObject({ number: 77, htmlUrl: "https://github.com/acme/app/issues/77" });
    const create = calls.find((c) => c.url.endsWith("/repos/acme/app/issues"))!;
    expect(create.body!.labels).toEqual(["factory:intake", "factory:expedite"]);
    const body = String(create.body!.body);
    expect(body.startsWith("## Problem / need\nA calling status column, sortable.")).toBe(true);
    // The OpenSpec draft: each file in its own fold, ready for the Intake Analyst.
    expect(body).toContain("## OpenSpec draft");
    expect(body).toContain("`openspec/changes/<this issue's number>-calling-status-column/`");
    expect(body).toContain("<!-- openspec-draft: calling-status-column -->");
    expect(body).toContain("<details><summary><code>proposal.md</code></summary>\n\n````markdown\n## Why\nSetters call the same lead twice.");
    expect(body).toContain("<details><summary><code>specs/lead-calling-status/spec.md</code></summary>");
    expect(body).toContain("#### Scenario: A lead called today");
    expect(body).not.toContain("````openspec");
    expect(body).toContain("## Mockups");
    expect(body).toContain("<details><summary>Mock 1</summary>");
    expect(body).toContain("<h1>Leads</h1>");
    expect(body).toContain('## Diagrams\n\n**Diagram 1**\n\n```mermaid\nflowchart LR\n  A["Leads page"] --> B["Status column"]\n```');
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
    const sent = await say(convId, { text: "What is left before this ships?" });
    expect(sent.statusCode).toBe(202);
    const ask = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(ask.body).toMatchObject({ branch: "factory/epic-35", mode: "shape", repos: [{ owner: "acme", repo: "web", branch: "factory/epic-35" }] });
    const context = String(ask.body!.context);
    expect(context).toContain("The epic's documents:");
    expect(context).toContain("Setters cannot see the day's bookings.");
    expect(context.indexOf("The epic's documents:")).toBeLessThan(context.indexOf("(the conversation starts here)"));
    expect(context).toContain('epic #35, "Day-wise calling performance"');

    // The spec runs on the branch too, with the documents.
    calls = stubNetwork("## What should be built?\nA change to the epic.");
    const spec = await writeSpec(convId);
    expect(spec.statusCode).toBe(202);
    const specAsk = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(specAsk.body).toMatchObject({ branch: "factory/epic-35", repos: [{ owner: "acme", repo: "web", branch: "factory/epic-35" }] });
    expect(String(specAsk.body!.context)).toContain("Setters cannot see the day's bookings.");

    // A fresh idea in the same project: no branch, no documents, the siblings on their default branch.
    const fresh = await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { repoId: id.repo } });
    const freshId = (fresh.json() as { id: string }).id;
    calls = stubNetwork("From main.");
    await say(freshId, { text: "Where do leads live?" });
    const freshAsk = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(freshAsk.body!.branch).toBeUndefined();
    expect(freshAsk.body!.repos).toEqual([{ owner: "acme", repo: "web", branch: null }]);
    expect(String(freshAsk.body!.context)).not.toContain("The epic's documents:");
    expect((await app.inject({ method: "GET", url: `/api/shape/${freshId}`, headers: { cookie: jerryCookie } })).json().conversation.epic).toBeNull();
  });

  it("spans the project: the first repo is home, the session is told about all of them, and the work opens where the person picks", async () => {
    const d = deps.dbh.db;
    const project = (await d.select().from(projects).where(eq(projects.name, "Acme")).limit(1))[0]!;
    const web = (await d.select().from(repos).where(eq(repos.fullName, "acme/web")).limit(1))[0]!;

    const created = await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { projectId: project.id } });
    expect(created.statusCode).toBe(200);
    const convId = (created.json() as { id: string }).id;
    const got = (await view(convId)) as { conversation: { scope: string; repo: string; project: { name: string; repos: Array<{ fullName: string }> } } };
    expect(got.conversation).toMatchObject({ scope: "project", repo: "acme/app", project: { name: "Acme", repos: [{ fullName: "acme/app" }, { fullName: "acme/web" }] } });
    const listed = (await app.inject({ method: "GET", url: "/api/shape", headers: { cookie: jerryCookie } })).json() as { conversations: Array<{ id: string; scope: string; projectName: string }> };
    expect(listed.conversations.find((c) => c.id === convId)).toMatchObject({ scope: "project", projectName: "Acme" });

    let calls = stubNetwork("Both.");
    await say(convId, { text: "Where do leads live, and which app shows them?" });
    const ask = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(ask.body).toMatchObject({ owner: "acme", repo: "app", repos: [{ owner: "acme", repo: "web", branch: null }] });
    const context = String(ask.body!.context);
    expect(context).toContain("Project: Acme, repositories acme/app, acme/web.");
    expect(context).toContain("acme/web are checked out beside it");

    calls = stubNetwork("## What should be built?\nA shared status across both apps.");
    await writeSpec(convId);
    expect(String(calls.find((c) => c.url === `${ORCH}/ask`)!.body!.context)).toContain("say which repositories change");

    // Not a repository of the project → refused; a repository of it → the issue opens there and it becomes home.
    const elsewhere = await app.inject({ method: "POST", url: `/api/shape/${convId}/work`, headers: headers(jerryCookie), payload: { title: "Shared status", repoId: "00000000-0000-0000-0000-000000000000" } });
    expect(elsewhere.statusCode).toBe(400);
    calls = stubNetwork("");
    const opened = await app.inject({ method: "POST", url: `/api/shape/${convId}/work`, headers: headers(jerryCookie), payload: { title: "Shared status", repoId: web.id } });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ number: 77, htmlUrl: "https://github.com/acme/web/issues/77" });
    expect(calls.some((c) => c.url.endsWith("/repos/acme/web/issues"))).toBe(true);
    expect(((await view(convId)) as { conversation: { repo: string } }).conversation.repo).toBe("acme/web");

    // An idea about one repository cannot be sent to another.
    const single = await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { repoId: id.repo } });
    const singleId = (single.json() as { id: string }).id;
    await d.update(shapeConversations).set({ spec: "## What should be built?\nOne thing." }).where(eq(shapeConversations.id, singleId));
    const moved = await app.inject({ method: "POST", url: `/api/shape/${singleId}/work`, headers: headers(jerryCookie), payload: { title: "One thing", repoId: web.id } });
    expect(moved.statusCode).toBe(400);
  });
});

describe("Shape resumes its Claude session", () => {
  it("sends the session back and only the header, and starts cold again when the orchestrator could not resume", async () => {
    const created = await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { repoId: id.repo } });
    const convId = (created.json() as { id: string }).id;

    // First message: no session yet, full grounding; the orchestrator opens s1.
    let calls = stubNetwork("The leads table has no status column.", { session: "s1", resumed: false });
    await say(convId, { text: "What does the leads page show?" });
    const first = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(first.body!.session).toBeUndefined();
    expect(first.body!.conversation).toBe(convId);
    expect(String(first.body!.context)).toContain("the conversation starts here");

    // Second message: s1 is resumed, so only the header travels.
    calls = stubNetwork("It would go beside the name.", { session: "s1", resumed: true });
    await say(convId, { text: "Where would a status column go?" });
    const second = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(second.body!.session).toBe("s1");
    expect(String(second.body!.context)).toContain("Repository: acme/app");
    expect(String(second.body!.context)).not.toContain("Person:");
    expect(String(second.body!.context)).not.toContain("What does the leads page show?");

    // Third message: the workspace was gone, the orchestrator started cold
    // and opened s2 — the next message resumes s2 and carries no transcript.
    calls = stubNetwork("Starting again: the leads table has no status column.", { session: "s2", resumed: false });
    await say(convId, { text: "And the filters?" });
    const third = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(third.body!.session).toBe("s1");
    calls = stubNetwork("Filters stay.", { session: "s2", resumed: true });
    await say(convId, { text: "Thanks." });
    const fourth = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(fourth.body!.session).toBe("s2");

    // An orchestrator that reports no session at all leaves the next message cold with the transcript.
    calls = stubNetwork("No session here.");
    await say(convId, { text: "Once more." });
    calls = stubNetwork("Cold again.");
    await say(convId, { text: "Still here?" });
    const sixth = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(sixth.body!.session).toBeUndefined();
    expect(String(sixth.body!.context)).toContain("Person: What does the leads page show?");

    // The spec reuses the workspace but never a session.
    calls = stubNetwork("## What should be built?\nA column.\n\n## Why / who it is for\nSetters.\n\n## Context / constraints\nNone.\n\n## Out of scope\nNone.\n\n## Open questions\nNone\n\n## Mockups\nNone");
    await writeSpec(convId);
    const specAsk = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(specAsk.body!.conversation).toBe(convId);
    expect(specAsk.body!.session).toBeUndefined();
    expect(String(specAsk.body!.context)).toContain("Person: What does the leads page show?");
  });
});

describe("Shape answers in the background", () => {
  it("marks a failed answer failed with the reason, retries it, and settles work a restart lost", async () => {
    const created = await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { repoId: id.repo } });
    const convId = (created.json() as { id: string }).id;

    // The orchestrator refuses: the row ends failed, the question stays.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "No model in the preference chain for 'ask' is accessible" }), { status: 503, headers: { "content-type": "application/json" } })),
    );
    const sent = await say(convId, { text: "Why is the panel empty?" });
    expect(sent.statusCode).toBe(202);
    let v = await view(convId);
    expect(v.messages.map((m: { role: string; status: string }) => [m.role, m.status])).toEqual([
      ["user", "done"],
      ["assistant", "failed"],
    ]);
    expect(String(v.messages[1].error)).toContain("No model in the preference chain");
    const failedId = v.messages[1].id as string;

    // Try again: the same question, answered this time.
    const calls = stubNetwork("Because no appointment has synced yet.");
    const retry = await app.inject({ method: "POST", url: `/api/shape/${convId}/messages/${failedId}/retry`, headers: headers(jerryCookie), payload: {} });
    expect(retry.statusCode).toBe(202);
    expect((retry.json() as { message: { id: string; status: string } }).message).toMatchObject({ id: failedId, status: "pending" });
    await settlePendingAnswers();
    expect(calls.find((c) => c.url === `${ORCH}/ask`)!.body!.question).toBe("Why is the panel empty?");
    v = await view(convId);
    expect(v.messages[1]).toMatchObject({ id: failedId, status: "done", error: null });
    expect(String(v.messages[1].bodyHtml)).toContain("Because no appointment has synced yet.");

    // A pending row older than 15 minutes belongs to a process that is gone.
    const d = deps.dbh.db;
    const stale = (
      await d
        .insert(shapeMessages)
        .values({ orgId: id.org!, conversationId: convId, role: "assistant", body: "", status: "pending", createdAt: new Date(Date.now() - 20 * 60_000) })
        .returning()
    )[0]!;
    await d.update(shapeConversations).set({ specStatus: "pending", updatedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(shapeConversations.id, convId));
    await settleStale(d);
    v = await view(convId);
    const settled = v.messages.find((m: { id: string }) => m.id === stale.id);
    expect(settled).toMatchObject({ status: "failed", error: "The answer was lost, probably in a restart. Send it again." });
    expect(v.conversation).toMatchObject({ specStatus: "failed" });
    expect(String(v.conversation.specError)).toContain("interrupted");
  });
});

describe("Shape about a new product", () => {
  it("runs with no repository, writes the requirement from scratch, and opens where the person picks", async () => {
    const d = deps.dbh.db;
    await d.update(repos).set({ factoryEnabled: true }).where(eq(repos.id, id.repo!));
    const created = await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { newProduct: true } });
    expect(created.statusCode).toBe(200);
    const convId = (created.json() as { id: string }).id;
    const got = (await view(convId)) as { conversation: { scope: string; repo: string | null; repoId: string | null; homes: Array<{ fullName: string }> } };
    expect(got.conversation).toMatchObject({ scope: "new", repo: null, repoId: null });
    expect(got.conversation.homes.map((h) => h.fullName)).toContain("acme/app");
    const listed = (await app.inject({ method: "GET", url: "/api/shape", headers: { cookie: jerryCookie } })).json() as { conversations: Array<{ id: string; scope: string; repo: string | null }> };
    expect(listed.conversations.find((c) => c.id === convId)).toMatchObject({ scope: "new", repo: null });

    let calls = stubNetwork("A camera translator: point, read, translate.");
    await say(convId, { text: "A mobile app that translates Malayalam text from the camera" });
    const ask = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(ask.body).not.toHaveProperty("owner");
    expect(ask.body).not.toHaveProperty("repo");
    expect(ask.body).not.toHaveProperty("repos");
    expect(String(ask.body!.context)).toContain("A new product: there is no repository and no code yet.");
    expect(String(ask.body!.instructions)).toContain("organisation's tools");
    expect(String(ask.body!.instructions)).not.toContain("never reach the network");
    expect(String(ask.body!.instructions)).toContain("Write\n  the requirement");
    const flat = String(ask.body!.instructions).replace(/\s+/g, " ");
    expect(flat).toContain("Never tell them to paste files into another session");
    expect(flat).toContain("open-as-work");
    expect(flat).toContain("a reply in the chat (\"yes\", \"go ahead\") does nothing");
    expect(ask.body!.mcp_servers).toEqual([]); // the org's Compass → Tools servers ride along, none here

    calls = stubNetwork("## What should be built?\nA camera translator.");
    await writeSpec(convId);
    const specAsk = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(specAsk.body).not.toHaveProperty("repo");
    expect(String(specAsk.body!.context)).toContain("a new repository is needed");

    const nowhere = await app.inject({ method: "POST", url: `/api/shape/${convId}/work`, headers: headers(jerryCookie), payload: { title: "Camera translator" } });
    expect(nowhere.statusCode).toBe(400);
    expect(nowhere.json().error).toMatch(/pick the repository/);
    calls = stubNetwork("");
    const opened = await app.inject({ method: "POST", url: `/api/shape/${convId}/work`, headers: headers(jerryCookie), payload: { title: "Camera translator", repoId: id.repo } });
    expect(opened.statusCode).toBe(200);
    expect(calls.some((c) => c.url.endsWith("/repos/acme/app/issues"))).toBe(true);
    expect(((await view(convId)) as { conversation: { scope: string; repo: string } }).conversation).toMatchObject({ scope: "repo", repo: "acme/app" });
  });

  it("turns an idea started under a product into a new product, keeping the talk and dropping the session", async () => {
    const created = await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { repoId: id.repo } });
    const convId = (created.json() as { id: string }).id;
    let calls = stubNetwork("The leads page lives in app.", { session: "sess-code" });
    await say(convId, { text: "A translator app" });
    expect(calls.find((c) => c.url === `${ORCH}/ask`)!.body).toMatchObject({ owner: "acme", repo: "app" });

    const switched = await app.inject({ method: "POST", url: `/api/shape/${convId}/new-product`, headers: headers(jerryCookie), payload: {} });
    expect(switched.statusCode).toBe(200);
    calls = stubNetwork("From scratch, then.");
    await say(convId, { text: "This is independent of acme" });
    const ask = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(ask.body).not.toHaveProperty("session");
    expect(ask.body).not.toHaveProperty("repo");
    // Cold start: the earlier turns come along in the context.
    expect(String(ask.body!.context)).toContain("Person: A translator app");
    expect(((await view(convId)) as { messages: unknown[] }).messages).toHaveLength(4);

    expect((await app.inject({ method: "POST", url: `/api/shape/${convId}/new-product`, headers: headers("console_session=sess-other"), payload: {} })).statusCode).toBe(404);
  });
});

describe("Claude proposes a repository for a new product", () => {
  it("reads the proposal out of the answer, and only a valid one", async () => {
    const { splitMocks } = await import("../src/routes/shape.js");
    const got = splitMocks('Here is one.\n\n```create-repository\n{"name": "lens", "description": "Camera translator", "private": false, "project": "new"}\n```');
    expect(got.repoProposal).toEqual({ name: "lens", description: "Camera translator", private: false, project: "new" });
    expect(got.text).toContain("The proposed repository is below");
    expect(splitMocks("```create-repository\n{\"name\": \"has spaces\"}\n```").repoProposal).toBeNull();
    expect(splitMocks("```create-repository\nnot json\n```").repoProposal).toBeNull();
    const work = splitMocks('Ready.\n\n```open-as-work\n{"title": "Mirror: camera translator", "fast": false}\n```');
    expect(work.workProposal).toEqual({ title: "Mirror: camera translator", fast: false });
    expect(work.text).toContain("Ready to open as work");
    expect(splitMocks('```open-as-work\n{"title": ""}\n```').workProposal).toBeNull();
  });

  it("shows it on the answer, and moves the idea into the repository once made", async () => {
    const d = deps.dbh.db;
    await d.update(repos).set({ factoryEnabled: true }).where(eq(repos.id, id.repo!));
    const convId = ((await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { newProduct: true } })).json() as { id: string }).id;
    let calls = stubNetwork('Proposed.\n\n```create-repository\n{"name": "lens", "description": "Camera translator", "private": true, "project": "new"}\n```', { session: "s-new" });
    await say(convId, { text: "Create the repo for this" });
    expect(String(calls.find((c) => c.url === `${ORCH}/ask`)!.body!.instructions)).toContain("create-repository");
    const got = (await view(convId)) as { messages: Array<{ role: string; repoProposal: unknown }> };
    expect(got.messages.find((m) => m.role === "assistant")!.repoProposal).toMatchObject({ name: "lens", project: "new" });

    expect((await app.inject({ method: "POST", url: `/api/shape/${convId}/repo`, headers: headers(jerryCookie), payload: { repoId: "00000000-0000-0000-0000-000000000000" } })).statusCode).toBe(400);
    const moved = await app.inject({ method: "POST", url: `/api/shape/${convId}/repo`, headers: headers(jerryCookie), payload: { repoId: id.repo } });
    expect(moved.statusCode).toBe(200);
    expect(((await view(convId)) as { conversation: { scope: string; repo: string } }).conversation).toMatchObject({ scope: "repo", repo: "acme/app" });
    // The next answer starts fresh in the repository's checkout.
    calls = stubNetwork("Now in the repo.");
    await say(convId, { text: "What is in it?" });
    const next = calls.find((c) => c.url === `${ORCH}/ask`)!;
    expect(next.body).toMatchObject({ owner: "acme", repo: "app" });
    expect(next.body).not.toHaveProperty("session");
    // Once it is work, it stays where it was filed.
    await d.update(shapeConversations).set({ issueUrl: "https://github.com/acme/app/issues/5" }).where(eq(shapeConversations.id, convId));
    expect((await app.inject({ method: "POST", url: `/api/shape/${convId}/repo`, headers: headers(jerryCookie), payload: { repoId: id.repo } })).statusCode).toBe(409);
  });

  it("lets an idea started under a product move into a new repository too", async () => {
    const convId = ((await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { repoId: id.repo } })).json() as { id: string }).id;
    const moved = await app.inject({ method: "POST", url: `/api/shape/${convId}/repo`, headers: headers(jerryCookie), payload: { repoId: id.repo } });
    expect(moved.statusCode).toBe(200);
  });

  it("does not resume a session that started on other instructions", async () => {
    const { resumableSession, storedSession } = await import("../src/routes/shape.js");
    expect(resumableSession(storedSession("abc"))).toBe("abc");
    expect(resumableSession("abc")).toBeNull(); // stored before versions were kept
    expect(resumableSession("0000000000:abc")).toBeNull(); // other instructions

    const d = deps.dbh.db;
    const convId = ((await app.inject({ method: "POST", url: "/api/shape", headers: headers(jerryCookie), payload: { newProduct: true } })).json() as { id: string }).id;
    await d.update(shapeConversations).set({ askSession: "old-session", askSessionAt: new Date() }).where(eq(shapeConversations.id, convId));
    const calls = stubNetwork("Fresh.", { session: "s2" });
    await say(convId, { text: "Hello again" });
    expect(calls.find((c) => c.url === `${ORCH}/ask`)!.body).not.toHaveProperty("session");
    const row = (await d.select().from(shapeConversations).where(eq(shapeConversations.id, convId)))[0]!;
    expect(row.askSession).toBe(storedSession("s2"));
  });
});

