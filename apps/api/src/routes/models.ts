import { auditLog, modelSettings, projects } from "@console/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps } from "../context.js";
import { MAX_CHAIN, MODEL_CHOICES, PHASES, checkChains } from "../model-settings.js";
import { loadOrg } from "./settings.js";

/** Compass → Models: read and set the models each phase runs on, for the org and for each project. */
export function registerModelRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get<{ Params: { id: string } }>("/api/orgs/:id/models", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: false });
    if (!found) return;
    const [rows, projectRows] = await Promise.all([
      db.select().from(modelSettings).where(eq(modelSettings.orgId, found.org.id)),
      db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.orgId, found.org.id)).orderBy(projects.name),
    ]);
    const of = (scope: string) => rows.find((r) => r.scope === scope);
    const scopeView = (scope: string) => {
      const r = of(scope);
      return { chains: r?.chains ?? {}, updatedBy: r?.updatedBy ?? null, updatedAt: r?.updatedAt.toISOString() ?? null };
    };
    return {
      orgId: found.org.id,
      orgName: found.org.name,
      canEdit: found.membership.role === "owner" || found.membership.role === "admin",
      phases: PHASES,
      choices: MODEL_CHOICES,
      maxChain: MAX_CHAIN,
      org: scopeView("org"),
      projects: projectRows.map((p) => ({ id: p.id, name: p.name, ...scopeView(p.id) })),
    };
  });

  /** Replace one scope's chains: "org", or a project id. A phase left out is not set there. */
  app.put<{ Params: { id: string; scope: string }; Body: { chains?: unknown } }>("/api/orgs/:id/models/:scope", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
    if (!found) return;
    const scope = req.params.scope;
    if (scope !== "org") {
      const project = (await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, scope), eq(projects.orgId, found.org.id))).limit(1))[0];
      if (!project) return reply.code(404).send({ error: "That project is not in this organisation." });
    }
    const checked = checkChains(req.body?.chains ?? {});
    if ("error" in checked) return reply.code(400).send({ error: checked.error });
    const now = new Date();
    await db
      .insert(modelSettings)
      .values({ orgId: found.org.id, scope, chains: checked.chains, updatedBy: ctx.login, updatedAt: now })
      .onConflictDoUpdate({ target: [modelSettings.orgId, modelSettings.scope], set: { chains: checked.chains, updatedBy: ctx.login, updatedAt: now } });
    await db.insert(auditLog).values({ orgId: found.org.id, actorUserId: ctx.userId, action: "models.set", target: scope, payload: { chains: checked.chains } });
    return { chains: checked.chains, updatedBy: ctx.login, updatedAt: now.toISOString() };
  });
}
