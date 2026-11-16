import { decryptSecret, encryptSecret } from "@console/core";
import { mcpServers } from "@console/db";
import { and, eq, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./context.js";
import { OAuthFailure, refreshGrant, type OAuthGrant } from "./mcp-oauth.js";

type Row = typeof mcpServers.$inferSelect;

/** Renew this long before the token runs out. */
export const RENEW_AHEAD_MS = 15 * 60_000;
/** How often the background renewal looks. */
const SWEEP_MS = 5 * 60_000;

export const SIGN_IN_AGAIN = "The sign-in has expired or was revoked. Sign in again.";

export function sealGrant(grant: OAuthGrant, key: string): { encryptedOauth: string; encryptedHeaders: string; headerNames: string[]; oauthExpiresAt: Date | null } {
  return {
    encryptedOauth: encryptSecret(JSON.stringify(grant), key),
    // The orchestrator reads only headers: the access token goes there.
    encryptedHeaders: encryptSecret(JSON.stringify({ Authorization: `Bearer ${grant.accessToken}` }), key),
    headerNames: ["Authorization"],
    oauthExpiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt),
  };
}

export function openGrant(row: Row, key: string): OAuthGrant | null {
  if (!row.encryptedOauth) return null;
  try {
    return JSON.parse(decryptSecret(row.encryptedOauth, key)) as OAuthGrant;
  } catch {
    return null;
  }
}

/** True when a signed-in server's token is past its expiry (or it never got one). */
export function expired(row: Row, now = Date.now()): boolean {
  if (row.authKind !== "oauth") return false;
  if (!row.encryptedHeaders) return true;
  return row.oauthExpiresAt !== null && row.oauthExpiresAt.getTime() <= now;
}

/** One renewal per server at a time: a rotated refresh token is good once. */
const inFlight = new Map<string, Promise<Row>>();

/**
 * The row with a token good for at least RENEW_AHEAD_MS, renewing it when it
 * is not. A refusal records SIGN_IN_AGAIN on the row and returns it as it
 * was; callers check `expired()` before handing the token out.
 */
export function ensureFresh(deps: AppDeps, row: Row, opts: { force?: boolean; now?: number } = {}): Promise<Row> {
  if (row.authKind !== "oauth") return Promise.resolve(row);
  const now = opts.now ?? Date.now();
  const due = opts.force || !row.encryptedHeaders || (row.oauthExpiresAt !== null && row.oauthExpiresAt.getTime() - now < RENEW_AHEAD_MS);
  if (!due) return Promise.resolve(row);
  const running = inFlight.get(row.id);
  if (running) return running;
  const work = renew(deps, row).finally(() => inFlight.delete(row.id));
  inFlight.set(row.id, work);
  return work;
}

async function renew(deps: AppDeps, row: Row): Promise<Row> {
  const key = deps.cfg.CONSOLE_MASTER_KEY;
  if (!key) return row;
  // Another request may have renewed it since this row was read.
  const latest = (await deps.dbh.db.select().from(mcpServers).where(eq(mcpServers.id, row.id)).limit(1))[0] ?? row;
  if (latest.oauthExpiresAt && latest.oauthExpiresAt.getTime() - Date.now() >= RENEW_AHEAD_MS && latest.encryptedHeaders) return latest;
  const grant = openGrant(latest, key);
  if (!grant) return mark(deps, latest, SIGN_IN_AGAIN);
  try {
    const next = await refreshGrant(grant, { allowLocal: deps.cfg.NODE_ENV !== "production" });
    const [saved] = await deps.dbh.db
      .update(mcpServers)
      .set({ ...sealGrant(next, key), checkError: null })
      .where(eq(mcpServers.id, latest.id))
      .returning();
    return saved ?? latest;
  } catch (err) {
    // A network blip is not a revoked sign-in: keep the token while it lasts.
    if (!(err instanceof OAuthFailure)) return latest;
    return mark(deps, latest, `${SIGN_IN_AGAIN} (${err.message})`);
  }
}

async function mark(deps: AppDeps, row: Row, error: string): Promise<Row> {
  const [saved] = await deps.dbh.db.update(mcpServers).set({ checkError: error, checkedAt: new Date() }).where(eq(mcpServers.id, row.id)).returning();
  return saved ?? row;
}

/** Renew every signed-in server whose token runs out soon. */
export async function renewDue(deps: AppDeps, now = Date.now()): Promise<number> {
  const rows = await deps.dbh.db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.authKind, "oauth"), eq(mcpServers.enabled, true), lt(mcpServers.oauthExpiresAt, new Date(now + RENEW_AHEAD_MS))));
  for (const r of rows) await ensureFresh(deps, r, { now });
  return rows.length;
}

/**
 * Keeps tokens fresh for the orchestrator's direct database reads, which
 * cannot renew a token themselves; sessions sent from Compass renew on the way.
 */
export function startMcpOAuthRenewal(app: FastifyInstance, deps: AppDeps): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await renewDue(deps);
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, "MCP sign-in renewal failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), SWEEP_MS);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
