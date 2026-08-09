import { CredentialStore, decryptSecret, UserClient, type ConsoleConfig } from "@console/core";
import { memberships, sessions, users, type Db, type DbHandle } from "@console/db";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Queue } from "bullmq";

/** Per-process dependencies threaded through routes. */
export interface AppDeps {
  cfg: ConsoleConfig;
  dbh: DbHandle;
  /** Resolves the Console's GitHub App credentials (database first, env fallback). */
  credentials: CredentialStore;
  ingestQueue: Queue;
  reconcileQueue: Queue;
}

/** Per-request authenticated context: the caller and their org scope. */
export interface RequestCtx {
  userId: string;
  login: string;
  orgIds: string[];
  userToken: () => string; // decrypts lazily; throws if absent
}

export const SESSION_COOKIE = "console_session";
export const CSRF_HEADER = "x-console-csrf";

export async function resolveSession(db: Db, cfg: ConsoleConfig, req: FastifyRequest): Promise<RequestCtx | null> {
  const sid = req.cookies[SESSION_COOKIE];
  if (!sid) return null;
  const rows = await db
    .select({ userId: sessions.userId, login: users.login, token: users.encryptedOauthToken })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sid), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const orgRows = await db.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, row.userId));
  return {
    userId: row.userId,
    login: row.login,
    orgIds: orgRows.map((r) => r.orgId),
    userToken: () => {
      if (!row.token) throw new Error("no OAuth token on file — sign in again");
      return decryptSecret(row.token, cfg.CONSOLE_MASTER_KEY);
    },
  };
}

/**
 * Guard for authenticated routes. State-changing methods additionally require
 * the CSRF header — a cross-origin page cannot attach a custom header without
 * a CORS preflight, and this API serves no CORS (plan 02 §1a).
 */
export async function requireAuth(deps: AppDeps, req: FastifyRequest, reply: FastifyReply): Promise<RequestCtx | null> {
  const ctx = await resolveSession(deps.dbh.db, deps.cfg, req);
  if (!ctx) {
    void reply.code(401).send({ error: "not signed in" });
    return null;
  }
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers[CSRF_HEADER] !== "1") {
    void reply.code(403).send({ error: "missing CSRF header" });
    return null;
  }
  if (ctx.orgIds.length === 0) {
    void reply.code(403).send({ error: "no org membership — install the GitHub App or ask an admin to invite you" });
    return null;
  }
  return ctx;
}

export function userClient(deps: AppDeps, ctx: RequestCtx): UserClient {
  return new UserClient(deps.cfg.GITHUB_API_URL, ctx.userToken());
}
