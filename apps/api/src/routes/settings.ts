import { decryptSecret, encryptSecret, InstallationClient } from "@console/core";
import { INSIGHT_PROVIDERS, isInsightProvider, listModels } from "@console/insight";
import { auditLog, estates, memberships, onboardingRuns, orchestratorSecrets, orgs, repos } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, type AppDeps, type RequestCtx } from "../context.js";

/**
 * Org settings: each org names its own Ask-the-Factory model and Anthropic
 * API key (encrypted at rest, write-only — falling back to the instance-wide
 * ANTHROPIC_API_KEY / INSIGHT_DEEP_MODEL when unset), and can write an agent
 * token to every connected repo's GitHub Actions secrets in one pass.
 *
 * Agent secrets are also RETAINED, sealed with CONSOLE_MASTER_KEY, in
 * orchestrator_secrets: GitHub Actions secrets cannot be read back, so the
 * write-through covers only the Actions engine — the LangGraph orchestrator
 * (FACTORY.md §2e) reads the retained copies from this database with the
 * shared master key. Values stay write-only through the Console API: only
 * name + updatedAt metadata is ever returned.
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
    const retained = await db
      .select({ name: orchestratorSecrets.name, updatedAt: orchestratorSecrets.updatedAt })
      .from(orchestratorSecrets)
      .where(eq(orchestratorSecrets.orgId, found.org.id));
    return {
      id: found.org.id,
      name: found.org.name,
      role: found.membership.role,
      retainedSecrets: retained,
      insight: {
        provider: found.org.insightProvider ?? "anthropic",
        model: found.org.insightModel,
        hasKey: Boolean(found.org.encryptedInsightApiKey),
        defaultModel: deps.cfg.INSIGHT_DEEP_MODEL,
        globalKeyConfigured: Boolean(deps.cfg.ANTHROPIC_API_KEY),
        providers: INSIGHT_PROVIDERS,
      },
      allowedSecrets: ALLOWED_SECRETS,
    };
  });

  /**
   * Set the org's insight provider, model and/or API key. The key must be a
   * direct API credential for the chosen provider — for Anthropic, a Claude
   * Code OAuth token is rejected with an explanation (it authenticates the
   * factory's agents, not the Messages API) rather than stored to fail later.
   * Non-Anthropic providers have no instance-wide default model, so a model
   * is required whenever the provider isn't anthropic.
   */
  app.post<{ Params: { id: string }; Body: { provider?: string; model?: string | null; apiKey?: string | null } }>(
    "/api/orgs/:id/settings/insight",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
      if (!found) return;

      const set: Partial<typeof orgs.$inferInsert> = {};
      if (req.body && "provider" in req.body) {
        const provider = req.body.provider?.trim();
        if (!provider || !isInsightProvider(provider)) {
          return reply.code(400).send({ error: `provider must be one of ${INSIGHT_PROVIDERS.join(", ")}` });
        }
        set.insightProvider = provider;
      }
      if (req.body && "model" in req.body) {
        const model = req.body.model?.trim();
        set.insightModel = model ? model : null;
      }
      const effectiveProvider =
        ("insightProvider" in set ? set.insightProvider : found.org.insightProvider) ?? "anthropic";
      const effectiveModel = "insightModel" in set ? set.insightModel : found.org.insightModel;
      if (effectiveProvider !== "anthropic" && !effectiveModel) {
        return reply.code(400).send({ error: `a model is required for ${effectiveProvider} — there is no instance-wide default for it` });
      }
      if (req.body && "apiKey" in req.body) {
        const apiKey = req.body.apiKey?.trim();
        if (!apiKey) {
          set.encryptedInsightApiKey = null;
        } else {
          if (effectiveProvider === "anthropic" && apiKey.startsWith("sk-ant-oat")) {
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
      if (Object.keys(set).length === 0) return reply.code(400).send({ error: "nothing to update — pass provider, model and/or apiKey" });

      await db.update(orgs).set(set).where(eq(orgs.id, found.org.id));
      await db.insert(auditLog).values({
        orgId: found.org.id,
        actorUserId: ctx.userId,
        action: "settings.insight",
        target: found.org.name,
        payload: {
          provider: "insightProvider" in set ? set.insightProvider : undefined,
          model: "insightModel" in set ? set.insightModel : undefined,
          keyChanged: "encryptedInsightApiKey" in set ? (set.encryptedInsightApiKey ? "set" : "cleared") : undefined,
        },
      });
      const fresh = (await db.select().from(orgs).where(eq(orgs.id, found.org.id)).limit(1))[0]!;
      return {
        ok: true,
        provider: fresh.insightProvider ?? "anthropic",
        model: fresh.insightModel,
        hasKey: Boolean(fresh.encryptedInsightApiKey),
      };
    },
  );

  /**
   * List the models a key can use, fetched live from the chosen provider —
   * key-first configuration: enter the key, load the models it unlocks, pick
   * one. The key may come from the request (not yet saved) or fall back to
   * the org's stored key, then the instance Anthropic key. Doubles as key
   * validation: a bad key returns the provider's own error as a 502.
   */
  app.post<{ Params: { id: string }; Body: { provider?: string; apiKey?: string } }>(
    "/api/orgs/:id/settings/insight/models",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
      if (!found) return;

      const provider = req.body?.provider?.trim() || found.org.insightProvider || "anthropic";
      if (!isInsightProvider(provider)) {
        return reply.code(400).send({ error: `provider must be one of ${INSIGHT_PROVIDERS.join(", ")}` });
      }
      let apiKey = req.body?.apiKey?.trim() || "";
      if (!apiKey && found.org.encryptedInsightApiKey && deps.cfg.CONSOLE_MASTER_KEY) {
        // Only reuse the stored key for the provider it was saved for.
        if ((found.org.insightProvider ?? "anthropic") === provider) {
          apiKey = decryptSecret(found.org.encryptedInsightApiKey, deps.cfg.CONSOLE_MASTER_KEY);
        }
      }
      if (!apiKey && provider === "anthropic") apiKey = deps.cfg.ANTHROPIC_API_KEY;
      if (!apiKey) return reply.code(400).send({ error: "enter an API key first — models are listed with the key that will use them" });
      if (provider === "anthropic" && apiKey.startsWith("sk-ant-oat")) {
        return reply.code(400).send({
          error:
            "that is a Claude Code OAuth token, not an API key — it authenticates Claude Code (the factory's agents), not direct API calls. Create an API key at platform.claude.com and use that here.",
        });
      }
      try {
        const models = await listModels(provider, apiKey);
        return { provider, models };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * Write an agent token to every connected repo's GitHub Actions secrets in
   * one pass (the same write-through as the per-repo onboarding step), and
   * retain it sealed in orchestrator_secrets for the LangGraph engine.
   * Per-repo results, never all-or-nothing; retention happens first, so a
   * repo write failing never loses the orchestrator's copy.
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
      const retained = await retainOrchestratorSecret(deps, found.org.id, name, value, ctx.login);
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
        payload: { name, retained, repos: results.map((r) => ({ repo: r.repo, ok: r.ok })) },
      });
      return { name, retained, results };
    },
  );
}

/**
 * Seal an agent secret into orchestrator_secrets (upsert per org+name).
 * Returns false — retention skipped, write-through still proceeds — when
 * CONSOLE_MASTER_KEY is unset, since there is nothing safe to store with.
 */
export async function retainOrchestratorSecret(
  deps: AppDeps,
  orgId: string,
  name: string,
  value: string,
  updatedBy: string,
): Promise<boolean> {
  if (!deps.cfg.CONSOLE_MASTER_KEY) return false;
  await deps.dbh.db
    .insert(orchestratorSecrets)
    .values({
      orgId,
      name,
      encryptedValue: encryptSecret(value, deps.cfg.CONSOLE_MASTER_KEY),
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [orchestratorSecrets.orgId, orchestratorSecrets.name],
      set: {
        encryptedValue: encryptSecret(value, deps.cfg.CONSOLE_MASTER_KEY),
        updatedBy,
        updatedAt: new Date(),
      },
    });
  return true;
}

export async function loadOrg(
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
