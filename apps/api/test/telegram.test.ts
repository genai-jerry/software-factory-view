import { randomBytes } from "node:crypto";
import { CredentialStore, encryptSecret, loadConfig } from "@console/core";
import {
  estates,
  issues,
  memberships,
  orgs,
  repos,
  sessions,
  telegramConversations,
  telegramLinks,
  telegramNotifications,
  users,
} from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";
import { handleUpdate, type BotEnv } from "../src/telegram/bot.js";
import { esc } from "../src/telegram/client.js";
import type { Keyboard, TelegramApi, TgMessage } from "../src/telegram/client.js";
import { makeLinkToken, readLinkToken } from "../src/telegram/link-token.js";
import { sweepUser } from "../src/telegram/notifier.js";

/**
 * Telegram decisions (openspec telegram-decisions), end to end against the
 * real routes: a person links a chat, is sent what waits on them, approves
 * with a confirmed button as themselves, and a discussion leaves its summary
 * on the issue (as the Compass app) before their decision.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const API_URL = "https://gh.test";
const ORCH = "http://orch.test";
const CHAT = 4242;

let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>;
const id: Record<string, string> = {};

/** A Telegram that records what the bot says. */
class FakeTelegram implements TelegramApi {
  next = 100;
  sent: Array<{ chatId: number; html: string; keyboard?: Keyboard; replyTo?: number; id: number }> = [];
  edits: Array<{ chatId: number; messageId: number; html: string; keyboard?: Keyboard }> = [];
  async sendMessage(chatId: number, html: string, keyboard?: Keyboard, replyTo?: number): Promise<TgMessage> {
    const message_id = this.next++;
    this.sent.push({ chatId, html, keyboard, replyTo, id: message_id });
    return { message_id, chat: { id: chatId, type: "private" } };
  }
  async editMessage(chatId: number, messageId: number, html: string, keyboard?: Keyboard) {
    this.edits.push({ chatId, messageId, html, keyboard });
  }
  async answerCallback() {}
  async typing() {}
  async setWebhook() {}
  reset() {
    this.sent = [];
    this.edits = [];
  }
  last() {
    return this.sent[this.sent.length - 1]!;
  }
  button(text: RegExp, from = this.last()) {
    const b = from.keyboard?.flat().find((x) => text.test(x.text));
    if (!b?.callback_data) throw new Error(`no button ${text} in ${JSON.stringify(from.keyboard)}`);
    return b.callback_data;
  }
}

let tg: FakeTelegram;
let env: BotEnv;
let update = 1;

const say = (text: string, replyTo?: number) =>
  handleUpdate(env, {
    update_id: update++,
    message: { message_id: 9000 + update, chat: { id: CHAT, type: "private" }, from: { id: CHAT }, text, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) },
  });
const tap = (data: string, messageId = tg.last().id) =>
  handleUpdate(env, { update_id: update++, callback_query: { id: `cb${update}`, from: { id: CHAT }, data, message: { message_id: messageId, chat: { id: CHAT, type: "private" } } } });

/** GitHub and the orchestrator, in order: who posted what, as whom. */
let github: Array<{ url: string; auth: string; body: string }> = [];
let answers: string[] = [];
let failRecord = false;
let failDecision = false;
let asked: Array<Record<string, unknown>> = [];
function stubNetwork() {
  github = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === `${ORCH}/ask`) {
        asked.push(JSON.parse(String(init?.body)));
        const answer = answers.shift() ?? "ok";
        return new Response(JSON.stringify({ answer, model: "m", session: "s1" }), { status: 200 });
      }
      if (u.startsWith(API_URL) && init?.method === "POST" && u.endsWith("/comments")) {
        const auth = String((init.headers as Record<string, string>)?.authorization ?? (init.headers as Record<string, string>)?.Authorization ?? "");
        const body = JSON.parse(String(init.body)).body as string;
        if (failRecord && /inst-token/.test(auth)) return new Response(JSON.stringify({ message: "nope" }), { status: 403 });
        if (failDecision && /user-token/.test(auth)) return new Response(JSON.stringify({ message: "busy" }), { status: 502 });
        github.push({ url: u, auth, body });
        const n = github.length;
        return new Response(JSON.stringify({ id: 500 + n, node_id: `C${n}`, html_url: `https://gh/1#c${n}`, body, user: { login: "x" }, created_at: "", updated_at: "" }), { status: 201 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
}

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
    GITHUB_API_URL: API_URL,
    ORCHESTRATOR_URL: ORCH,
    ORCHESTRATOR_DISPATCH_TOKEN: "d",
    PUBLIC_ORIGIN: "https://compass.test",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_BOT_USERNAME: "compass_bot",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    NODE_ENV: "test",
  } as never);
  const credentials = new CredentialStore({
    masterKey: MASTER_KEY,
    apiUrl: API_URL,
    load: async () => null,
    env: { appId: "1", privateKeyPem: "x", webhookSecret: "s", clientId: "c", clientSecret: "cs" },
  });
  // The App's installation token, for the discussion record.
  credentials.auth = (async () => ({ installationToken: async () => "inst-token" })) as never;
  deps = {
    cfg,
    dbh: { db, sql: null as never, close: async () => undefined },
    credentials,
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  app = await buildApp(deps);

  const d = deps.dbh.db;
  const alice = (await d.insert(users).values({ ghUserId: 1, login: "alice", encryptedOauthToken: encryptSecret("user-token", MASTER_KEY) }).returning())[0]!;
  const org = (await d.insert(orgs).values({ name: "acme" }).returning())[0]!;
  await d.insert(memberships).values({ orgId: org.id, userId: alice.id, role: "owner" });
  await d.insert(sessions).values({ id: "sess-1", userId: alice.id, expiresAt: new Date(Date.now() + 3600_000) });
  const estate = (await d.insert(estates).values({ orgId: org.id, name: "acme", installationId: 1 }).returning())[0]!;
  const repo = (await d.insert(repos).values({ orgId: org.id, estateId: estate.id, ghNodeId: "R1", fullName: "acme/app" }).returning())[0]!;
  const epic = (
    await d
      .insert(issues)
      .values({
        orgId: org.id,
        repoId: repo.id,
        ghNodeId: "I1",
        number: 1,
        title: "Reminders follow the clinic's hours",
        kind: "epic",
        state: "open",
        factoryState: "factory:spec-ready",
        labels: ["factory:spec-ready"],
        ghUpdatedAt: new Date(),
        ghCreatedAt: new Date("2026-11-01T00:00:00Z"),
        htmlUrl: "https://gh/1",
      })
      .returning()
  )[0]!;
  id.alice = alice.id;
  id.epic = epic.id;
  tg = new FakeTelegram();
  env = { app, deps, tg };
});

beforeEach(() => {
  stubNetwork();
  answers = [];
  asked = [];
  failRecord = false;
  failDecision = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function relink() {
  const d = deps.dbh.db;
  await d.delete(telegramConversations);
  await d.delete(telegramNotifications);
  await d.delete(telegramLinks);
  await d.update(issues).set({ factoryState: "factory:spec-ready", labels: ["factory:spec-ready"] }).where(eq(issues.id, id.epic!));
  tg.reset();
  await say(`/start ${makeLinkToken(MASTER_KEY, id.alice!)}`);
}

describe("linking a chat", () => {
  it("links with a one-time start link and refuses it a second time", async () => {
    const res = await app.inject({ method: "POST", url: "/api/me/telegram/link", headers: { cookie: "console_session=sess-1", "x-console-csrf": "1" } });
    expect(res.statusCode).toBe(200);
    const url = res.json().url as string;
    expect(url).toMatch(/^https:\/\/t\.me\/compass_bot\?start=[A-Za-z0-9_-]{51}$/);
    const token = url.split("start=")[1]!;

    tg.reset();
    await say(`/start ${token}`);
    expect(tg.sent[0]!.html).toContain("Linked to GitHub @alice");
    const status = await app.inject({ method: "GET", url: "/api/me/telegram", headers: { cookie: "console_session=sess-1" } });
    expect(status.json()).toMatchObject({ enabled: true, linked: true, paused: false });

    tg.reset();
    await say(`/start ${token}`);
    expect(tg.last().html).toMatch(/expired or was already used/);
  });

  it("escapes what goes into the bot's HTML, quotes included (links are href attributes)", () => {
    expect(esc(`a<b>&"c"`)).toBe("a&lt;b&gt;&amp;&quot;c&quot;");
  });

  it("refuses an expired or forged token", () => {
    const old = makeLinkToken(MASTER_KEY, "00000000-0000-0000-0000-000000000001", Date.now() - 20 * 60_000);
    expect(readLinkToken(MASTER_KEY, old)).toEqual({ ok: false, reason: "expired" });
    expect(readLinkToken("another-key", makeLinkToken(MASTER_KEY, "00000000-0000-0000-0000-000000000001"))).toEqual({ ok: false, reason: "invalid" });
  });

  it("answers a stranger's chat with how to connect, and acts on nothing", async () => {
    tg.reset();
    await handleUpdate(env, { update_id: update++, message: { message_id: 1, chat: { id: 777, type: "private" }, text: "approve it" } });
    expect(tg.last().html).toMatch(/not connected to Compass/);
    expect(github).toEqual([]);
  });

  it("rejects a webhook call without the secret", async () => {
    const res = await app.inject({ method: "POST", url: "/api/telegram/webhook", payload: { update_id: 1 } });
    expect(res.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/api/telegram/webhook", headers: { "x-telegram-bot-api-secret-token": "hook-secret" }, payload: { update_id: 99999 } });
    expect(ok.statusCode).toBe(200);
  });
});

describe("decision messages", () => {
  it("sends a waiting decision once, then marks it done when it leaves the list", async () => {
    await relink();
    const msg = tg.sent.find((m) => m.html.includes("Approve the plan"));
    expect(msg, JSON.stringify(tg.sent)).toBeDefined();
    expect(msg!.html).toContain("Reminders follow the clinic&#39;s hours".replace("&#39;", "'"));
    expect(msg!.keyboard?.flat().map((b) => b.text)).toEqual(["Approve the plan", "Discuss or ask for changes", "Open in Compass"]);

    tg.reset();
    await sweepUser(app, deps, tg, id.alice!);
    expect(tg.sent).toEqual([]);

    await deps.dbh.db.update(issues).set({ factoryState: "factory:spec-approved", labels: ["factory:spec-approved"] }).where(eq(issues.id, id.epic!));
    await sweepUser(app, deps, tg, id.alice!);
    expect(tg.edits.at(-1)!.html).toMatch(/Done.*no longer waiting on you/);
    expect(tg.edits.at(-1)!.keyboard).toEqual([]);
  });
});

describe("deciding with a button", () => {
  it("asks first, then posts Approved as the person, and leaves no session behind", async () => {
    await relink();
    const msg = tg.sent.find((m) => m.html.includes("Approve the plan"))!;
    await tap(tg.button(/Approve the plan/, msg), msg.id);
    expect(tg.last().html).toMatch(/post <b>Approved<\/b> on “Reminders follow the clinic's hours” as @alice\?/);
    expect(github).toEqual([]);

    const sessionsBefore = (await deps.dbh.db.select().from(sessions)).length;
    const confirm = tg.last();
    await tap(tg.button(/Yes, approve/, confirm), confirm.id);
    expect(github).toHaveLength(1);
    expect(github[0]).toMatchObject({ url: `${API_URL}/repos/acme/app/issues/1/comments`, body: "Approved" });
    expect(github[0]!.auth).toContain("user-token");
    expect(tg.edits.find((e) => e.messageId === confirm.id)!.html).toMatch(/Approved as @alice/);
    expect((await deps.dbh.db.select().from(sessions)).length).toBe(sessionsBefore);
  });

  it("posts nothing when the decision was already taken elsewhere", async () => {
    await relink();
    const msg = tg.sent.find((m) => m.html.includes("Approve the plan"))!;
    await tap(tg.button(/Approve the plan/, msg), msg.id);
    const confirm = tg.last();
    await deps.dbh.db.update(issues).set({ factoryState: "factory:spec-approved", labels: ["factory:spec-approved"] }).where(eq(issues.id, id.epic!));
    await tap(tg.button(/Yes, approve/, confirm), confirm.id);
    expect(github).toEqual([]);
    expect(tg.edits.find((e) => e.messageId === confirm.id)!.html).toBe("Already decided — nothing posted.");
  });
});

describe("discussing a decision", () => {
  it("answers questions without posting, then posts the summary as the app before the person's decision", async () => {
    await relink();
    const msg = tg.sent.find((m) => m.html.includes("Approve the plan"))!;
    answers = ["The plan keeps reminders inside opening hours."];
    await say("what does the plan change?", msg.id);
    expect(tg.last().html).toContain("inside opening hours");
    expect(github).toEqual([]);

    answers = ["Fine.\n\nPROPOSED COMMENT:\nApproved", "- Asked what the plan changes; reminders stay inside opening hours.\n- Decided: approve."];
    await say("ok, approve it");
    const draft = tg.last();
    expect(draft.html).toContain("The discussion summary");
    expect(draft.html).toContain("reminders stay inside opening hours");
    expect(draft.html).toMatch(/Your comment<\/b> \(posted as @alice\)/);
    expect(github).toEqual([]);

    await tap(tg.button(/Post it/, draft), draft.id);
    expect(github.map((g) => g.body.split("\n")[0])).toEqual(["**Discussion on Telegram with @alice** · " + new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }), "Approved"]);
    expect(github[0]!.auth).toContain("inst-token");
    expect(github[1]!.auth).toContain("user-token");
    expect(github[0]!.body).toContain("The decision follows as @alice's own comment.");
  });

  it("posts neither when GitHub refuses the summary", async () => {
    await relink();
    const msg = tg.sent.find((m) => m.html.includes("Approve the plan"))!;
    answers = ["PROPOSED COMMENT:\nApproved", "- Decided: approve."];
    await say("approve it", msg.id);
    failRecord = true;
    const draft = tg.last();
    await tap(tg.button(/Post it/, draft), draft.id);
    expect(github).toEqual([]);
    expect(tg.edits.at(-1)!.html).toMatch(/Nothing was posted: GitHub refused the discussion summary/);
  });

  it("leaves a 'no decision' summary when a real discussion is cancelled", async () => {
    await relink();
    const msg = tg.sent.find((m) => m.html.includes("Approve the plan"))!;
    answers = ["It changes the reminder window.", "- Asked about the reminder window.\n- No decision yet."];
    await say("what changes?", msg.id);
    const conv = (await deps.dbh.db.select().from(telegramConversations))[0]!;
    await tap(`cx:${conv.id}`);
    expect(github).toHaveLength(1);
    expect(github[0]!.auth).toContain("inst-token");
    expect(github[0]!.body).toContain("No decision was posted.");
    expect(tg.last().html).toMatch(/summary is on the issue/);
  });

  it("resumes the same Claude session on every turn of a discussion", async () => {
    await relink();
    const msg = tg.sent.find((m) => m.html.includes("Approve the plan"))!;
    answers = ["First answer.", "Second answer."];
    await say("first question", msg.id);
    await say("second question");
    expect(asked).toHaveLength(2);
    expect(asked[0]!.session).toBeUndefined();
    expect(asked[1]!.session).toBe("s1");
    expect(asked[0]!.conversation).toBe(asked[1]!.conversation);
    expect(String(asked[1]!.context)).toContain("Person: first question");
  });

  it("retries only the decision when the summary went in but the comment failed", async () => {
    await relink();
    const msg = tg.sent.find((m) => m.html.includes("Approve the plan"))!;
    answers = ["PROPOSED COMMENT:\nApproved", "- Decided: approve."];
    await say("approve it", msg.id);
    failDecision = true;
    const draft = tg.last();
    await tap(tg.button(/Post it/, draft), draft.id);
    expect(github.map((g) => (/inst-token/.test(g.auth) ? "summary" : "decision"))).toEqual(["summary"]);
    const failed = tg.edits.at(-1)!;
    expect(failed.html).toMatch(/summary is on the issue, but your comment was not posted/);

    failDecision = false;
    await tap(failed.keyboard!.flat().find((b) => /Try again/.test(b.text))!.callback_data!, draft.id);
    expect(github.map((g) => (/inst-token/.test(g.auth) ? "summary" : "decision"))).toEqual(["summary", "decision"]);
  });
});
