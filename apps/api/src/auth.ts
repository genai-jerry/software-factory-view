import { GitHubHttpError, randomToken, UserClient } from "@console/core";
import { estates, memberships, orgs, repos, sessions, users } from "@console/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE, userTokens, type AppDeps } from "./context.js";
import { sealGrant } from "./user-token.js";

const SESSION_TTL_DAYS = 14;
const oauthStates = new Map<string, { expiry: number; next?: string }>(); // state -> expiry; single-process MVP

function safeRelativeNext(raw: string | undefined): string | undefined {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return undefined;
  return raw;
}

/**
 * GitHub OAuth (authorization-code) handled entirely server-side. The browser
 * ends up with an opaque HttpOnly session cookie and nothing else.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { cfg, dbh } = deps;

  app.get<{ Querystring: { next?: string } }>("/auth/github/login", async (req, reply) => {
    const creds = await deps.credentials.resolve();
    if (!creds) {
      if (cfg.DEV_FAKE_LOGIN === "1") return reply.redirect("/auth/dev-login");
      return reply.redirect("/");
    }
    const state = randomToken(16);
    oauthStates.set(state, { expiry: Date.now() + 10 * 60_000, next: safeRelativeNext(req.query.next) });
    const redirectUri = `${cfg.PUBLIC_ORIGIN}/auth/github/callback`;
    const url =
      `${cfg.GITHUB_WEB_URL}/login/oauth/authorize?client_id=${encodeURIComponent(creds.clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    return reply.redirect(url);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>("/auth/github/callback", async (req, reply) => {
    const { code, state } = req.query;
    const stored = state ? oauthStates.get(state) : undefined;
    if (!code || !state || !stored || stored.expiry < Date.now()) {
      return reply.code(400).send({ error: "invalid OAuth state" });
    }
    oauthStates.delete(state);

    const auth = await deps.credentials.auth();
    if (!auth) return reply.code(409).send({ error: "no GitHub App registered — complete setup first" });
    // The whole grant, not just the access token: an App that expires user
    // authorizations issues an 8-hour token plus the refresh token that keeps
    // it alive, and dropping the latter is what forced a re-login twice a day.
    const grant = await auth.exchangeOAuthCode(code, cfg.GITHUB_WEB_URL);
    const gh = new UserClient(cfg.GITHUB_API_URL, grant.accessToken);
    const me = await gh.me();

    const existing = await dbh.db.select().from(users).where(eq(users.ghUserId, me.id)).limit(1);
    const sealed = sealGrant(grant, cfg.CONSOLE_MASTER_KEY);
    let userId: string;
    if (existing[0]) {
      userId = existing[0].id;
      await dbh.db
        .update(users)
        .set({ login: me.login, name: me.name, avatarUrl: me.avatar_url, ...sealed })
        .where(eq(users.id, userId));
    } else {
      userId = (
        await dbh.db
          .insert(users)
          .values({ ghUserId: me.id, login: me.login, name: me.name, avatarUrl: me.avatar_url, ...sealed })
          .returning()
      )[0]!.id;
    }
    // This authorization supersedes whatever the refresh cache still holds for
    // the user — including a grant it has just given up on.
    userTokens(deps).remember(userId, grant);

    await bootstrapMemberships(deps, userId, gh);
    await createSession(deps, userId, reply);
    return reply.redirect(stored.next ?? "/");
  });

  // Dev-only bypass so the UI can be exercised without a GitHub App (DEV_FAKE_LOGIN=1).
  app.get("/auth/dev-login", async (_req, reply) => {
    if (cfg.DEV_FAKE_LOGIN !== "1") return reply.code(404).send({ error: "not found" });
    let user = (await dbh.db.select().from(users).where(eq(users.ghUserId, 1)).limit(1))[0];
    if (!user) {
      user = (await dbh.db.insert(users).values({ ghUserId: 1, login: "dev-user", name: "Dev User" }).returning())[0]!;
    }
    let org = (await dbh.db.select().from(orgs).limit(1))[0];
    if (!org) org = (await dbh.db.insert(orgs).values({ name: "dev-org" }).returning())[0]!;
    await dbh.db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" }).onConflictDoNothing();
    await createSession(deps, user.id, reply);
    return reply.redirect("/");
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) {
      const row = (await dbh.db.select({ userId: sessions.userId }).from(sessions).where(eq(sessions.id, sid)).limit(1))[0];
      await dbh.db.delete(sessions).where(eq(sessions.id, sid));
      if (row) userTokens(deps).forget(row.userId);
    }
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}

async function createSession(deps: AppDeps, userId: string, reply: { setCookie: Function }): Promise<void> {
  const sid = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await deps.dbh.db.insert(sessions).values({ id: sid, userId, expiresAt });
  reply.setCookie(SESSION_COOKIE, sid, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    // Cookie Secure follows PUBLIC_ORIGIN. HTTP on a VPS IP would never send Secure cookies.
    secure: deps.cfg.PUBLIC_ORIGIN.startsWith("https:"),
    maxAge: SESSION_TTL_DAYS * 86_400,
  });
}

/**
 * Org membership bootstrap (MVP): a signing-in user joins each org their
 * GitHub identity is actually affiliated with — they can see the estate's
 * App installation (GitHub only lists installations to account members and
 * repo collaborators), or they hold write/maintain/admin permission on the
 * estate's probe repo. Mere *readability* is deliberately not enough: anyone
 * can read a public repo, and joining on read access seated every signed-in
 * user in every org, exposing each other's repositories across accounts.
 *
 * The first member of an org becomes its owner, and anyone who *administers*
 * the probe repo on GitHub joins as an admin rather than a plain member —
 * otherwise the person the repo actually belongs to can be locked out of
 * onboarding by whoever happened to sign in first. Memberships this bootstrap
 * previously handed out on readability alone are revoked here on sign-in once
 * GitHub affirms the user has no write access. The full invitation/role flow
 * is Phase 4 (F-U2..U4); F-U9's daily re-check tightens revocation later.
 */
export async function bootstrapMemberships(deps: AppDeps, userId: string, gh: UserClient): Promise<void> {
  const { db } = deps.dbh;
  const allEstates = await db.select().from(estates);
  if (allEstates.length === 0) return;

  // Installations the user's token can see. Best-effort: on failure fall back
  // to per-repo permission probes alone, and never revoke on a flaky call.
  let myInstallations: Set<number> | null = null;
  try {
    myInstallations = new Set((await gh.listMyInstallations()).map((i) => i.id));
  } catch {
    myInstallations = null;
  }

  for (const estate of allEstates) {
    const estateRepos = await db.select().from(repos).where(eq(repos.estateId, estate.id)).limit(1);
    const probe = estateRepos[0];
    if (!probe) continue;
    const [owner, name] = probe.fullName.split("/") as [string, string];

    // true = affiliated (may join), false = GitHub affirmed no write access
    // (a readability-era membership must go), null = unknown (change nothing).
    let affiliated: boolean | null = myInstallations?.has(estate.installationId) ? true : null;
    let isRepoAdmin = false;
    try {
      const view = await gh.getRepo(owner, name); // 404 for repos the user cannot see
      const p = view.permissions;
      isRepoAdmin = Boolean(p?.admin);
      if (p?.admin || p?.maintain || p?.push) affiliated = true;
      else if (p && affiliated === null) affiliated = false; // read-only: public visibility, not affiliation
    } catch (e) {
      if (e instanceof GitHubHttpError && (e.status === 404 || e.status === 403) && affiliated === null) {
        affiliated = false; // the user cannot even see the repo
      }
      // Anything else (rate limit, outage) leaves affiliation unknown.
    }

    const mine = (
      await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.orgId, estate.orgId), eq(memberships.userId, userId)))
        .limit(1)
    )[0];
    if (mine) {
      // Auto-assigned "member" rows are the only ones this bootstrap creates
      // for non-admins, so they are the only ones it revokes. Owner/admin are
      // earned; hand-assigned roles (viewer) are deliberate and stay as they are.
      if (mine.role === "member" && affiliated === false) {
        await db.delete(memberships).where(eq(memberships.id, mine.id));
        continue;
      }
      // Repair an earlier auto-assigned "member" row for a GitHub repo admin.
      if (mine.role === "member" && isRepoAdmin) {
        await db.update(memberships).set({ role: "admin" }).where(eq(memberships.id, mine.id));
      }
      continue;
    }

    if (affiliated !== true) continue;

    const existingMembers = await db.select().from(memberships).where(eq(memberships.orgId, estate.orgId)).limit(1);
    const role = existingMembers.length === 0 ? "owner" : isRepoAdmin ? "admin" : "member";
    await db.insert(memberships).values({ orgId: estate.orgId, userId, role }).onConflictDoNothing();
  }
}
