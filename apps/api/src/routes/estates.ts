import { estates, memberships, orgs, repos } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, resolveSession, userClient, type AppDeps } from "../context.js";

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

  /** App installations visible to the signed-in user, with their repos and connection status. */
  app.get("/api/installations", async (req, reply) => {
    const ctx = await resolveSession(db, deps.cfg, req);
    if (!ctx) return reply.code(401).send({ error: "not signed in" });
    if (!(await deps.credentials.isConfigured())) {
      return reply.code(409).send({ error: "no GitHub App registered yet", needsSetup: true });
    }

    const gh = userClient(deps, ctx);
    const installations = await gh.listMyInstallations();
    const out = [];
    for (const inst of installations) {
      const connected = (await db.select().from(estates).where(eq(estates.installationId, inst.id)).limit(1))[0];
      let repoList: Array<{ nodeId: string; fullName: string; defaultBranch: string; private: boolean; connected: boolean }> = [];
      try {
        const ghRepos = await gh.listInstallationRepos(inst.id);
        const known = connected
          ? new Set((await db.select().from(repos).where(eq(repos.estateId, connected.id))).map((r) => r.ghNodeId))
          : new Set<string>();
        repoList = ghRepos.map((r) => ({
          nodeId: r.node_id,
          fullName: r.full_name,
          defaultBranch: r.default_branch,
          private: r.private,
          connected: known.has(r.node_id),
        }));
      } catch {
        // The user may lack visibility on some installations; show it as empty
        // rather than failing the whole list.
      }
      out.push({
        installationId: inst.id,
        account: inst.account.login,
        accountType: inst.account.type ?? "Organization",
        avatarUrl: inst.account.avatar_url ?? null,
        estateId: connected?.id ?? null,
        estateName: connected?.name ?? null,
        repos: repoList,
      });
    }
    return { installations: out };
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

    // Authorisation: the user must be able to see this installation on GitHub.
    const gh = userClient(deps, ctx);
    const mine = await gh.listMyInstallations();
    const inst = mine.find((i) => i.id === installationId);
    if (!inst) return reply.code(403).send({ error: "you are not a member of that installation's account" });

    const available = await gh.listInstallationRepos(installationId);
    const wanted = req.body?.repoNodeIds?.length
      ? available.filter((r) => req.body.repoNodeIds!.includes(r.node_id))
      : available;
    if (wanted.length === 0) return reply.code(400).send({ error: "no repositories selected" });

    // Estate + org: reuse if this installation is already connected, else create.
    let estate = (await db.select().from(estates).where(eq(estates.installationId, installationId)).limit(1))[0];
    if (!estate) {
      const orgName = req.body?.name?.trim() || inst.account.login;
      const org = (await db.insert(orgs).values({ name: orgName }).returning())[0]!;
      estate = (
        await db.insert(estates).values({ orgId: org.id, name: orgName, installationId }).returning()
      )[0]!;
    }

    // The acting user becomes a member (owner if the org has none yet).
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

    if (req.body?.coordinationRepoNodeId) {
      const coord = (await db.select().from(repos).where(eq(repos.ghNodeId, req.body.coordinationRepoNodeId)).limit(1))[0];
      if (coord) await db.update(estates).set({ coordinationRepoId: coord.id }).where(eq(estates.id, estate.id));
    }

    // Populate immediately — no waiting on a webhook.
    await deps.reconcileQueue.add("initial-sync", { estateIds: [estate.id] }, { removeOnComplete: 100 });

    return { ok: true, estateId: estate.id, repoCount: wanted.length, syncQueued: true };
  });

  /** Remove a repo from an estate (its projections cascade away). */
  app.post<{ Params: { id: string }; Body: { repoId: string } }>("/api/estates/:id/remove-repo", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const estate = (
      await db.select().from(estates).where(and(eq(estates.id, req.params.id), inArray(estates.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!estate) return reply.code(404).send({ error: "estate not found" });
    await db.delete(repos).where(and(eq(repos.id, req.body.repoId), eq(repos.estateId, estate.id)));
    return { ok: true };
  });
}
