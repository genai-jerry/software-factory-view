import { randomUUID } from "node:crypto";
import {
  factoryStartLabel,
  githubActionsEnabled,
  InstallationClient,
  installationTokenForOrchestrator,
  postOrchestratorGitHubEvent,
  type GhIssue,
} from "@console/core";
import { estates, orgs } from "@console/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps } from "../context.js";
import { readRetainedAgentSecrets } from "../orchestrator-secrets.js";
import {
  fetchOrchestratorRun,
  fetchOrchestratorRuns,
  fetchOrchestratorTranscript,
} from "../orchestrator-dispatch.js";
import { loadEpic } from "./read.js";

/**
 * Same-origin stand-in for the orchestrator's /runs JSON. GitHub comments
 * link PUBLIC_BASE_URL/runs/{id}; the Console page at that path loads these
 * routes so the browser never opens raw :8080 JSON.
 */
export function registerOrchestratorRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Querystring: { repo?: string; issue?: string } }>("/api/orchestrator/runs", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repo = req.query.repo?.trim() ?? "";
    const issue = Number(req.query.issue);
    if (!repo || !Number.isInteger(issue) || issue < 1) {
      return reply.code(400).send({ error: "repo and issue are required" });
    }
    const got = await fetchOrchestratorRuns(deps.cfg, { repo, issue });
    if ("error" in got) return reply.code(got.status).send({ error: got.error });
    return { runs: got.runs };
  });

  app.get<{ Params: { runId: string } }>("/api/orchestrator/runs/:runId", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const got = await fetchOrchestratorRun(deps.cfg, req.params.runId);
    if ("error" in got) return reply.code(got.status).send({ error: got.error });
    return got.run;
  });

  app.get<{ Params: { runId: string } }>("/api/orchestrator/runs/:runId/transcript", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const got = await fetchOrchestratorTranscript(deps.cfg, req.params.runId);
    if ("error" in got) return reply.code(got.status).send({ error: got.error });
    return { transcript: got.transcript };
  });

  /**
   * Called by the orchestrator immediately before a GitHub action. Dispatch-time
   * tokens last ~1h and a Profiler run can take 45 minutes; this mints a new
   * installation token so GET /issues/{n} does not 401 mid-run.
   */
  app.post<{ Body: { installation_id?: number } }>("/api/orchestrator/github-token", async (req, reply) => {
    const expected = deps.cfg.ORCHESTRATOR_DISPATCH_TOKEN.trim();
    if (!expected || req.headers.authorization !== `Bearer ${expected}`) {
      return reply.code(401).send({ error: "dispatch token required" });
    }
    const installationId = Number(req.body?.installation_id);
    if (!Number.isInteger(installationId) || installationId < 1) {
      return reply.code(400).send({ error: "installation_id is required" });
    }
    const known = (
      await deps.dbh.db.select({ id: estates.id }).from(estates).where(eq(estates.installationId, installationId)).limit(1)
    )[0];
    if (!known) return reply.code(404).send({ error: "unknown installation" });
    try {
      const auth = await deps.credentials.auth();
      if (!auth) return reply.code(503).send({ error: "GitHub App is not configured" });
      const minted = await auth.mintInstallationToken(installationId, { forceFresh: true });
      return { token: minted.token, expires_at: new Date(minted.expiresAt).toISOString() };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * Hand an already-projected issue to the orchestrator. Needed because the
   * original GitHub delivery was consumed by the Console and never reached
   * :8080 — relabelling also works once the worker forwards events.
   */
  app.post<{ Params: { id: string } }>("/api/epics/:id/factory-run", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const { epic, repo } = found;
    if (epic.state !== "open") return reply.code(409).send({ error: "issue is closed" });

    const org = (await deps.dbh.db.select().from(orgs).where(eq(orgs.id, repo.orgId)).limit(1))[0];
    if (!org || githubActionsEnabled(org.orchestrator)) {
      return reply.code(409).send({
        error: "this org uses GitHub Actions — factory roles start from the labelled issue, not this button",
      });
    }

    const estate = (await deps.dbh.db.select().from(estates).where(eq(estates.id, repo.estateId)).limit(1))[0];
    if (!estate) return reply.code(404).send({ error: "estate not found" });
    const [owner, name] = repo.fullName.split("/") as [string, string];

    const ghIssue = await liveGithubIssue(deps, estate.installationId, owner, name, epic.number);
    const issue = ghIssue ?? projectedGithubIssue(epic);
    const labels = githubLabelNames(issue);
    const startLabel = factoryStartLabel(labels);
    const action = startLabel ? "labeled" : "opened";
    const payload: Record<string, unknown> = {
      action,
      issue,
      sender: { login: ctx.login },
      repository: {
        node_id: repo.ghNodeId,
        full_name: repo.fullName,
        default_branch: repo.defaultBranch,
        owner: { login: owner },
        name,
      },
      installation: { id: estate.installationId },
      ...(startLabel ? { label: { name: startLabel } } : {}),
    };

    let githubToken: string | undefined;
    try {
      const auth = await deps.credentials.auth();
      if (auth) githubToken = await installationTokenForOrchestrator(auth, estate.installationId);
    } catch {
      /* orchestrator can still mint its own JWT if it has a real App key */
    }
    const secrets = await readRetainedAgentSecrets(deps, repo.orgId);
    const deliveryGuid = `console-kick-${epic.id}-${randomUUID()}`;
    const result = await postOrchestratorGitHubEvent(deps.cfg, {
      event: "issues",
      payload,
      deliveryGuid,
      githubToken,
      ...secrets,
    });
    if ("skipped" in result) {
      return reply.code(502).send({
        error:
          "ORCHESTRATOR_URL is not set, so the Console cannot ask the Software Factory orchestrator to start. Set it to http://host.docker.internal:8080 from Docker.",
      });
    }
    if ("error" in result) return reply.code(502).send({ error: result.error });
    return {
      queued: result.queued,
      deliveryGuid: result.deliveryGuid,
      action,
      label: startLabel,
    };
  });
}

function githubLabelNames(issue: Record<string, unknown>): string[] {
  const raw = issue.labels;
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => (typeof l === "string" ? l : (l as { name?: string }).name)).filter((n): n is string => Boolean(n));
}

function projectedGithubIssue(epic: {
  ghNodeId: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  author: string | null;
  htmlUrl: string;
  ghUpdatedAt: Date;
}): Record<string, unknown> {
  return {
    node_id: epic.ghNodeId,
    number: epic.number,
    title: epic.title,
    body: epic.body,
    state: epic.state,
    labels: epic.labels.map((name) => ({ name })),
    user: { login: epic.author ?? "unknown", type: "User" },
    html_url: epic.htmlUrl,
    updated_at: epic.ghUpdatedAt.toISOString(),
  };
}

async function liveGithubIssue(
  deps: AppDeps,
  installationId: number,
  owner: string,
  repo: string,
  number: number,
): Promise<Record<string, unknown> | null> {
  try {
    const auth = await deps.credentials.auth();
    if (!auth) return null;
    const client = new InstallationClient(deps.cfg.GITHUB_API_URL, auth, installationId);
    const issue = await client.getIssue(owner, repo, number);
    if ((issue as GhIssue).pull_request) return null;
    return issue as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}
