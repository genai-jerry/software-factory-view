import { timingSafeEqual } from "node:crypto";
import { telegramConversations, telegramLinks, telegramNotifications, telegramUpdates } from "@console/db";
import { eq, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps } from "../context.js";
import { handleUpdate, expireIdle, type BotEnv } from "./bot.js";
import { TelegramClient, type TelegramApi, type TgUpdate } from "./client.js";
import { makeLinkToken } from "./link-token.js";
import { sweepAll } from "./notifier.js";

/**
 * Telegram decisions (openspec telegram-decisions). Off unless
 * TELEGRAM_BOT_TOKEN is set. The routes are registered either way so the
 * page can say the feature is off; the webhook and timer exist only when on.
 */

export function telegramEnabled(deps: AppDeps): boolean {
  return Boolean(deps.cfg.TELEGRAM_BOT_TOKEN && deps.cfg.TELEGRAM_WEBHOOK_SECRET && deps.cfg.TELEGRAM_BOT_USERNAME && deps.cfg.CONSOLE_MASTER_KEY);
}

const clients = new WeakMap<AppDeps, TelegramApi>();

/** The bot client for these deps; tests install a fake with `useTelegramApi`. */
export function telegramApi(deps: AppDeps): TelegramApi {
  let c = clients.get(deps);
  if (!c) {
    c = new TelegramClient(deps.cfg.TELEGRAM_BOT_TOKEN);
    clients.set(deps, c);
  }
  return c;
}

export function useTelegramApi(deps: AppDeps, api: TelegramApi): void {
  clients.set(deps, api);
}

function secretMatches(got: unknown, want: string): boolean {
  if (typeof got !== "string" || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export function registerTelegramRoutes(app: FastifyInstance, deps: AppDeps): void {
  const db = deps.dbh.db;
  const env = (): BotEnv => ({ app, deps, tg: telegramApi(deps) });

  /** Telegram → Compass. Answered at once; the work happens after. */
  app.post<{ Body: TgUpdate }>("/api/telegram/webhook", async (req, reply) => {
    if (!telegramEnabled(deps)) return reply.code(404).send({ error: "not found" });
    if (!secretMatches(req.headers["x-telegram-bot-api-secret-token"], deps.cfg.TELEGRAM_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const update = req.body;
    if (!update || typeof update.update_id !== "number") return reply.code(400).send({ error: "bad update" });
    const fresh = await db.insert(telegramUpdates).values({ updateId: update.update_id }).onConflictDoNothing().returning();
    if (fresh.length > 0) {
      void handleUpdate(env(), update).catch((err) => app.log.warn({ err: (err as Error).message }, "telegram update failed"));
    }
    return { ok: true };
  });

  /** The person's own link: status. */
  app.get("/api/me/telegram", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    if (!telegramEnabled(deps)) return { enabled: false };
    const link = (await db.select().from(telegramLinks).where(eq(telegramLinks.userId, ctx.userId)).limit(1))[0];
    return {
      enabled: true,
      botUsername: deps.cfg.TELEGRAM_BOT_USERNAME,
      linked: Boolean(link),
      tgUsername: link?.tgUsername ?? null,
      paused: link?.paused ?? false,
      linkedAt: link?.linkedAt ?? null,
    };
  });

  /** A one-time link that opens the bot and ties the chat to this login. */
  app.post("/api/me/telegram/link", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    if (!telegramEnabled(deps)) return reply.code(404).send({ error: "Telegram is not set up on this Compass" });
    const token = makeLinkToken(deps.cfg.CONSOLE_MASTER_KEY, ctx.userId);
    return { url: `https://t.me/${deps.cfg.TELEGRAM_BOT_USERNAME}?start=${token}`, expiresInMinutes: 15 };
  });

  app.patch<{ Body: { paused?: boolean } }>("/api/me/telegram", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const paused = req.body?.paused === true;
    const done = await db.update(telegramLinks).set({ paused }).where(eq(telegramLinks.userId, ctx.userId)).returning();
    if (done.length === 0) return reply.code(404).send({ error: "Telegram is not connected" });
    return { ok: true, paused };
  });

  /** Disconnect: the link and everything kept for it go. */
  app.delete("/api/me/telegram", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const link = (await db.select().from(telegramLinks).where(eq(telegramLinks.userId, ctx.userId)).limit(1))[0];
    await db.delete(telegramConversations).where(eq(telegramConversations.userId, ctx.userId));
    await db.delete(telegramNotifications).where(eq(telegramNotifications.userId, ctx.userId));
    await db.delete(telegramLinks).where(eq(telegramLinks.userId, ctx.userId));
    if (link && telegramEnabled(deps)) {
      await telegramApi(deps)
        .sendMessage(link.chatId, "Disconnected from Compass. This chat will not get any more messages.")
        .catch(() => undefined);
    }
    return { ok: true };
  });
}

/**
 * Register the webhook with Telegram and start the minute sweep. Called once
 * from the API entry point after it is listening (never from tests).
 */
export async function startTelegram(app: FastifyInstance, deps: AppDeps): Promise<() => void> {
  if (!telegramEnabled(deps)) {
    app.log.info("telegram: off (TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET are not all set)");
    return () => undefined;
  }
  const env: BotEnv = { app, deps, tg: telegramApi(deps) };
  const url = `${deps.cfg.PUBLIC_ORIGIN.replace(/\/$/, "")}/api/telegram/webhook`;
  try {
    await env.tg.setWebhook(url, deps.cfg.TELEGRAM_WEBHOOK_SECRET);
    app.log.info(`telegram: webhook set to ${url}`);
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, "telegram: setWebhook failed; the sweep still runs");
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepAll(app, deps, env.tg);
      await expireIdle(env);
      await deps.dbh.db.delete(telegramUpdates).where(lt(telegramUpdates.receivedAt, new Date(Date.now() - 86_400_000)));
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, "telegram sweep failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  void tick();
  return () => clearInterval(timer);
}
