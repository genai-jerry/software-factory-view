import { randomBytes } from "node:crypto";
import { sessions } from "@console/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { CSRF_HEADER, SESSION_COOKIE, type AppDeps } from "../context.js";

/**
 * Call Compass's own HTTP routes in-process as a linked person (openspec
 * telegram-decisions, design §2a). A session row is minted for them, used for
 * one injected request, and deleted — so every permission check, approver
 * rule, error message and GitHub write is exactly what the page gets, and the
 * comment is authored by the person with their own GitHub sign-in.
 * `app.inject` never touches the network: the session cannot be used from
 * outside, and it expires in two minutes even if the delete were missed.
 */
export interface AsUserResult<T> {
  status: number;
  ok: boolean;
  body: T;
  /** The route's own error message, for the bot to repeat. */
  error: string | null;
  /** The route asked for a fresh sign-in (lapsed or revoked GitHub grant). */
  reauth: boolean;
}

export async function asUser<T = unknown>(
  app: FastifyInstance,
  deps: AppDeps,
  userId: string,
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
): Promise<AsUserResult<T>> {
  const sid = `tg_${randomBytes(24).toString("base64url")}`;
  const db = deps.dbh.db;
  await db.insert(sessions).values({ id: sid, userId, expiresAt: new Date(Date.now() + 2 * 60_000) });
  try {
    const res = await app.inject({
      method,
      url,
      cookies: { [SESSION_COOKIE]: sid },
      headers: { [CSRF_HEADER]: "1", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
    let body: unknown = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = res.body;
    }
    const obj = (body && typeof body === "object" ? body : {}) as { error?: unknown; reauth?: unknown };
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    return {
      status: res.statusCode,
      ok,
      body: body as T,
      error: ok ? null : typeof obj.error === "string" ? obj.error : `Compass answered ${res.statusCode}`,
      reauth: res.statusCode === 401 || obj.reauth === true,
    };
  } finally {
    await db.delete(sessions).where(eq(sessions.id, sid));
  }
}
