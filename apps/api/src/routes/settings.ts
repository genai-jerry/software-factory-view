import {
  AGENT_SECRET_NAMES,
  decryptSecret,
  encryptSecret,
  githubActionsEnabled,
  InstallationClient,
  isAgentSecretName,
  isConsoleOrchestrator,
  normalizeConsoleOrchestrator,
} from "@console/core";
import { INSIGHT_PROVIDERS, isInsightProvider, listModels } from "@console/insight";
import { auditLog, estates, memberships, onboardingRuns, orgs, repos } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, type AppDeps, type RequestCtx } from "../context.js";
import { listRetainedSecretMeta, retainOrchestratorSecret } from "../orchestrator-secrets.js";

/**
 * Org settings: each org names its orchestrator (GitHub Actions or Software
 * Factory), its Ask-the-Factory model and API key, and an agent token. When
 * GitHub Actions is selected the token is written through to Actions secrets;
 * when it is disabled the token is retained only in the Console for the
 * Software Factory orchestrator.
 */

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get<{ Params: { id: string } }>("/api/orgs/:id/settings", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: false });
    if (!found) return;
    const engine = normalizeConsoleOrchestrator(found.org.orchestrator);
    const retainedSecrets = await listRetainedSecretMeta(deps, found.org.id);
    const hasRetainedAnthropic = retainedSecrets.some((r) => r.name === "ANTHROPIC_API_KEY");
    return {
      id: found.org.id,
      name: found.org.name,
      role: found.membership.role,
      orchestrator: {
        engine,
        githubActionsEnabled: githubActionsEnabled(engine),
      },
      insight: {
        provider: found.org.insightProvider ?? "anthropic",
        model: found.org.insightModel,
        hasKey: Boolean(found.org.encryptedInsightApiKey),
        defaultModel: deps.cfg.INSIGHT_DEEP_MODEL,
        globalKeyConfigured: Boolean(deps.cfg.ANTHROPIC_API_KEY) || hasRetainedAnthropic,
        providers: INSIGHT_PROVIDERS,
      },
      branches: {
        defaultBranch: found.org.defaultBranch,
        stagingBranch: found.org.stagingBranch,
      },
      allowedSecrets: [...AGENT_SECRET_NAMES],
      retainedSecrets,
    };
  });

  /**
   * Org-wide branch defaults (FACTORY.md §6a). The staging name is the
   * integration branch every implementation PR merges to — the factory cuts
   * it from the default branch on first need (`auto_create`), so naming it
   * here is enough; no branch is created from the Console. Applied to repos
   * without their own `.github/factory-branches.json`, and templated into the
   * stub-files PR for newly connected repos.
   */
  app.post<{ Params: { id: string }; Body: { defaultBranch?: string | null; stagingBranch?: string | null } }>(
    "/api/orgs/:id/settings/branches",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
      if (!found) return;

      const set: Partial<typeof orgs.$inferInsert> = {};
      for (const key of ["defaultBranch", "stagingBranch"] as const) {
        if (!req.body || !(key in req.body)) continue;
        const raw = req.body[key]?.trim();
        if (!raw) {
          set[key] = null;
          continue;
        }
        if (!isValidBranchName(raw)) {
          return reply.code(400).send({ error: `${key} is not a valid git branch name` });
        }
        set[key] = raw;
      }
      if (set.defaultBranch !== undefined || set.stagingBranch !== undefined) {
        const effDefault = "defaultBranch" in set ? set.defaultBranch : found.org.defaultBranch;
        const effStaging = "stagingBranch" in set ? set.stagingBranch : found.org.stagingBranch;
        if (effDefault && effStaging && effDefault === effStaging) {
          return reply.code(400).send({
            error: "staging and default cannot be the same branch — the promotion PR merges staging into default",
          });
        }
      }
      if (Object.keys(set).length === 0) {
        return reply.code(400).send({ error: "nothing to update — pass defaultBranch and/or stagingBranch" });
      }

      await db.update(orgs).set(set).where(eq(orgs.id, found.org.id));
      await db.insert(auditLog).values({
        orgId: found.org.id,
        actorUserId: ctx.userId,
        action: "settings.branches",
        target: found.org.name,
        payload: set,
      });
      const fresh = (await db.select().from(orgs).where(eq(orgs.id, found.org.id)).limit(1))[0]!;
      return { ok: true, defaultBranch: fresh.defaultBranch, stagingBranch: fresh.stagingBranch };
    },
  );

  /**
   * Pick which engine drives this org's factory pipeline. Switching does not
   * rewrite repos; re-run the stub-files onboarding step so each repo's
   * `.github/factory-orchestrator.json` matches.
   */
  app.post<{ Params: { id: string }; Body: { engine?: string } }>(
    "/api/orgs/:id/settings/orchestrator",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
      if (!found) return;
      const engine = req.body?.engine?.trim();
      if (!isConsoleOrchestrator(engine)) {
        return reply.code(400).send({ error: "engine must be github-actions or software-factory" });
      }
      await db.update(orgs).set({ orchestrator: engine }).where(eq(orgs.id, found.org.id));
      await db.insert(auditLog).values({
        orgId: found.org.id,
        actorUserId: ctx.userId,
        action: "settings.orchestrator",
        target: found.org.name,
        payload: { engine },
      });
      return { ok: true, engine, githubActionsEnabled: githubActionsEnabled(engine) };
    },
  );

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
   * Write an agent token. Always retained in the Console (when a master key
   * is set) for the Software Factory orchestrator. Written through to GitHub
   * Actions secrets only when that engine is selected for the org.
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
      if (!isAgentSecretName(name)) {
        return reply.code(400).send({ error: `secret must be one of ${AGENT_SECRET_NAMES.join(", ")}` });
      }
      const actions = githubActionsEnabled(found.org.orchestrator);
      if (!actions && !deps.cfg.CONSOLE_MASTER_KEY) {
        return reply.code(409).send({
          error:
            "GitHub Actions is disabled for this organisation, so the token must be stored in the Console — set CONSOLE_MASTER_KEY first",
        });
      }
      const { stored } = await retainOrchestratorSecret(deps, {
        orgId: found.org.id,
        name,
        value,
        updatedBy: ctx.login,
      });

      const results: Array<{ repo: string; ok: boolean; error?: string }> = [];
      if (actions) {
        const auth = await deps.credentials.auth();
        if (!auth) return reply.code(409).send({ error: "no GitHub App registered — complete setup first" });
        const estateRows = await db.select().from(estates).where(eq(estates.orgId, found.org.id));
        for (const estate of estateRows) {
          const client = new InstallationClient(deps.cfg.GITHUB_API_URL, auth, estate.installationId);
          const repoRows = await db.select().from(repos).where(eq(repos.estateId, estate.id));
          for (const repo of repoRows) {
            const [owner, repoName] = repo.fullName.split("/") as [string, string];
            try {
              await client.putActionsSecret(owner, repoName, name, value);
              results.push({ repo: repo.fullName, ok: true });
              await recordSecretStep(deps, repo, "ok", {
                name,
                writtenAt: new Date().toISOString(),
                via: "org-settings",
                stored,
                githubActions: true,
              });
            } catch (err) {
              results.push({ repo: repo.fullName, ok: false, error: (err as Error).message });
              await recordSecretStep(deps, repo, "failed", {
                name,
                error: (err as Error).message,
                via: "org-settings",
                stored,
                githubActions: true,
              });
            }
          }
        }
      }

      await db.insert(auditLog).values({
        orgId: found.org.id,
        actorUserId: ctx.userId,
        action: "settings.secret",
        target: found.org.name,
        payload: { name, stored, githubActions: actions, repos: results.map((r) => ({ repo: r.repo, ok: r.ok })) },
      });
      return { name, stored, githubActions: actions, results };
    },
  );
}

/** git-check-ref-format, the parts that matter for a typed-in branch name. */
function isValidBranchName(name: string): boolean {
  if (name.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//")) return false;
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
