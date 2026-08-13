import { auditLog, projects, repos } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps } from "../context.js";
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
