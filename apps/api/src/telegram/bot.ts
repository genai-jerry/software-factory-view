import { ROLE_START_STATE, plainTitle, type WorkItem } from "@console/core";
import { telegramConversations, telegramLinkNonces, telegramLinks, telegramNotifications, users } from "@console/db";
import { and, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../context.js";
import { asUser } from "./as-user.js";
import { clip, esc, type Keyboard, type TelegramApi, type TgCallbackQuery, type TgMessage, type TgUpdate } from "./client.js";
import { decisionKey, decisionsFor, discussionIssue } from "./decisions.js";
import {
  SUMMARY_INSTRUCTIONS,
  ask,
  discussInstructions,
  hasExchange,
  isApproval,
  postRecord,
  recordBody,
  splitProposal,
  type Conversation,
} from "./discussion.js";
import { readLinkToken } from "./link-token.js";
import { RESOLVED_SUFFIX, gateWhat, renderDecision, roleStarts } from "./render.js";
import { sweepUser } from "./notifier.js";

/**
 * Everything the bot does with what a person sends it (openspec
 * telegram-decisions): linking, the decision buttons with their confirmation,
 * and discussions that end in a summary and a confirmed comment.
 */

type Notification = typeof telegramNotifications.$inferSelect;
type Link = typeof telegramLinks.$inferSelect;

const IDLE_MS = 24 * 3600_000;

export interface BotEnv {
  app: FastifyInstance;
  deps: AppDeps;
  tg: TelegramApi;
}

/** A message with no reply target, waiting for "Which decision is this about?". */
const pendingText = new Map<number, string>();

function settingsUrl(deps: AppDeps): string {
  return `${deps.cfg.PUBLIC_ORIGIN.replace(/\/$/, "")}/telegram`;
}

async function loginOf(deps: AppDeps, userId: string): Promise<string> {
  return (await deps.dbh.db.select({ login: users.login }).from(users).where(eq(users.id, userId)).limit(1))[0]?.login ?? "you";
}

async function linkFor(deps: AppDeps, chatId: number): Promise<Link | undefined> {
  return (await deps.dbh.db.select().from(telegramLinks).where(eq(telegramLinks.chatId, chatId)).limit(1))[0];
}

function itemOf(n: Notification): WorkItem {
  return n.item as unknown as WorkItem;
}

function titleOf(n: Notification): string {
  return itemOf(n).card.title;
}

export async function handleUpdate(env: BotEnv, u: TgUpdate): Promise<void> {
  if (u.message) return handleMessage(env, u.message);
  if (u.callback_query) return handleCallback(env, u.callback_query);
}

/* ------------------------------------------------------------------ messages */

async function handleMessage(env: BotEnv, m: TgMessage): Promise<void> {
  const { deps, tg } = env;
  if (m.chat.type !== "private" || m.from?.is_bot) return;
  const text = (m.text ?? "").trim();
  if (!text) return;
  const chatId = m.chat.id;

  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
  if (start) return linkChat(env, chatId, m.chat.username ?? m.from?.username ?? null, start[1]);

  const link = await linkFor(deps, chatId);
  if (!link) {
    await tg.sendMessage(chatId, `This chat is not connected to Compass. Connect it from <a href="${esc(settingsUrl(deps))}">Compass → Telegram</a>.`);
    return;
  }
  if (/^\/stop(?:@\w+)?$/.test(text)) return unlink(env, link, chatId);
  if (/^\/pause(?:@\w+)?$/.test(text)) {
    await deps.dbh.db.update(telegramLinks).set({ paused: true }).where(eq(telegramLinks.userId, link.userId));
    await tg.sendMessage(chatId, "Paused. No new decisions will be sent until you send /resume.");
    return;
  }
  if (/^\/resume(?:@\w+)?$/.test(text)) {
    await deps.dbh.db.update(telegramLinks).set({ paused: false }).where(eq(telegramLinks.userId, link.userId));
    await tg.sendMessage(chatId, "Resumed. Decisions waiting on you will arrive here.");
    return;
  }
  return routeText(env, link, m, text);
}

async function linkChat(env: BotEnv, chatId: number, username: string | null, token: string | undefined): Promise<void> {
  const { deps, tg } = env;
  const db = deps.dbh.db;
  if (!token) {
    const link = await linkFor(deps, chatId);
    await tg.sendMessage(
      chatId,
      link
        ? `Connected to GitHub @${esc(await loginOf(deps, link.userId))}. Decisions waiting on you arrive here.`
        : `To connect this chat, open <a href="${esc(settingsUrl(deps))}">Compass → Telegram</a> and tap Connect.`,
    );
    return;
  }
  const check = readLinkToken(deps.cfg.CONSOLE_MASTER_KEY, token);
  const used = check.ok ? (await db.insert(telegramLinkNonces).values({ nonce: check.nonce }).onConflictDoNothing().returning())[0] === undefined : false;
  if (!check.ok || used) {
    await tg.sendMessage(chatId, `That link has expired or was already used. Get a new one from <a href="${esc(settingsUrl(deps))}">Compass → Telegram</a>.`);
    return;
  }
  const login = await loginOf(deps, check.userId);
  // A chat belongs to one person, a person to one chat: linking again replaces both.
  await db.delete(telegramLinks).where(and(eq(telegramLinks.chatId, chatId), ne(telegramLinks.userId, check.userId)));
  await db
    .insert(telegramLinks)
    .values({ userId: check.userId, chatId, tgUsername: username, paused: false, primed: false })
    .onConflictDoUpdate({ target: telegramLinks.userId, set: { chatId, tgUsername: username, paused: false, primed: false, linkedAt: new Date() } });
  // Messages sent to an earlier chat cannot be edited from this one.
  await db.update(telegramNotifications).set({ resolvedAt: new Date() }).where(and(eq(telegramNotifications.userId, check.userId), isNull(telegramNotifications.resolvedAt)));
  await tg.sendMessage(chatId, `Linked to GitHub @${esc(login)}. Decisions waiting on you will arrive here.\n\nSend /pause to pause them, /stop to disconnect.`);
  await sweepUser(env.app, deps, tg, check.userId).catch((err) => env.app.log.warn({ err: (err as Error).message }, "telegram first sweep failed"));
}

async function unlink(env: BotEnv, link: Link, chatId: number): Promise<void> {
  const db = env.deps.dbh.db;
  await db.delete(telegramConversations).where(eq(telegramConversations.userId, link.userId));
  await db.delete(telegramNotifications).where(eq(telegramNotifications.userId, link.userId));
  await db.delete(telegramLinks).where(eq(telegramLinks.userId, link.userId));
  await env.tg.sendMessage(chatId, "Disconnected. Compass will not message this chat again. Connect again any time from Compass → Telegram.");
}

/* ---------------------------------------------------------------- callbacks */

async function handleCallback(env: BotEnv, cb: TgCallbackQuery): Promise<void> {
  const { deps, tg } = env;
  const chatId = cb.message?.chat.id;
  const [verb, id, idx] = (cb.data ?? "").split(":");
  await tg.answerCallback(cb.id).catch(() => undefined);
  if (!chatId || !verb || !id) return;
  const link = await linkFor(deps, chatId);
  if (!link) {
    await tg.sendMessage(chatId, `This chat is not connected to Compass. Connect it from <a href="${esc(settingsUrl(deps))}">Compass → Telegram</a>.`);
    return;
  }
  const at = cb.message!.message_id;
  if (["go", "st", "ya", "ys", "no", "ds", "pk"].includes(verb)) {
    const n = await notification(env, link.userId, id);
    if (!n) {
      await tg.editMessage(chatId, at, "This decision is no longer open here.", []);
      return;
    }
    if (verb === "go") return confirmGate(env, link, n);
    if (verb === "st") return confirmStart(env, link, n, Number(idx));
    if (verb === "ya") return approveGate(env, link, n, at);
    if (verb === "ys") return startRole(env, link, n, Number(idx), at);
    if (verb === "no") return void (await tg.editMessage(chatId, at, "Cancelled — nothing was posted.", []));
    if (verb === "ds") return openConversation(env, link, n, null);
    if (verb === "pk") {
      const text = pendingText.get(chatId);
      pendingText.delete(chatId);
      await tg.editMessage(chatId, at, `About: <b>${esc(titleOf(n))}</b>`, []);
      return openConversation(env, link, n, text ?? null);
    }
  }
  const conv = await conversation(env, link.userId, id);
  if (!conv) {
    await tg.editMessage(chatId, at, "This discussion has ended.", []);
    return;
  }
  if (verb === "cp" || verb === "cr") return postDecision(env, link, conv, at);
  if (verb === "ce") {
    await touch(env, conv.id, { status: "open" });
    await say(env, conv, "Tell me what to change — in the summary or in the comment — and I will redraft both.");
    return;
  }
  if (verb === "cx") return endConversation(env, link, conv, "cancelled");
}

async function notification(env: BotEnv, userId: string, id: string): Promise<Notification | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  return (
    await env.deps.dbh.db
      .select()
      .from(telegramNotifications)
      .where(and(eq(telegramNotifications.id, id), eq(telegramNotifications.userId, userId), isNull(telegramNotifications.resolvedAt)))
      .limit(1)
  )[0];
}

async function conversation(env: BotEnv, userId: string, id: string): Promise<Conversation | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  return (
    await env.deps.dbh.db
      .select()
      .from(telegramConversations)
      .where(and(eq(telegramConversations.id, id), eq(telegramConversations.userId, userId), inArray(telegramConversations.status, ["open", "drafted"])))
      .limit(1)
  )[0];
}

/** The decision is still open and still this person's: the same check as the page, right before acting. */
async function stillOpen(env: BotEnv, n: Notification): Promise<WorkItem | null | "unknown"> {
  const items = await decisionsFor(env.app, env.deps, n.userId);
  if (!items) return "unknown";
  return items.find((w) => decisionKey(w) === n.key) ?? null;
}

async function resolveNotification(env: BotEnv, n: Notification, line: string): Promise<void> {
  const { html } = renderDecision(itemOf(n), n.id, env.deps.cfg.PUBLIC_ORIGIN);
  if (n.messageId) await env.tg.editMessage(n.chatId, n.messageId, `${html}\n\n✅ ${line}`, []).catch(() => undefined);
  await env.deps.dbh.db.update(telegramNotifications).set({ resolvedAt: new Date() }).where(eq(telegramNotifications.id, n.id));
}

async function confirmGate(env: BotEnv, link: Link, n: Notification): Promise<void> {
  const w = itemOf(n);
  if (w.ask !== "decide" && w.ask !== "release") return;
  const what = gateWhat(w.entries.find((e) => e.kind === "gate")?.state);
  const login = await loginOf(env.deps, link.userId);
  await env.tg.sendMessage(
    link.chatId,
    `${esc(what.title)}: post <b>Approved</b> on “${esc(w.card.title)}” as @${esc(login)}?${what.after ? `\n<i>${esc(what.after)}</i>` : ""}`,
    [[{ text: "Yes, approve", callback_data: `ya:${n.id}` }, { text: "Cancel", callback_data: `no:${n.id}` }]],
    n.messageId || undefined,
  );
}

async function confirmStart(env: BotEnv, link: Link, n: Notification, i: number): Promise<void> {
  const e = roleStarts(itemOf(n))[i];
  if (!e) return;
  const noun = ROLE_START_STATE[e.state!]!.noun;
  await env.tg.sendMessage(
    link.chatId,
    `Start the ${noun} on “${esc(plainTitle(e.title) || e.title)}”?`,
    [[{ text: `Yes, start the ${noun}`, callback_data: `ys:${n.id}:${i}` }, { text: "Cancel", callback_data: `no:${n.id}` }]],
    n.messageId || undefined,
  );
}

function failure(r: { error: string | null; reauth: boolean }, deps: AppDeps): string {
  if (r.reauth) return `Your GitHub sign-in has lapsed, so nothing was posted. <a href="${esc(deps.cfg.PUBLIC_ORIGIN)}">Sign in to Compass</a> again, then tap Yes.`;
  return `Nothing was posted: ${esc(r.error ?? "Compass refused")}.`;
}

async function approveGate(env: BotEnv, link: Link, n: Notification, at: number): Promise<void> {
  const { deps, tg } = env;
  const now = await stillOpen(env, n);
  if (now === "unknown") return void (await tg.editMessage(link.chatId, at, failure({ error: "Compass could not read your decisions just now", reauth: false }, deps), retry(`ya:${n.id}`, n.id)));
  if (!now) {
    await tg.editMessage(link.chatId, at, "Already decided — nothing posted.", []);
    await resolveNotification(env, n, "Decided elsewhere.");
    return;
  }
  const r = await asUser<{ commentUrl?: string }>(env.app, deps, link.userId, "POST", `/api/epics/${n.epicId}/gate/approve`, { acknowledgeOpenQuestions: false });
  if (!r.ok) {
    const extra = r.status === 409 && /question/i.test(r.error ?? "") ? "\nOpen it in Compass to approve with the open questions acknowledged." : "";
    await tg.editMessage(link.chatId, at, failure(r, deps) + esc(extra), r.reauth ? retry(`ya:${n.id}`, n.id) : []);
    return;
  }
  const url = r.body?.commentUrl;
  await tg.editMessage(link.chatId, at, `✅ Approved as @${esc(await loginOf(deps, link.userId))}.${url ? ` <a href="${esc(url)}">The comment</a>` : ""} The factory has it.`, []);
  await resolveNotification(env, n, "Approved by you from Telegram.");
}

function retry(data: string, nid: string): Keyboard {
  return [[{ text: "Try again", callback_data: data }, { text: "Cancel", callback_data: `no:${nid}` }]];
}

async function startRole(env: BotEnv, link: Link, n: Notification, i: number, at: number): Promise<void> {
  const { deps, tg } = env;
  const e = roleStarts(itemOf(n))[i];
  if (!e) return;
  const now = await stillOpen(env, n);
  if (now === "unknown") return void (await tg.editMessage(link.chatId, at, failure({ error: "Compass could not read your decisions just now", reauth: false }, deps), retry(`ys:${n.id}:${i}`, n.id)));
  if (!now || !now.entries.some((x) => x.issueId === e.issueId && x.state === e.state)) {
    await tg.editMessage(link.chatId, at, "Already started or no longer waiting — nothing done.", []);
    return;
  }
  const role = ROLE_START_STATE[e.state!]!;
  const r = await asUser(env.app, deps, link.userId, "POST", `/api/issues/${e.issueId}/start-role`, { role: role.role });
  if (!r.ok) return void (await tg.editMessage(link.chatId, at, failure(r, deps), r.reauth ? retry(`ys:${n.id}:${i}`, n.id) : []));
  await tg.editMessage(link.chatId, at, `✅ Started the ${role.noun} on “${esc(plainTitle(e.title) || e.title)}”. The factory has it.`, []);
}

/* ------------------------------------------------------------- discussions */

async function routeText(env: BotEnv, link: Link, m: TgMessage, text: string): Promise<void> {
  const db = env.deps.dbh.db;
  const replyTo = m.reply_to_message?.message_id;
  if (replyTo) {
    const conv = (
      await db
        .select()
        .from(telegramConversations)
        .where(
          and(
            eq(telegramConversations.userId, link.userId),
            inArray(telegramConversations.status, ["open", "drafted"]),
            sql`${telegramConversations.messageIds} @> ${JSON.stringify([replyTo])}::jsonb`,
          ),
        )
        .limit(1)
    )[0];
    if (conv) return turn(env, link, conv, text);
    const n = (
      await db
        .select()
        .from(telegramNotifications)
        .where(and(eq(telegramNotifications.userId, link.userId), eq(telegramNotifications.chatId, link.chatId), eq(telegramNotifications.messageId, replyTo), isNull(telegramNotifications.resolvedAt)))
        .limit(1)
    )[0];
    if (n) return openConversation(env, link, n, text);
  }
  const latest = (
    await db
      .select()
      .from(telegramConversations)
      .where(
        and(
          eq(telegramConversations.userId, link.userId),
          inArray(telegramConversations.status, ["open", "drafted"]),
          gt(telegramConversations.updatedAt, new Date(Date.now() - IDLE_MS)),
        ),
      )
      .orderBy(desc(telegramConversations.updatedAt))
      .limit(1)
  )[0];
  if (latest) return turn(env, link, latest, text);

  const open = await db
    .select()
    .from(telegramNotifications)
    .where(and(eq(telegramNotifications.userId, link.userId), isNull(telegramNotifications.resolvedAt), ne(telegramNotifications.messageId, 0)))
    .orderBy(desc(telegramNotifications.sentAt))
    .limit(8);
  if (open.length === 0) {
    await env.tg.sendMessage(link.chatId, "Nothing is waiting on you right now, so there is nothing to discuss. New decisions arrive here as they come.");
    return;
  }
  if (open.length === 1) return openConversation(env, link, open[0]!, text);
  pendingText.set(link.chatId, text);
  await env.tg.sendMessage(
    link.chatId,
    "Which decision is this about?",
    open.map((n) => [{ text: clip(titleOf(n), 60), callback_data: `pk:${n.id}` }]),
  );
}

async function openConversation(env: BotEnv, link: Link, n: Notification, text: string | null): Promise<void> {
  const w = itemOf(n);
  const [conv] = await env.deps.dbh.db
    .insert(telegramConversations)
    .values({ userId: link.userId, notificationId: n.id, chatId: link.chatId, issueId: discussionIssue(w), epicId: w.card.epicId, messageIds: n.messageId ? [n.messageId] : [] })
    .returning();
  if (!conv) return;
  if (text) return turn(env, link, conv, text);
  await say(env, conv, `What would you like to know or decide about “${esc(w.card.title)}”? Reply here. Nothing is posted until you confirm.`);
}

/** Send a bot message in a conversation and remember it, so replies to it route back. */
async function say(env: BotEnv, conv: Conversation, html: string, keyboard?: Keyboard): Promise<number> {
  const sent = await env.tg.sendMessage(conv.chatId, html, keyboard);
  await env.deps.dbh.db
    .update(telegramConversations)
    .set({ messageIds: sql`${telegramConversations.messageIds} || ${JSON.stringify([sent.message_id])}::jsonb`, updatedAt: new Date() })
    .where(eq(telegramConversations.id, conv.id));
  return sent.message_id;
}

async function touch(env: BotEnv, id: string, set: Partial<typeof telegramConversations.$inferInsert>): Promise<void> {
  await env.deps.dbh.db.update(telegramConversations).set({ ...set, updatedAt: new Date() }).where(eq(telegramConversations.id, id));
}

async function decisionLine(env: BotEnv, conv: Conversation): Promise<{ line: string; n: Notification | undefined }> {
  const n = conv.notificationId ? (await env.deps.dbh.db.select().from(telegramNotifications).where(eq(telegramNotifications.id, conv.notificationId)).limit(1))[0] : undefined;
  if (!n) return { line: "a decision on this item", n };
  const w = itemOf(n);
  const gate = w.entries.find((e) => e.kind === "gate");
  const what =
    w.ask === "decide" || w.ask === "release"
      ? `${gateWhat(gate?.state).title} — approve, or ask for changes`
      : w.ask === "answer"
        ? `answer the builder's question${w.entries.find((e) => e.kind === "blocked")?.question ? `: “${w.entries.find((e) => e.kind === "blocked")!.question}”` : ""}`
        : w.pointer;
  return { line: `${what} on “${w.card.title}” (${w.card.repo})`, n };
}

/** Keep "typing…" up while Claude thinks. */
function typingWhile<T>(env: BotEnv, chatId: number, p: Promise<T>): Promise<T> {
  void env.tg.typing(chatId).catch(() => undefined);
  const t = setInterval(() => void env.tg.typing(chatId).catch(() => undefined), 4000);
  return p.finally(() => clearInterval(t));
}

async function turn(env: BotEnv, link: Link, conv: Conversation, text: string): Promise<void> {
  const { deps } = env;
  const login = await loginOf(deps, link.userId);
  const { line } = await decisionLine(env, conv);
  const editing = conv.status === "open" && conv.draft;
  const messages = [...conv.messages, { role: "user" as const, text, at: new Date().toISOString() }];
  await touch(env, conv.id, { messages, status: "open" });
  const current: Conversation = { ...conv, messages };
  const question = editing ? `${text}\n\n(The drafted comment was:\n${conv.draft}\nRedraft it with this change.)` : text;
  const got = await typingWhile(env, link.chatId, ask(deps, current, question, discussInstructions(login, line)));
  if (!got.ok) {
    // The orchestrator's own reason (it cannot read this repo, a usage limit…), not a guess.
    await say(env, current, `Claude could not answer this: ${esc(got.error)}\n\nNothing was posted.`);
    return;
  }
  const { text: shown, proposed } = splitProposal(got.answer);
  const after = [...messages, { role: "assistant" as const, text: got.answer, at: new Date().toISOString() }];
  await touch(env, conv.id, { messages: after, ...(got.session ? { session: got.session } : {}) });
  const withAnswer: Conversation = { ...current, messages: after, session: got.session ?? conv.session };
  if (shown) await say(env, withAnswer, esc(clip(shown)));
  if (!proposed) return;

  // A decision: draft the record of the discussion too, so the person confirms both texts.
  const sum = await typingWhile(env, link.chatId, ask(deps, withAnswer, "Summarise this discussion for the issue record.", SUMMARY_INSTRUCTIONS));
  if (!sum.ok) {
    await say(env, withAnswer, `I could not write the summary (${esc(sum.error)}), so nothing can be posted yet. Say “try again”.`);
    return;
  }
  const summary = splitProposal(sum.answer).text;
  await touch(env, conv.id, { status: "drafted", draft: proposed, summary, ...(sum.session ? { session: sum.session } : {}) });
  await showDraft(env, withAnswer, login, summary, proposed);
}

async function showDraft(env: BotEnv, conv: Conversation, login: string, summary: string, draft: string): Promise<void> {
  const { line } = await decisionLine(env, conv);
  await say(
    env,
    conv,
    [
      `Ready to post on ${esc(line.replace(/^.* on “/, "“"))}:`,
      "",
      "<b>1. The discussion summary</b> (posted by Compass):",
      `<blockquote>${esc(clip(summary, 1600))}</blockquote>`,
      `<b>2. Your comment</b> (posted as @${esc(login)}):`,
      `<blockquote>${esc(clip(draft, 1200))}</blockquote>`,
    ].join("\n"),
    [[{ text: "Post it", callback_data: `cp:${conv.id}` }, { text: "Edit", callback_data: `ce:${conv.id}` }, { text: "Cancel", callback_data: `cx:${conv.id}` }]],
  );
}

async function postDecision(env: BotEnv, link: Link, conv: Conversation, at: number): Promise<void> {
  const { deps, tg } = env;
  if (conv.status !== "drafted" || !conv.draft || !conv.summary) {
    await tg.editMessage(link.chatId, at, "There is no drafted comment to post. Tell me what you decided.", []);
    return;
  }
  const { n } = await decisionLine(env, conv);
  if (n) {
    const now = await stillOpen(env, n);
    if (now === "unknown") return void (await tg.editMessage(link.chatId, at, failure({ error: "Compass could not read your decisions just now", reauth: false }, deps), retryConv(conv.id)));
    if (!now) {
      await tg.editMessage(link.chatId, at, "Already decided — nothing posted.", []);
      await resolveNotification(env, n, "Decided elsewhere.");
      return endConversation(env, link, conv, "cancelled", true);
    }
  }
  const login = await loginOf(deps, link.userId);

  // 1. The record of the discussion, as the Compass app — never twice.
  let summaryId = conv.summaryCommentId;
  let summaryUrl: string | null = null;
  if (!summaryId) {
    try {
      const rec = await postRecord(deps, conv.issueId, recordBody(login, conv.summary, true));
      summaryId = rec.id;
      summaryUrl = rec.url;
      await touch(env, conv.id, { summaryCommentId: rec.id });
    } catch (err) {
      await tg.editMessage(link.chatId, at, `Nothing was posted: GitHub refused the discussion summary (${esc((err as Error).message)}).`, retryConv(conv.id));
      return;
    }
  }

  // 2. The decision, as the person, through the same route the page uses.
  const gateAsk = n && (itemOf(n).ask === "decide" || itemOf(n).ask === "release");
  const r =
    gateAsk && isApproval(conv.draft)
      ? await asUser<{ commentUrl?: string }>(env.app, deps, link.userId, "POST", `/api/epics/${conv.epicId}/gate/approve`, { acknowledgeOpenQuestions: false })
      : gateAsk
        ? await asUser<{ commentUrl?: string }>(env.app, deps, link.userId, "POST", `/api/epics/${conv.epicId}/gate/request-changes`, { body: conv.draft })
        : await asUser<{ commentUrl?: string }>(env.app, deps, link.userId, "POST", `/api/issues/${conv.issueId}/reply`, { body: conv.draft });
  if (!r.ok) {
    await tg.editMessage(
      link.chatId,
      at,
      `The discussion summary is on the issue, but your comment was not posted. ${failure(r, deps)}`,
      [[{ text: "Try again (comment only)", callback_data: `cr:${conv.id}` }, { text: "Cancel", callback_data: `cx:${conv.id}` }]],
    );
    return;
  }
  await touch(env, conv.id, { status: "posted" });
  const url = r.body?.commentUrl;
  await tg.editMessage(
    link.chatId,
    at,
    `✅ Posted: the discussion summary${summaryUrl ? ` (<a href="${esc(summaryUrl)}">link</a>)` : ""}, then your comment as @${esc(login)}${url ? ` (<a href="${esc(url)}">link</a>)` : ""}.`,
    [],
  );
  if (n) await resolveNotification(env, n, gateAsk && isApproval(conv.draft) ? "Approved by you from Telegram." : "Answered by you from Telegram.");
}

function retryConv(id: string): Keyboard {
  return [[{ text: "Try again", callback_data: `cr:${id}` }, { text: "Cancel", callback_data: `cx:${id}` }]];
}

/**
 * Close a discussion. One that had a real exchange and no record yet leaves
 * a "No decision yet" summary on the issue, so nothing said is lost.
 */
async function endConversation(env: BotEnv, link: Link, conv: Conversation, status: "cancelled" | "expired", quiet = false): Promise<void> {
  const { deps } = env;
  let note = status === "expired" ? "Closed after a day without replies." : "Cancelled — no decision was posted.";
  if (hasExchange(conv) && !conv.summaryCommentId) {
    const sum = await ask(deps, conv, "Summarise this discussion for the issue record. Nothing was decided.", SUMMARY_INSTRUCTIONS);
    if (sum.ok) {
      try {
        await postRecord(deps, conv.issueId, recordBody(await loginOf(deps, link.userId), splitProposal(sum.answer).text, false));
        note += " The discussion summary is on the issue.";
      } catch (err) {
        note += ` The summary could not be posted (${esc((err as Error).message)}).`;
      }
    }
  }
  await touch(env, conv.id, { status });
  if (!quiet) await env.tg.sendMessage(link.chatId, note);
}

/** Discussions idle for a day are closed (and summarised), from the notifier's sweep. */
export async function expireIdle(env: BotEnv): Promise<void> {
  const db = env.deps.dbh.db;
  const idle = await db
    .select()
    .from(telegramConversations)
    .where(and(inArray(telegramConversations.status, ["open", "drafted"]), lt(telegramConversations.updatedAt, new Date(Date.now() - IDLE_MS))));
  for (const conv of idle) {
    const link = (await db.select().from(telegramLinks).where(eq(telegramLinks.userId, conv.userId)).limit(1))[0];
    if (!link) continue;
    await endConversation(env, link, conv, "expired").catch((err) => env.app.log.warn({ err: (err as Error).message }, "telegram expire failed"));
  }
  await db.delete(telegramLinkNonces).where(lt(telegramLinkNonces.usedAt, new Date(Date.now() - IDLE_MS)));
}

export { RESOLVED_SUFFIX };
