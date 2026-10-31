import { auditLog, gateAssignments, memberships, projects, repos, users } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, userClient, type AppDeps } from "../context.js";
import { loadOrg } from "./settings.js";

/**
 * Projects: console-native grouping of repos that ship together, so every
 * view can be focused to one project. Membership is a nullable pointer on the
 * repo (a repo belongs to at most one project); deleting a project releases
 * its repos rather than touching them.
 */
export function registerProjectRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  /** All projects across the caller's orgs, with their repos, plus unassigned repos. */
  app.get("/api/projects", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const projectRows = ctx.orgIds.length
      ? await db.select().from(projects).where(inArray(projects.orgId, ctx.orgIds)).orderBy(projects.name)
      : [];
    const repoRows = ctx.orgIds.length ? await db.select().from(repos).where(inArray(repos.orgId, ctx.orgIds)) : [];
    return {
      projects: projectRows.map((p) => ({
        id: p.id,
        orgId: p.orgId,
        name: p.name,
        repos: repoRows.filter((r) => r.projectId === p.id).map((r) => ({ id: r.id, fullName: r.fullName })),
      })),
      unassigned: repoRows.filter((r) => !r.projectId).map((r) => ({ id: r.id, orgId: r.orgId, fullName: r.fullName })),
    };
  });

  /** Who may release this project to staging and to production. */
  app.get<{ Params: { id: string } }>("/api/projects/:id/permissions", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const project = (
      await db.select().from(projects).where(and(eq(projects.id, req.params.id), inArray(projects.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!project) return reply.code(404).send({ error: "project not found" });
    const repoRows = await db.select().from(repos).where(eq(repos.projectId, project.id));
    const rows = repoRows.length
      ? await db
          .select()
          .from(gateAssignments)
          .where(inArray(gateAssignments.repoId, repoRows.map((r) => r.id)))
      : [];
    const perRepo = (gate: string) =>
      repoRows.map((r) => rows.filter((a) => a.repoId === r.id && a.gate === gate).map((a) => a.login).sort());
    const agreed = (lists: string[][]) => new Set(lists.map((l) => l.join(","))).size <= 1;
    const members = await db
      .select({ login: users.login })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, project.orgId));
    const release = perRepo("release");
    const staging = perRepo("staging");
    return {
      repos: repoRows.map((r) => r.fullName),
      production: [...new Set(release.flat())].sort(),
      staging: [...new Set(staging.flat())].sort(),
      // Repos that disagree are shown as the union; saving makes them agree.
      mixed: !agreed(release) || !agreed(staging),
      members: members.map((m) => m.login).sort(),
    };
  });

  /**
   * Set who may release this project. The approver file in each repo stays
   * the authority (the factory reads it), so saving commits it to each repo's
   * default branch as the admin. An empty production list is refused: the
   * factory reads an empty list as "any collaborator". An empty staging list
   * means "the same people as production".
   */
  app.post<{ Params: { id: string }; Body: { production?: string[]; staging?: string[] } }>(
    "/api/projects/:id/permissions",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const project = (
        await db.select().from(projects).where(and(eq(projects.id, req.params.id), inArray(projects.orgId, ctx.orgIds))).limit(1)
      )[0];
      if (!project) return reply.code(404).send({ error: "project not found" });
      const found = await loadOrg(deps, ctx, project.orgId, reply, { admin: true });
      if (!found) return;
      const clean = (v: unknown) =>
        Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))].sort() : null;
      const production = clean(req.body?.production);
      const staging = clean(req.body?.staging);
      if (!production || !staging) return reply.code(400).send({ error: "production and staging lists are required" });
      if (production.length === 0) return reply.code(400).send({ error: "name at least one person for production" });
      const bad = [...production, ...staging].find((l) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(l));
      if (bad) return reply.code(400).send({ error: `"${bad}" is not a GitHub login` });

      const gh = userClient(deps, ctx);
      const results: Array<{ repo: string; ok: boolean; error?: string }> = [];
      for (const repo of await db.select().from(repos).where(eq(repos.projectId, project.id))) {
        const [owner, name] = repo.fullName.split("/") as [string, string];
        const path = ".github/factory-approvers.json";
        try {
          const current = await gh.getFileAtRef(owner, name, path, repo.defaultBranch);
          const file = current ? (JSON.parse(current.content) as Record<string, unknown>) : {};
          const content = `${JSON.stringify({ ...file, release: production, staging }, null, 2)}\n`;
          if (current?.content !== content) {
            await gh.putFile(owner, name, path, {
              message: `factory: set who may release (@${ctx.login} via Compass)`,
              content,
              branch: repo.defaultBranch,
              ...(current ? { sha: current.sha } : {}),
            });
          }
          // Mirror now: the push webhook re-imports it, but a merge may not wait.
          await db
            .delete(gateAssignments)
            .where(and(eq(gateAssignments.repoId, repo.id), inArray(gateAssignments.gate, ["release", "staging"])));
          const rows = [
            ...production.map((login) => ({ estateId: repo.estateId, repoId: repo.id, gate: "release", login })),
            ...staging.map((login) => ({ estateId: repo.estateId, repoId: repo.id, gate: "staging", login })),
          ];
          if (rows.length > 0) await db.insert(gateAssignments).values(rows).onConflictDoNothing();
          results.push({ repo: repo.fullName, ok: true });
        } catch (err) {
          results.push({ repo: repo.fullName, ok: false, error: (err as Error).message });
        }
      }
      await db.insert(auditLog).values({
        orgId: project.orgId,
        actorUserId: ctx.userId,
        action: "project.permissions",
        target: project.name,
        payload: { production, staging, results },
      });
      return { ok: results.every((r) => r.ok), results };
    },
  );

  app.post<{ Body: { orgId: string; name: string } }>("/api/projects", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const name = req.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: "name required" });
    const found = await loadOrg(deps, ctx, req.body?.orgId ?? "", reply, { admin: true });
    if (!found) return;
    const existing = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, found.org.id), eq(projects.name, name)))
      .limit(1);
    if (existing[0]) return reply.code(409).send({ error: "a project with that name already exists" });
    const row = (await db.insert(projects).values({ orgId: found.org.id, name }).returning())[0]!;
    await db.insert(auditLog).values({
      orgId: found.org.id,
      actorUserId: ctx.userId,
      action: "project.create",
      target: name,
      payload: { projectId: row.id },
    });
    return { id: row.id, orgId: row.orgId, name: row.name, repos: [] };
  });

  app.post<{ Params: { id: string }; Body: { name: string } }>("/api/projects/:id", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const project = await loadProject(deps, ctx, req.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const found = await loadOrg(deps, ctx, project.orgId, reply, { admin: true });
    if (!found) return;
    const name = req.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: "name required" });
    await db.update(projects).set({ name }).where(eq(projects.id, project.id));
    return { ok: true, id: project.id, name };
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const project = await loadProject(deps, ctx, req.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const found = await loadOrg(deps, ctx, project.orgId, reply, { admin: true });
    if (!found) return;
    // The FK releases the repos (project_id -> null); nothing else refers to a project.
    await db.delete(projects).where(eq(projects.id, project.id));
    await db.insert(auditLog).values({
      orgId: project.orgId,
      actorUserId: ctx.userId,
      action: "project.delete",
      target: project.name,
      payload: { projectId: project.id },
    });
    return { ok: true };
  });

  /** Assign a repo to a project (or clear with projectId: null). */
  app.post<{ Params: { id: string }; Body: { projectId: string | null } }>("/api/repos/:id/project", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repo = (
      await db.select().from(repos).where(and(eq(repos.id, req.params.id), inArray(repos.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!repo) return reply.code(404).send({ error: "repo not found" });
    const found = await loadOrg(deps, ctx, repo.orgId, reply, { admin: true });
    if (!found) return;
    const projectId = req.body?.projectId ?? null;
    if (projectId) {
      const project = await loadProject(deps, ctx, projectId);
      if (!project || project.orgId !== repo.orgId) return reply.code(400).send({ error: "project not found in this org" });
    }
    await db.update(repos).set({ projectId }).where(eq(repos.id, repo.id));
    return { ok: true, repoId: repo.id, projectId };
  });
}

async function loadProject(deps: AppDeps, ctx: { orgIds: string[] }, projectId: string) {
  const { db } = deps.dbh;
  return (
    await db.select().from(projects).where(and(eq(projects.id, projectId), inArray(projects.orgId, ctx.orgIds))).limit(1)
  )[0];
}
