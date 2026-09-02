import { CredentialStore, UserClient, type ConsoleConfig, type TokenProvider } from "@console/core";
import { memberships, sessions, users, type DbHandle } from "@console/db";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Queue } from "bullmq";
import { UserTokenStore } from "./user-token.js";

/** Per-process dependencies threaded through routes. */
export interface AppDeps {
  cfg: ConsoleConfig;
  dbh: DbHandle;
  /** Resolves the Console's GitHub App credentials (database first, env fallback). */
  credentials: CredentialStore;
  ingestQueue: Queue;
  reconcileQueue: Queue;
  openspecQueue: Queue;
}

/** Per-request authenticated context: the caller and their org scope. */
export interface RequestCtx {
  userId: string;
  login: string;
  orgIds: string[];
  /**
   * A live GitHub user token. Resolves lazily and renews the OAuth grant when
   * it is within minutes of expiring; rejects with `SignInRequiredError` only
   * when a human really does have to authorize again.
   */
  userToken: TokenProvider;
}

/**
 * One token store per app instance, created on first use. It is keyed off the
 * deps object rather than held in `AppDeps` so that its refresh cache — which
 * must be the single writer of a user's rotating grant — cannot be duplicated
 * by a caller assembling deps by hand.
 */
const tokenStores = new WeakMap<AppDeps, UserTokenStore>();

export function userTokens(deps: AppDeps): UserTokenStore {
  let store = tokenStores.get(deps);
  if (!store) {
    store = new UserTokenStore(() => deps);
    tokenStores.set(deps, store);
  }
  return store;
}

export const SESSION_COOKIE = "console_session";
export const CSRF_HEADER = "x-console-csrf";

export async function resolveSession(deps: AppDeps, req: FastifyRequest): Promise<RequestCtx | null> {
  const db = deps.dbh.db;
  const sid = req.cookies[SESSION_COOKIE];
  if (!sid) return null;
  const rows = await db
    .select({
      userId: sessions.userId,
      login: users.login,
      token: users.encryptedOauthToken,
      refreshToken: users.encryptedOauthRefreshToken,
      expiresAt: users.oauthTokenExpiresAt,
      refreshTokenExpiresAt: users.oauthRefreshTokenExpiresAt,
    })
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
    userToken: userTokens(deps).provider(row.userId, {
      accessToken: row.token,
      refreshToken: row.refreshToken,
      expiresAt: row.expiresAt,
      refreshTokenExpiresAt: row.refreshTokenExpiresAt,
    }),
  };
}

/**
 * Guard for authenticated routes. State-changing methods additionally require
 * the CSRF header — a cross-origin page cannot attach a custom header without
 * a CORS preflight, and this API serves no CORS (plan 02 §1a).
 */
export async function requireAuth(deps: AppDeps, req: FastifyRequest, reply: FastifyReply): Promise<RequestCtx | null> {
  const ctx = await resolveSession(deps, req);
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

/**
 * A GitHub client on the acting user's identity. Construction is free: the
 * token is fetched — and renewed if need be — when a call is actually made,
 * and a 401 from GitHub forces one more renewal before the call gives up.
 */
export function userClient(deps: AppDeps, ctx: RequestCtx): UserClient {
  return new UserClient(deps.cfg.GITHUB_API_URL, ctx.userToken);
}
