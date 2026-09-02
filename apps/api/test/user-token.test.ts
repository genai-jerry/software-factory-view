import { randomBytes } from "node:crypto";
import { CredentialStore, decryptSecret, encryptSecret, loadConfig } from "@console/core";
import { users } from "@console/db";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../src/context.js";
import { SignInRequiredError, UserTokenStore } from "../src/user-token.js";

/**
 * Renewing the acting user's GitHub authorization (spec 01 §2.1).
 *
 * A GitHub App that expires user authorizations issues 8-hour tokens, so
 * without this the Console tells everyone to sign out and back in halfway
 * through the working day. What the store owes its callers: renew before the
 * token lapses, never run two exchanges against one rotating refresh token,
 * store what comes back, and ask for a human only when GitHub says the
 * authorization itself is gone.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const WEB_URL = "https://github.test";

let deps: AppDeps;
let store: UserTokenStore;
let userId: string;

async function seed(row: Partial<typeof users.$inferInsert>): Promise<void> {
  await deps.dbh.db.update(users).set(row).where(eq(users.id, userId));
}

/** The users row as the request path reads it. */
async function stored() {
  const r = (
    await deps.dbh.db
      .select({
        accessToken: users.encryptedOauthToken,
        refreshToken: users.encryptedOauthRefreshToken,
        expiresAt: users.oauthTokenExpiresAt,
        refreshTokenExpiresAt: users.oauthRefreshTokenExpiresAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  )[0]!;
  return r;
}

/** A provider bound to the row as it stands right now. */
async function provider() {
  return store.provider(userId, await stored());
}

beforeEach(async () => {
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
    GITHUB_WEB_URL: WEB_URL,
    NODE_ENV: "test",
  } as never);
  deps = {
    cfg,
    dbh: { db, sql: null as never, close: async () => undefined },
    credentials: new CredentialStore({
      masterKey: MASTER_KEY,
      apiUrl: cfg.GITHUB_API_URL,
      load: async () => null,
      env: { appId: "1", privateKeyPem: "x", webhookSecret: "s", clientId: "c", clientSecret: "cs" },
    }),
    ingestQueue: { add: async () => undefined } as never,
    reconcileQueue: { add: async () => undefined } as never,
    openspecQueue: { add: async () => undefined } as never,
  };
  store = new UserTokenStore(() => deps);
  userId = (await db.insert(users).values({ ghUserId: 1, login: "alice" }).returning())[0]!.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** GitHub's OAuth token endpoint, answering with a fresh rotated grant. */
function stubRefresh(next: () => unknown, onCall?: () => void) {
  const calls: Array<Record<string, string>> = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
    expect(String(url)).toBe(`${WEB_URL}/login/oauth/access_token`);
    calls.push(JSON.parse(String(init.body)));
    onCall?.();
    return new Response(JSON.stringify(next()), { status: 200 });
  });
  return calls;
}

const HOURS = 3_600_000;

describe("UserTokenStore", () => {
  it("hands back a token that is nowhere near expiry without calling GitHub", async () => {
    await seed({
      encryptedOauthToken: encryptSecret("ghu_live", MASTER_KEY),
      encryptedOauthRefreshToken: encryptSecret("ghr_1", MASTER_KEY),
      oauthTokenExpiresAt: new Date(Date.now() + 6 * HOURS),
    });
    const calls = stubRefresh(() => ({}));
    expect(await (await provider())()).toBe("ghu_live");
    expect(calls).toHaveLength(0);
  });

  it("renews shortly before expiry and stores the rotated grant", async () => {
    await seed({
      encryptedOauthToken: encryptSecret("ghu_old", MASTER_KEY),
      encryptedOauthRefreshToken: encryptSecret("ghr_1", MASTER_KEY),
      // Inside the refresh skew: still valid to GitHub, too close to trust.
      oauthTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    const calls = stubRefresh(() => ({
      access_token: "ghu_new",
      expires_in: 28_800,
      refresh_token: "ghr_2",
      refresh_token_expires_in: 15_811_200,
    }));

    expect(await (await provider())()).toBe("ghu_new");
    expect(calls[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "ghr_1" });

    const row = await stored();
    expect(decryptSecret(row.accessToken!, MASTER_KEY)).toBe("ghu_new");
    // The old refresh token is spent — persisting the rotation is what keeps
    // the next renewal (up to six months out) working.
    expect(decryptSecret(row.refreshToken!, MASTER_KEY)).toBe("ghr_2");
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 7 * HOURS);
  });

  it("collapses concurrent renewals into one exchange", async () => {
    await seed({
      encryptedOauthToken: encryptSecret("ghu_old", MASTER_KEY),
      encryptedOauthRefreshToken: encryptSecret("ghr_1", MASTER_KEY),
      oauthTokenExpiresAt: new Date(Date.now() - 1000),
    });
    let n = 0;
    const calls = stubRefresh(() => ({ access_token: `ghu_${++n}`, expires_in: 28_800, refresh_token: `ghr_${n + 1}` }));

    // A single page load fires several API calls; each resolves its own
    // provider off the same stale row.
    const get = await provider();
    const tokens = await Promise.all([get(), get(), get()]);

    // One exchange, one answer: a second would have spent a refresh token
    // GitHub had already rotated away.
    expect(calls).toHaveLength(1);
    expect(tokens).toEqual(["ghu_1", "ghu_1", "ghu_1"]);
  });

  it("renews on demand when GitHub rejects a token that had not looked stale", async () => {
    await seed({
      encryptedOauthToken: encryptSecret("ghu_old", MASTER_KEY),
      encryptedOauthRefreshToken: encryptSecret("ghr_1", MASTER_KEY),
      oauthTokenExpiresAt: new Date(Date.now() + 6 * HOURS),
    });
    stubRefresh(() => ({ access_token: "ghu_new", expires_in: 28_800, refresh_token: "ghr_2" }));

    const get = await provider();
    expect(await get()).toBe("ghu_old");
    // What RepoReader does after a 401 from GitHub.
    expect(await get({ forceFresh: true })).toBe("ghu_new");
  });

  it("asks for a fresh sign-in — and clears the grant — once GitHub disowns the refresh token", async () => {
    await seed({
      encryptedOauthToken: encryptSecret("ghu_old", MASTER_KEY),
      encryptedOauthRefreshToken: encryptSecret("ghr_dead", MASTER_KEY),
      oauthTokenExpiresAt: new Date(Date.now() - 1000),
    });
    stubRefresh(() => ({ error: "bad_refresh_token", error_description: "expired" }));

    await expect((await provider())()).rejects.toThrow(SignInRequiredError);

    // The dead grant is gone, so the next request fails fast instead of
    // replaying an exchange GitHub has already refused.
    const row = await stored();
    expect(row.accessToken).toBeNull();
    expect(row.refreshToken).toBeNull();
  });

  it("keeps the grant when the refresh merely failed to reach GitHub", async () => {
    await seed({
      encryptedOauthToken: encryptSecret("ghu_old", MASTER_KEY),
      encryptedOauthRefreshToken: encryptSecret("ghr_1", MASTER_KEY),
      oauthTokenExpiresAt: new Date(Date.now() - 1000),
    });
    vi.stubGlobal("fetch", async () => new Response("bad gateway", { status: 502 }));

    await expect((await provider())()).rejects.not.toBeInstanceOf(SignInRequiredError);
    // An outage must not log the user out.
    expect((await stored()).accessToken).not.toBeNull();
  });

  it("will not renew a refresh token that is itself past its six months", async () => {
    await seed({
      encryptedOauthToken: encryptSecret("ghu_old", MASTER_KEY),
      encryptedOauthRefreshToken: encryptSecret("ghr_1", MASTER_KEY),
      oauthTokenExpiresAt: new Date(Date.now() - 1000),
      oauthRefreshTokenExpiresAt: new Date(Date.now() - 1000),
    });
    const calls = stubRefresh(() => ({}));
    await expect((await provider())()).rejects.toThrow(SignInRequiredError);
    expect(calls).toHaveLength(0);
  });

  it("serves an App that does not expire user tokens without ever refreshing", async () => {
    await seed({ encryptedOauthToken: encryptSecret("gho_forever", MASTER_KEY) });
    const calls = stubRefresh(() => ({}));
    expect(await (await provider())()).toBe("gho_forever");
    expect(calls).toHaveLength(0);
  });

  it("stops serving a token the moment the row is cleared", async () => {
    await seed({
      encryptedOauthToken: encryptSecret("ghu_live", MASTER_KEY),
      oauthTokenExpiresAt: new Date(Date.now() + 6 * HOURS),
    });
    expect(await (await provider())()).toBe("ghu_live");

    // An operator revoking a compromised authorization must take effect on the
    // next request, not on the next restart.
    await seed({ encryptedOauthToken: null, oauthTokenExpiresAt: null });
    await expect((await provider())()).rejects.toThrow(SignInRequiredError);
  });

  it("prefers a newer grant written by a fresh sign-in elsewhere", async () => {
    await seed({
      encryptedOauthToken: encryptSecret("ghu_first", MASTER_KEY),
      oauthTokenExpiresAt: new Date(Date.now() + 2 * HOURS),
    });
    expect(await (await provider())()).toBe("ghu_first");

    await seed({
      encryptedOauthToken: encryptSecret("ghu_second", MASTER_KEY),
      oauthTokenExpiresAt: new Date(Date.now() + 8 * HOURS),
    });
    expect(await (await provider())()).toBe("ghu_second");
  });
});
