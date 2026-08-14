import { githubAppConfigureUrl, githubAppInstallUrl } from "@console/core";
import { estates, memberships, orgs, repos, users } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, resolveSession, userClient, type AppDeps, type RequestCtx } from "../context.js";

/** Connect (or extend) an estate from a GitHub App installation the user can see. */
export async function connectInstallation(
  deps: AppDeps,
  ctx: RequestCtx,
  opts: { installationId: number; repoNodeIds?: string[]; name?: string; coordinationRepoNodeId?: string; allowEmpty?: boolean },
): Promise<{ ok: true; estateId: string; repoCount: number } | { ok: false; status: number; error: string }> {
  const { db } = deps.dbh;
  const gh = userClient(deps, ctx);
  const mine = await gh.listMyInstallations();
  const inst = mine.find((i) => i.id === opts.installationId);
  if (!inst) return { ok: false, status: 403, error: "you are not a member of that installation's account" };

  const available = await gh.listInstallationRepos(opts.installationId);
  const wanted = opts.repoNodeIds?.length ? available.filter((r) => opts.repoNodeIds!.includes(r.node_id)) : available;
  if (wanted.length === 0 && !opts.allowEmpty) {
    if (opts.repoNodeIds?.length) {
      return {
        ok: false,
        status: 400,
        error:
          "none of the selected repositories are in this GitHub App installation — add them on GitHub (Reinstall / change repositories), then Refresh",
      };
    }
    return { ok: false, status: 400, error: "no repositories selected" };
  }

  let estate = (await db.select().from(estates).where(eq(estates.installationId, opts.installationId)).limit(1))[0];
  if (!estate) {
    const orgName = opts.name?.trim() || inst.account.login;
    const org = (await db.insert(orgs).values({ name: orgName }).returning())[0]!;
    estate = (await db.insert(estates).values({ orgId: org.id, name: orgName, installationId: opts.installationId }).returning())[0]!;
  }

  const existingMembers = await db.select().from(memberships).where(eq(memberships.orgId, estate.orgId)).limit(1);
  await db
    .insert(memberships)
    .values({ orgId: estate.orgId, userId: ctx.userId, role: existingMembers.length === 0 ? "owner" : "member" })
    .onConflictDoNothing();

  for (const r of wanted) {
    await db
      .insert(repos)
      .values({
        orgId: estate.orgId,
        estateId: estate.id,
        ghNodeId: r.node_id,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
      })
      .onConflictDoUpdate({
        target: repos.ghNodeId,
        set: { estateId: estate.id, orgId: estate.orgId, fullName: r.full_name, defaultBranch: r.default_branch },
      });
  }

  if (opts.coordinationRepoNodeId) {
    const coord = (await db.select().from(repos).where(eq(repos.ghNodeId, opts.coordinationRepoNodeId)).limit(1))[0];
    if (coord) await db.update(estates).set({ coordinationRepoId: coord.id }).where(eq(estates.id, estate.id));
  }

  await deps.reconcileQueue.add("initial-sync", { estateIds: [estate.id] }, { removeOnComplete: 100 });
  return { ok: true, estateId: estate.id, repoCount: wanted.length };
}

/**
 * Connecting an estate, in the app rather than in a config file.
 *
 * The installation list is read with the *user's* token, so you can only wire
 * up an org you are actually a member of — the same visibility floor that
 * governs everything else. Creating the estate here means onboarding does not
 * depend on an installation webhook arriving, which matters for local runs
 * behind no public URL.
 */
export function registerEstateRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  /**
   * Accounts and repositories the signed-in GitHub user can see — including
   * ones the App is not installed on yet. Installed accounts carry an
   * installationId so Connect can sync immediately; the rest are offered so
   * a first-time sign-in can tick repos and go to GitHub's install screen.
   */
  app.get("/api/installations", async (req, reply) => {
    const ctx = await resolveSession(db, deps.cfg, req);
    if (!ctx) return reply.code(401).send({ error: "not signed in" });
    if (!(await deps.credentials.isConfigured())) {
      return reply.code(409).send({ error: "no GitHub App registered yet", needsSetup: true });
    }

    const gh = userClient(deps, ctx);
    const slug = await deps.credentials.resolveSlug();
    const web = deps.cfg.GITHUB_WEB_URL.replace(/\/$/, "");

    type RepoRow = {
      id: number | null;
      nodeId: string;
      fullName: string;
      defaultBranch: string;
      private: boolean;
      connected: boolean;
      /** True when this repo is in the GitHub App installation (Connect can sync it). */
      inInstallation: boolean;
    };
    type AccountRow = {
      installationId: number | null;
      accountId: number | null;
      account: string;
      accountType: string;
      avatarUrl: string | null;
      estateId: string | null;
      estateName: string | null;
      installUrl: string | null;
      configureUrl: string | null;
      repos: RepoRow[];
    };

    const byAccount = new Map<string, AccountRow>();
    const putAccount = (row: AccountRow) => {
      const key = row.account.toLowerCase();
      const existing = byAccount.get(key);
      if (!existing) {
        byAccount.set(key, row);
        return existing;
      }
      if (!existing.installationId && row.installationId) {
        existing.installationId = row.installationId;
        if (row.configureUrl) existing.configureUrl = row.configureUrl;
      }
      if (!existing.accountId && row.accountId) existing.accountId = row.accountId;
      if (!existing.avatarUrl && row.avatarUrl) existing.avatarUrl = row.avatarUrl;
      if (!existing.estateId && row.estateId) {
        existing.estateId = row.estateId;
        existing.estateName = row.estateName;
      }
      if (row.accountType && existing.accountType === "User") existing.accountType = row.accountType;
      return existing;
    };
    const mergeRepos = (account: string, incoming: RepoRow[]) => {
      const row = byAccount.get(account.toLowerCase());
      if (!row) return;
      const seen = new Map(row.repos.map((r) => [r.nodeId || r.fullName, r]));
      for (const r of incoming) {
        const k = r.nodeId || r.fullName;
        const have = seen.get(k);
        if (!have) {
          row.repos.push(r);
          seen.set(k, r);
        } else {
          if (!have.id && r.id) have.id = r.id;
          if (r.connected) have.connected = true;
          if (r.inInstallation) have.inInstallation = true;
        }
      }
    };
    const installUrlFor = (accountId: number | null) => {
      if (!slug) return null;
      return githubAppInstallUrl({ webUrl: web, slug, accountId });
    };
    const configureUrlFor = (installationId: number | null) => {
      if (!slug || installationId == null) return null;
      return githubAppConfigureUrl({ webUrl: web, slug, installationId });
    };

    const installations = await gh.listMyInstallations();
    for (const inst of installations) {
      const connected = (await db.select().from(estates).where(eq(estates.installationId, inst.id)).limit(1))[0];
      let repoList: RepoRow[] = [];
      try {
        const ghRepos = await gh.listInstallationRepos(inst.id);
        const known = connected
          ? new Set((await db.select().from(repos).where(eq(repos.estateId, connected.id))).map((r) => r.ghNodeId))
          : new Set<string>();
        repoList = ghRepos.map((r) => ({
          id: r.id ?? null,
          nodeId: r.node_id,
          fullName: r.full_name,
          defaultBranch: r.default_branch,
          private: r.private,
          connected: known.has(r.node_id),
          inInstallation: true,
        }));
      } catch {
        // The user may lack visibility on some installations; show it as empty
        // rather than failing the whole list.
      }
      const accountId = inst.account.id ?? null;
      putAccount({
        installationId: inst.id,
        accountId,
        account: inst.account.login,
        accountType: inst.account.type ?? "Organization",
        avatarUrl: inst.account.avatar_url ?? null,
        estateId: connected?.id ?? null,
        estateName: connected?.name ?? null,
        installUrl: installUrlFor(accountId),
        configureUrl: configureUrlFor(inst.id),
        repos: repoList,
      });
    }

    // First-time sign-in: the App is not installed anywhere yet, so the
    // installation list is empty. Public + token-visible repos still belong
    // to this user — list them so they can pick where to install.
    try {
      const accessible = await gh.listAccessibleAccounts(ctx.login);
      for (const { account, repos: ghRepos } of accessible) {
        putAccount({
          installationId: null,
          accountId: account.id || null,
          account: account.login,
          accountType: account.type ?? (account.login.toLowerCase() === ctx.login.toLowerCase() ? "User" : "Organization"),
          avatarUrl: account.avatar_url ?? null,
          estateId: null,
          estateName: null,
          installUrl: installUrlFor(account.id || null),
          configureUrl: null,
          repos: [],
        });
        mergeRepos(
          account.login,
          ghRepos.map((r) => ({
            id: r.id ?? null,
            nodeId: r.node_id,
            fullName: r.full_name,
            defaultBranch: r.default_branch || "main",
            private: r.private,
            connected: false,
            inInstallation: false,
          })),
        );
      }
    } catch {
      // Listing extras is best-effort: a token that can see installations but
      // not /user/repos must not blank the whole page.
    }

    if (byAccount.size === 0) {
      const user = (await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1))[0];
      if (user) {
        putAccount({
          installationId: null,
          accountId: user.ghUserId,
          account: user.login,
          accountType: "User",
          avatarUrl: user.avatarUrl,
          estateId: null,
          estateName: null,
          installUrl: installUrlFor(user.ghUserId),
          configureUrl: null,
          repos: [],
        });
      }
    }

    for (const row of byAccount.values()) {
      row.repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
      if (!row.installUrl) row.installUrl = installUrlFor(row.accountId);
      if (!row.configureUrl) row.configureUrl = configureUrlFor(row.installationId);
    }

    return { installations: [...byAccount.values()] };
  });

  /**
   * Create (or extend) an estate from a chosen installation and repo selection.
   * Idempotent: re-posting with more repos adds them; existing rows are kept.
   */
  app.post<{
    Body: { installationId: number; name?: string; repoNodeIds?: string[]; coordinationRepoNodeId?: string };
  }>("/api/estates", async (req, reply) => {
    const ctx = await resolveSession(db, deps.cfg, req);
    if (!ctx) return reply.code(401).send({ error: "not signed in" });
    if (req.headers["x-console-csrf"] !== "1") return reply.code(403).send({ error: "missing CSRF header" });

    const installationId = Number(req.body?.installationId);
    if (!installationId) return reply.code(400).send({ error: "installationId required" });

    const result = await connectInstallation(deps, ctx, {
      installationId,
      repoNodeIds: req.body?.repoNodeIds,
      name: req.body?.name,
      coordinationRepoNodeId: req.body?.coordinationRepoNodeId,
    });
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { ok: true, estateId: result.estateId, repoCount: result.repoCount, syncQueued: true };
  });

  /** Remove a repo from an estate (its projections cascade away). */
  app.post<{ Params: { id: string }; Body: { repoId: string } }>("/api/estates/:id/remove-repo", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const estate = (
      await db.select().from(estates).where(and(eq(estates.id, req.params.id), inArray(estates.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!estate) return reply.code(404).send({ error: "organisation not found" });
    await db.delete(repos).where(and(eq(repos.id, req.body.repoId), eq(repos.estateId, estate.id)));
    return { ok: true };
  });
}
