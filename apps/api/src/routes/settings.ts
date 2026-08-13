import { encryptSecret, InstallationClient } from "@console/core";
import { auditLog, estates, memberships, onboardingRuns, orgs, repos } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, type AppDeps, type RequestCtx } from "../context.js";

/**
 * Org settings: each org names its own Ask-the-Factory model and Anthropic
 * API key (encrypted at rest, write-only — falling back to the instance-wide
 * ANTHROPIC_API_KEY / INSIGHT_DEEP_MODEL when unset), and can write an agent
 * token to every connected repo's GitHub Actions secrets in one pass. Secret
 * values are never stored by the Console except the insight key, which the
 * Console itself needs to call the API on the org's behalf.
 */

/** Actions secrets the Console will write — the factory pipeline's inputs. */
const ALLOWED_SECRETS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_CROSS_REPO_TOKEN"];

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get<{ Params: { id: string } }>("/api/orgs/:id/settings", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: false });
    if (!found) return;
    return {
      id: found.org.id,
      name: found.org.name,
      role: found.membership.role,
      insight: {
        model: found.org.insightModel,
        hasKey: Boolean(found.org.encryptedInsightApiKey),
        defaultModel: deps.cfg.INSIGHT_DEEP_MODEL,
        globalKeyConfigured: Boolean(deps.cfg.ANTHROPIC_API_KEY),
      },
      allowedSecrets: ALLOWED_SECRETS,
    };
  });

  /**
   * Set the org's insight model and/or API key. The key must be an Anthropic
   * *API* key (x-api-key auth) — Claude Code OAuth tokens are a Claude Code
   * credential and do not work against the Messages API, so they are rejected
   * with an explanation rather than stored to fail later.
   */
  app.post<{ Params: { id: string }; Body: { model?: string | null; apiKey?: string | null } }>(
    "/api/orgs/:id/settings/insight",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
      if (!found) return;

      const set: Partial<typeof orgs.$inferInsert> = {};
      if (req.body && "model" in req.body) {
        const model = req.body.model?.trim();
        set.insightModel = model ? model : null;
      }
      if (req.body && "apiKey" in req.body) {
        const apiKey = req.body.apiKey?.trim();
        if (!apiKey) {
          set.encryptedInsightApiKey = null;
        } else {
          if (apiKey.startsWith("sk-ant-oat")) {
            return reply.code(400).send({
              error:
                "that is a Claude Code OAuth token, not an API key — it authenticates Claude Code (the factory's agents), not direct API calls. Create an API key at platform.claude.com and use that here.",
            });
          }
          if (!deps.cfg.CONSOLE_MASTER_KEY) {
            return reply.code(503).send({ error: "CONSOLE_MASTER_KEY is not set — the Console cannot store secrets at rest" });
          }
          set.encryptedInsightApiKey = encryptSecret(apiKey, deps.cfg.CONSOLE_MASTER_KEY);
        }
      }
      if (Object.keys(set).length === 0) return reply.code(400).send({ error: "nothing to update — pass model and/or apiKey" });

      await db.update(orgs).set(set).where(eq(orgs.id, found.org.id));
      await db.insert(auditLog).values({
        orgId: found.org.id,
        actorUserId: ctx.userId,
        action: "settings.insight",
        target: found.org.name,
        payload: {
          model: "insightModel" in set ? set.insightModel : undefined,
          keyChanged: "encryptedInsightApiKey" in set ? (set.encryptedInsightApiKey ? "set" : "cleared") : undefined,
        },
      });
      const fresh = (await db.select().from(orgs).where(eq(orgs.id, found.org.id)).limit(1))[0]!;
      return { ok: true, model: fresh.insightModel, hasKey: Boolean(fresh.encryptedInsightApiKey) };
    },
  );

  /**
   * Write an agent token to every connected repo's GitHub Actions secrets in
   * one pass (the same write-through as the per-repo onboarding step — the
   * Console never stores the value). Per-repo results, never all-or-nothing.
   */
  app.post<{ Params: { id: string }; Body: { name: string; value: string } }>(
    "/api/orgs/:id/settings/secrets",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
      if (!found) return;
      const name = req.body?.name;
      const value = req.body?.value;
      if (!name || !value) return reply.code(400).send({ error: "name and value required" });
      if (!ALLOWED_SECRETS.includes(name)) {
        return reply.code(400).send({ error: `secret must be one of ${ALLOWED_SECRETS.join(", ")}` });
      }
      const auth = await deps.credentials.auth();
      if (!auth) return reply.code(409).send({ error: "no GitHub App registered — complete setup first" });

      const estateRows = await db.select().from(estates).where(eq(estates.orgId, found.org.id));
      const results: Array<{ repo: string; ok: boolean; error?: string }> = [];
      for (const estate of estateRows) {
        const client = new InstallationClient(deps.cfg.GITHUB_API_URL, auth, estate.installationId);
        const repoRows = await db.select().from(repos).where(eq(repos.estateId, estate.id));
        for (const repo of repoRows) {
          const [owner, repoName] = repo.fullName.split("/") as [string, string];
          try {
            await client.putActionsSecret(owner, repoName, name, value);
            results.push({ repo: repo.fullName, ok: true });
            await recordSecretStep(deps, repo, "ok", { name, writtenAt: new Date().toISOString(), via: "org-settings" });
          } catch (err) {
            results.push({ repo: repo.fullName, ok: false, error: (err as Error).message });
            await recordSecretStep(deps, repo, "failed", { name, error: (err as Error).message, via: "org-settings" });
          }
        }
      }
      await db.insert(auditLog).values({
        orgId: found.org.id,
        actorUserId: ctx.userId,
        action: "settings.secret",
        target: found.org.name,
        payload: { name, repos: results.map((r) => ({ repo: r.repo, ok: r.ok })) },
      });
      return { name, results };
    },
  );
}

async function loadOrg(
  deps: AppDeps,
  ctx: RequestCtx,
  orgId: string,
  reply: FastifyReply,
  opts: { admin: boolean },
): Promise<{ org: typeof orgs.$inferSelect; membership: typeof memberships.$inferSelect } | null> {
  const { db } = deps.dbh;
  const org = (await db.select().from(orgs).where(and(eq(orgs.id, orgId), inArray(orgs.id, ctx.orgIds))).limit(1))[0];
  if (!org) {
    void reply.code(404).send({ error: "org not found" });
    return null;
  }
  const membership = (
    await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, org.id), eq(memberships.userId, ctx.userId)))
      .limit(1)
  )[0];
  if (!membership) {
    void reply.code(404).send({ error: "org not found" });
    return null;
  }
  if (opts.admin && membership.role !== "owner" && membership.role !== "admin") {
    void reply.code(403).send({ error: "changing org settings requires an admin or owner role" });
    return null;
  }
  return { org, membership };
}

async function recordSecretStep(
  deps: AppDeps,
  repo: { id: string; orgId: string; estateId: string },
  status: "ok" | "failed",
  detail: Record<string, unknown>,
): Promise<void> {
  await deps.dbh.db
    .insert(onboardingRuns)
    .values({ orgId: repo.orgId, estateId: repo.estateId, repoId: repo.id, step: "secrets", status, detail, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [onboardingRuns.repoId, onboardingRuns.step],
      set: { status, detail, updatedAt: new Date() },
    });
}
