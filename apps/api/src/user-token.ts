import { decryptSecret, encryptSecret, OAuthRefreshError, type OAuthGrant, type TokenProvider } from "@console/core";
import { users, type Db } from "@console/db";
import { eq } from "drizzle-orm";
import type { AppDeps } from "./context.js";

/**
 * The acting user's OAuth grant, renewed in the background.
 *
 * A GitHub App with "Expire user authorization tokens" enabled — the default —
 * hands out access tokens that die after 8 hours. The Console used to store
 * only that token, so every working day ended with "GitHub rejected your
 * sign-in (Bad credentials) — sign out and back in" on the first write of the
 * afternoon. Here the refresh token does its job: the grant is renewed a few
 * minutes before it lapses (and again, forcibly, if GitHub still answers 401),
 * and a human is asked to sign in again only when the refresh token itself is
 * gone or GitHub has revoked the authorization.
 */

/** The renewal cannot proceed without a human: send them back through OAuth. */
export class SignInRequiredError extends Error {
  readonly reauth = true;
  constructor(reason: string) {
    super(`GitHub sign-in has expired (${reason}) — sign in again`);
    this.name = "SignInRequiredError";
  }
}

/** Renew this many milliseconds before GitHub's stated expiry. */
const REFRESH_SKEW_MS = 5 * 60_000;

/** The stored halves of one grant, as they come off the users row. */
export interface StoredGrant {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

interface CachedGrant {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshTokenExpiresAt: number | null;
}

/**
 * Per-process cache and refresh coordinator, one entry per user.
 *
 * GitHub rotates the refresh token on every use, so two refreshes racing on the
 * same grant leave one of them holding a token GitHub has already retired. The
 * cache keeps the freshest grant in front of the (now stale) row every request
 * re-reads, and `inFlight` collapses concurrent renewals — the Console fires
 * several API calls per page — into a single exchange. Single-process, like the
 * OAuth state map next door in auth.ts.
 */
export class UserTokenStore {
  private readonly cache = new Map<string, CachedGrant>();
  private readonly inFlight = new Map<string, Promise<CachedGrant>>();

  constructor(private readonly deps: () => AppDeps) {}

  /** Drop a user's cached grant — what a fresh sign-in makes of the old one. */
  forget(userId: string): void {
    this.cache.delete(userId);
    this.inFlight.delete(userId);
  }

  /** Seed the cache from a sign-in, so the first request skips a needless refresh. */
  remember(userId: string, grant: OAuthGrant): void {
    this.inFlight.delete(userId);
    this.cache.set(userId, {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt,
      refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
    });
  }

  /**
   * A token provider bound to one user, for `UserClient`. The stored row is the
   * starting point; anything the cache holds for this user wins over it.
   */
  provider(userId: string, stored: StoredGrant): TokenProvider {
    return (opts) => this.token(userId, stored, opts?.forceFresh === true);
  }

  private async token(userId: string, stored: StoredGrant, forceFresh: boolean): Promise<string> {
    const grant = this.current(userId, stored);
    if (!forceFresh && grant && !isExpiring(grant.expiresAt)) return grant.accessToken;
    if (!grant) throw new SignInRequiredError("no token on file");
    // Nothing to renew with: an App that does not expire user tokens has no
    // refresh token, so reaching here — a 401 from GitHub, or an expiry we
    // somehow recorded — really does mean the authorization is gone.
    if (!grant.refreshToken) throw new SignInRequiredError("no refresh token on file");
    return (await this.refresh(userId, grant)).accessToken;
  }

  /**
   * The grant to work from: the row, unless the cache holds a strictly newer
   * one this process refreshed but the request's row read predates.
   *
   * The row stays authoritative in the two directions that matter. Cleared
   * means cleared — an operator (or `clearRow` below) wiping a compromised
   * authorization takes effect on the next request, not on the next restart.
   * And a grant with a later expiry than the cached one can only have come
   * from a newer sign-in or refresh, so it wins.
   */
  private current(userId: string, stored: StoredGrant): CachedGrant | null {
    const cached = this.cache.get(userId);
    if (!stored.accessToken) {
      this.cache.delete(userId);
      return null;
    }
    const rowExpiresAt = stored.expiresAt?.getTime() ?? null;
    if (cached && !supersedes(rowExpiresAt, cached.expiresAt)) return cached;

    const masterKey = this.deps().cfg.CONSOLE_MASTER_KEY;
    const fromRow: CachedGrant = {
      accessToken: decryptSecret(stored.accessToken, masterKey),
      refreshToken: stored.refreshToken ? decryptSecret(stored.refreshToken, masterKey) : null,
      expiresAt: rowExpiresAt,
      refreshTokenExpiresAt: stored.refreshTokenExpiresAt?.getTime() ?? null,
    };
    this.cache.set(userId, fromRow);
    return fromRow;
  }

  private refresh(userId: string, grant: CachedGrant): Promise<CachedGrant> {
    const running = this.inFlight.get(userId);
    if (running) return running;
    const attempt = this.exchange(userId, grant).finally(() => this.inFlight.delete(userId));
    this.inFlight.set(userId, attempt);
    return attempt;
  }

  private async exchange(userId: string, grant: CachedGrant): Promise<CachedGrant> {
    if (grant.refreshTokenExpiresAt !== null && grant.refreshTokenExpiresAt <= Date.now()) {
      throw new SignInRequiredError("the refresh token has expired");
    }
    const deps = this.deps();
    const auth = await deps.credentials.auth();
    if (!auth) throw new SignInRequiredError("the Console's GitHub App is not registered");

    let renewed: OAuthGrant;
    try {
      renewed = await auth.refreshOAuthToken(grant.refreshToken!, deps.cfg.GITHUB_WEB_URL);
    } catch (err) {
      if (err instanceof OAuthRefreshError && err.mustReauthorize) {
        // Another process may have rotated the grant out from under this one.
        // The row is the shared record, so give its refresh token one chance
        // before declaring the authorization dead.
        const fromRow = await this.rowGrant(deps.dbh.db, userId, deps.cfg.CONSOLE_MASTER_KEY);
        if (fromRow?.refreshToken && fromRow.refreshToken !== grant.refreshToken) {
          renewed = await auth.refreshOAuthToken(fromRow.refreshToken, deps.cfg.GITHUB_WEB_URL);
        } else {
          // Clear the dead grant so the next request fails fast on "no token"
          // rather than replaying a refresh GitHub has already refused.
          this.cache.delete(userId);
          await this.clearRow(deps.dbh.db, userId);
          throw new SignInRequiredError(err.code);
        }
      } else {
        throw err;
      }
    }

    const next: CachedGrant = {
      accessToken: renewed.accessToken,
      // GitHub omits the refresh token when the App does not expire tokens;
      // keep the one that still works rather than dropping the ability to renew.
      refreshToken: renewed.refreshToken ?? grant.refreshToken,
      expiresAt: renewed.expiresAt,
      refreshTokenExpiresAt: renewed.refreshTokenExpiresAt ?? grant.refreshTokenExpiresAt,
    };
    this.cache.set(userId, next);
    await this.persist(deps.dbh.db, userId, next, deps.cfg.CONSOLE_MASTER_KEY);
    return next;
  }

  private async rowGrant(db: Db, userId: string, masterKey: string): Promise<{ refreshToken: string | null } | null> {
    const row = (
      await db
        .select({ refreshToken: users.encryptedOauthRefreshToken })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    )[0];
    if (!row) return null;
    try {
      return { refreshToken: row.refreshToken ? decryptSecret(row.refreshToken, masterKey) : null };
    } catch {
      return null; // sealed under a different master key — treat as absent
    }
  }

  private async persist(db: Db, userId: string, grant: CachedGrant, masterKey: string): Promise<void> {
    await db
      .update(users)
      .set({
        encryptedOauthToken: encryptSecret(grant.accessToken, masterKey),
        encryptedOauthRefreshToken: grant.refreshToken ? encryptSecret(grant.refreshToken, masterKey) : null,
        oauthTokenExpiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt),
        oauthRefreshTokenExpiresAt:
          grant.refreshTokenExpiresAt === null ? null : new Date(grant.refreshTokenExpiresAt),
      })
      .where(eq(users.id, userId));
  }

  private async clearRow(db: Db, userId: string): Promise<void> {
    await db
      .update(users)
      .set({
        encryptedOauthToken: null,
        encryptedOauthRefreshToken: null,
        oauthTokenExpiresAt: null,
        oauthRefreshTokenExpiresAt: null,
      })
      .where(eq(users.id, userId));
  }
}

function isExpiring(expiresAt: number | null): boolean {
  return expiresAt !== null && expiresAt <= Date.now() + REFRESH_SKEW_MS;
}

/** Does the row's grant post-date the cached one? A later expiry means a later grant. */
function supersedes(rowExpiresAt: number | null, cachedExpiresAt: number | null): boolean {
  if (rowExpiresAt === null) return false; // no expiry recorded — nothing to compare
  return cachedExpiresAt === null || rowExpiresAt > cachedExpiresAt;
}

/** Encrypt a freshly minted grant for the users row. */
export function sealGrant(grant: OAuthGrant, masterKey: string) {
  return {
    encryptedOauthToken: encryptSecret(grant.accessToken, masterKey),
    encryptedOauthRefreshToken: grant.refreshToken ? encryptSecret(grant.refreshToken, masterKey) : null,
    oauthTokenExpiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt),
    oauthRefreshTokenExpiresAt: grant.refreshTokenExpiresAt === null ? null : new Date(grant.refreshTokenExpiresAt),
  };
}
