import { randomUUID } from "node:crypto";
import type { WorkItem } from "@console/core";
import { telegramLinks, telegramNotifications } from "@console/db";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../context.js";
import type { TelegramApi } from "./client.js";
import { decisionKey, decisionsFor } from "./decisions.js";
import { RESOLVED_SUFFIX, renderDecision } from "./render.js";

/** The first sweep after linking sends at most this many, newest first. */
export const FIRST_SWEEP_CAP = 10;

/**
 * One notifier pass for one person (openspec telegram-decisions, design §4):
 * send each new decision once, keep an open message in step with its card,
 * and mark the ones that left the list as done.
 */
export async function sweepUser(app: FastifyInstance, deps: AppDeps, tg: TelegramApi, userId: string): Promise<{ sent: number; edited: number; resolved: number } | null> {
  const db = deps.dbh.db;
  const link = (await db.select().from(telegramLinks).where(eq(telegramLinks.userId, userId)).limit(1))[0];
  if (!link || link.paused) return null;
  const items = await decisionsFor(app, deps, userId);
  if (!items) return null;
  const origin = deps.cfg.PUBLIC_ORIGIN;

  const open = await db
    .select()
    .from(telegramNotifications)
    .where(and(eq(telegramNotifications.userId, userId), isNull(telegramNotifications.resolvedAt)));
  const byKey = new Map(open.map((r) => [r.key, r]));
  const seen = new Set<string>();
  let sent = 0;
  let edited = 0;
  let resolved = 0;

  const fresh: WorkItem[] = [];
  for (const w of items) {
    const key = decisionKey(w);
    seen.add(key);
    const row = byKey.get(key);
    if (!row) {
      fresh.push(w);
      continue;
    }
    if (row.messageId === 0) continue; // held back by the first sweep's cap
    const now = renderDecision(w, row.id, origin);
    const before = renderDecision(row.item as unknown as WorkItem, row.id, origin);
    if (now.html !== before.html || JSON.stringify(now.keyboard) !== JSON.stringify(before.keyboard)) {
      await tg.editMessage(link.chatId, row.messageId, now.html, now.keyboard);
      await db.update(telegramNotifications).set({ item: w as unknown as Record<string, unknown> }).where(eq(telegramNotifications.id, row.id));
      edited += 1;
    }
  }

  // `items` is newest first; on the first sweep only the newest few are sent.
  const cap = link.primed ? fresh.length : Math.min(fresh.length, FIRST_SWEEP_CAP);
  for (const [i, w] of fresh.entries()) {
    const id = randomUUID();
    let messageId = 0;
    if (i < cap) {
      const { html, keyboard } = renderDecision(w, id, origin);
      messageId = (await tg.sendMessage(link.chatId, html, keyboard)).message_id;
      sent += 1;
    }
    await db
      .insert(telegramNotifications)
      .values({ id, userId, key: decisionKey(w), chatId: link.chatId, messageId, epicId: w.card.epicId, repo: w.card.repo, ask: w.ask ?? "", item: w as unknown as Record<string, unknown> })
      .onConflictDoNothing();
  }
  if (!link.primed) {
    const held = fresh.length - cap;
    if (held > 0) await tg.sendMessage(link.chatId, `…and ${held} more waiting on you in Compass. New ones arrive here as they come.`);
    await db.update(telegramLinks).set({ primed: true }).where(eq(telegramLinks.userId, userId));
  }

  for (const row of open) {
    if (seen.has(row.key)) continue;
    if (row.messageId !== 0) {
      const { html } = renderDecision(row.item as unknown as WorkItem, row.id, origin);
      await tg.editMessage(link.chatId, row.messageId, html + RESOLVED_SUFFIX, []).catch(() => undefined);
    }
    await db.update(telegramNotifications).set({ resolvedAt: new Date() }).where(eq(telegramNotifications.id, row.id));
    resolved += 1;
  }
  return { sent, edited, resolved };
}

/** Every linked, unpaused person. One person's failure never stops the rest. */
export async function sweepAll(app: FastifyInstance, deps: AppDeps, tg: TelegramApi): Promise<void> {
  const links = await deps.dbh.db.select({ userId: telegramLinks.userId }).from(telegramLinks).where(eq(telegramLinks.paused, false));
  for (const { userId } of links) {
    try {
      await sweepUser(app, deps, tg, userId);
    } catch (err) {
      app.log.warn({ err: (err as Error).message, userId }, "telegram sweep failed for a user");
    }
  }
}
