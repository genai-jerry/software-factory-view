import {
  decryptSecret,
  githubActionsEnabled,
  postOrchestratorGitHubEvent,
  InstallationClient,
  mintForOrchestrator,
  type AppAuth,
  type ConsoleConfig,
  type GhComment,
  type GhIssue,
  type GhPull,
  type GhWorkflowRun,
} from "@console/core";
import { estates, issues, orchestratorSecrets, orgs, repos, webhookDeliveries, type Db } from "@console/db";
import { and, eq } from "drizzle-orm";
import {
  ensureRepo,
  projectComment,
  projectIssue,
  projectLabelEvent,
  projectPull,
  projectRun,
  type RepoRef,
} from "./project.js";
import {
  importGateAssignments,
  refreshEpicArtifacts,
  refreshRepoProfile,
  updateProfileStepFromComment,
  updateProfileStepFromIssue,
  updateProfileStepFromPull,
  updateProfileStepFromRun,
} from "./artifacts.js";

/**
 * Webhook event dispatcher. The API enqueues {deliveryGuid, event, payload}
 * verbatim after HMAC verification; everything here is idempotent, so a
 * replayed or re-ordered delivery converges (spec 01 §2.2).
 */

export interface WebhookJob {
  deliveryGuid: string;
  event: string;
  payload: Record<string, unknown>;
}

interface CommonPayload {
  installation?: { id: number };
  repository?: { node_id: string; full_name: string; default_branch?: string; private?: boolean };
  sender?: { login: string };
  action?: string;
}

export async function processWebhook(db: Db, cfg: ConsoleConfig, auth: AppAuth, job: WebhookJob): Promise<void> {
  const p = job.payload as CommonPayload & Record<string, unknown>;

  switch (job.event) {
    case "installation": {
      await handleInstallation(db, p);
      break;
    }
    case "installation_repositories": {
      await handleInstallationRepos(db, p);
      break;
    }
    case "issues": {
      if (!p.repository || !p.installation) break;
      const repo = await ensureRepo(db, p.installation.id, p.repository);
      const issue = p["issue"] as GhIssue;
      const { issueId, stateChanged } = await projectIssue(db, repo, issue);
      if ((p.action === "labeled" || p.action === "unlabeled") && p["label"]) {
        const label = (p["label"] as { name: string }).name;
        await projectLabelEvent(db, repo, issue.node_id, {
          action: p.action,
          label,
          actor: p.sender?.login ?? null,
          eventId: job.deliveryGuid,
          occurredAt: issue.updated_at,
        });
        await updateProfileStepFromIssue(db, repo, issue, p.action, label);
      }
      // A state flip on an epic is the moment its artifacts are about to be
      // reviewed — prefetch them so the gate panel opens warm.
      if (issueId && stateChanged) {
        await maybeRefreshArtifacts(db, cfg, auth, repo, issueId, issue.number);
      }
      break;
    }
    case "issue_comment": {
      if (!p.repository || !p.installation) break;
      const repo = await ensureRepo(db, p.installation.id, p.repository);
      const issue = p["issue"] as GhIssue;
      await projectIssue(db, repo, issue);
      await projectComment(db, repo, issue.node_id, p["comment"] as GhComment);
      await updateProfileStepFromComment(db, repo, issue, p["comment"] as GhComment);
      break;
    }
    case "pull_request": {
      if (!p.repository || !p.installation) break;
      const repo = await ensureRepo(db, p.installation.id, p.repository);
      const pr = p["pull_request"] as GhPull;
      await projectPull(db, repo, pr);
      // The Profiler's correction PR (head `factory/profile`) is the repo-
      // profile step's deliverable — surface it on the onboarding card.
      await updateProfileStepFromPull(db, repo, pr);
      // A document PR opening/updating means fresh artifact refs for its epic.
      const num = pr.head.ref.match(/^factory\/(\d+)-(spec|design)$/)?.[1];
      if (num) {
        const epic = (
          await db
            .select({ id: issues.id, number: issues.number })
            .from(issues)
            .where(and(eq(issues.repoId, repo.id), eq(issues.number, Number(num))))
            .limit(1)
        )[0];
        if (epic) await maybeRefreshArtifacts(db, cfg, auth, repo, epic.id, epic.number);
      }
      break;
    }
    case "workflow_run": {
      if (!p.repository || !p.installation) break;
      const repo = await ensureRepo(db, p.installation.id, p.repository);
      const run = p["workflow_run"] as GhWorkflowRun;
      await projectRun(db, repo, run);
      // A red run while the profile step waits is the error the onboarding
      // card would otherwise never hear about.
      await updateProfileStepFromRun(db, repo, run);
      break;
    }
    case "push": {
      if (!p.repository || !p.installation) break;
      const repo = await ensureRepo(db, p.installation.id, p.repository);
      const commits = (p["commits"] as Array<{ added?: string[]; modified?: string[]; removed?: string[] }> | undefined) ?? [];
      const touched = commits.flatMap((c) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]);
      const configTouched = touched.some(
        (f) => f.startsWith(".factory/") || f.startsWith(".github/factory-") || f === ".github/workflows/factory-pipeline.yml",
      );
      if (configTouched) {
        const reader = new InstallationClient(cfg.GITHUB_API_URL, auth, p.installation.id);
        await refreshRepoProfile(db, repo, reader);
        await importGateAssignments(db, repo, reader);
      }
      break;
    }
    default:
      break; // events we consume but do not yet project (check_suite etc. covered by workflow_run rollup)
  }

  await maybeForwardToOrchestrator(db, cfg, auth, job);

  await db
    .update(webhookDeliveries)
    .set({ processedAt: new Date(), error: null })
    .where(eq(webhookDeliveries.deliveryGuid, job.deliveryGuid));
}

const FORWARD_EVENTS = new Set(["issues", "issue_comment", "push", "milestone"]);

/**
 * GitHub delivers Console App webhooks to PUBLIC_ORIGIN. Under the Software
 * Factory engine those events must also reach the LangGraph orchestrator or
 * fast-track / intake / profile issues sit idle on the board.
 */
async function maybeForwardToOrchestrator(
  db: Db,
  cfg: ConsoleConfig,
  auth: AppAuth,
  job: WebhookJob,
): Promise<void> {
  if (!FORWARD_EVENTS.has(job.event)) return;
  if (!cfg.ORCHESTRATOR_URL.trim()) return;
  const repository = job.payload["repository"] as { node_id?: string } | undefined;
  if (!repository?.node_id) return;
  const repo = (await db.select().from(repos).where(eq(repos.ghNodeId, repository.node_id)).limit(1))[0];
  if (!repo) return;
  const org = (await db.select().from(orgs).where(eq(orgs.id, repo.orgId)).limit(1))[0];
  if (!org || githubActionsEnabled(org.orchestrator)) return;

  const installationId = (job.payload["installation"] as { id?: number } | undefined)?.id;
  let githubToken: string | undefined;
  let githubTokenExpiresAt: string | undefined;
  if (installationId) {
    try {
      const minted = await mintForOrchestrator(auth, installationId);
      githubToken = minted.token;
      githubTokenExpiresAt = new Date(minted.expiresAt).toISOString();
    } catch {
      /* orchestrator can still mint its own JWT if it has a real App key */
    }
  }
  const secrets = await agentSecretsForOrg(db, cfg, repo.orgId);
  const result = await postOrchestratorGitHubEvent(cfg, {
    event: job.event,
    payload: job.payload,
    deliveryGuid: job.deliveryGuid,
    githubToken,
    githubTokenExpiresAt,
    ...secrets,
  });
  if ("skipped" in result) return;
  if ("error" in result) {
    throw new Error(result.error);
  }
  console.log(
    `forwarded ${job.event} ${job.deliveryGuid} to orchestrator queued=${result.queued}`,
  );
}

async function agentSecretsForOrg(
  db: Db,
  cfg: ConsoleConfig,
  orgId: string,
): Promise<{ anthropicApiKey?: string; claudeCodeOauthToken?: string }> {
  if (!cfg.CONSOLE_MASTER_KEY) return {};
  const rows = await db.select().from(orchestratorSecrets).where(eq(orchestratorSecrets.orgId, orgId));
  const out: { anthropicApiKey?: string; claudeCodeOauthToken?: string } = {};
  for (const row of rows) {
    if (row.name === "ANTHROPIC_API_KEY") out.anthropicApiKey = decryptSecret(row.encryptedValue, cfg.CONSOLE_MASTER_KEY);
    if (row.name === "CLAUDE_CODE_OAUTH_TOKEN") out.claudeCodeOauthToken = decryptSecret(row.encryptedValue, cfg.CONSOLE_MASTER_KEY);
  }
  return out;
}

async function maybeRefreshArtifacts(
  db: Db,
  cfg: ConsoleConfig,
  auth: AppAuth,
  repo: RepoRef,
  epicIssueId: string,
  epicNumber: number,
): Promise<void> {
  if (!cfg.CONSOLE_MASTER_KEY) return;
  try {
    const estate = (await db.select().from(estates).where(eq(estates.id, repo.estateId)).limit(1))[0];
    if (!estate) return;
    const reader = new InstallationClient(cfg.GITHUB_API_URL, auth, estate.installationId);
    await refreshEpicArtifacts(db, repo, reader, epicIssueId, epicNumber, cfg.CONSOLE_MASTER_KEY);
  } catch (err) {
    // Artifact prefetch is best-effort; the reconciler will repair.
    console.warn(`artifact refresh failed for epic #${epicNumber}:`, (err as Error).message);
  }
}

async function handleInstallation(db: Db, p: CommonPayload & Record<string, unknown>): Promise<void> {
  const installation = p["installation"] as { id: number; account: { login: string } };
  if (p.action === "created") {
    const reposList = (p["repositories"] as Array<{ node_id: string; full_name: string }> | undefined) ?? [];
    let estate = (await db.select().from(estates).where(eq(estates.installationId, installation.id)).limit(1))[0];
    if (!estate) {
      const org = (await db.insert(orgs).values({ name: installation.account.login }).returning())[0]!;
      estate = (
        await db.insert(estates).values({ orgId: org.id, name: installation.account.login, installationId: installation.id }).returning()
      )[0]!;
    }
    for (const r of reposList) {
      await db
        .insert(repos)
        .values({ orgId: estate.orgId, estateId: estate.id, ghNodeId: r.node_id, fullName: r.full_name })
        .onConflictDoNothing({ target: repos.ghNodeId });
    }
  }
  if (p.action === "deleted") {
    // Hard-delete projections for the estate (spec 02 §4); cascades from estates.
    await db.delete(estates).where(eq(estates.installationId, installation.id));
  }
}

async function handleInstallationRepos(db: Db, p: CommonPayload & Record<string, unknown>): Promise<void> {
  const installation = p["installation"] as { id: number; account: { login: string } };
  const estate = (await db.select().from(estates).where(eq(estates.installationId, installation.id)).limit(1))[0];
  if (!estate) return;
  const added = (p["repositories_added"] as Array<{ node_id: string; full_name: string }> | undefined) ?? [];
  const removed = (p["repositories_removed"] as Array<{ node_id: string }> | undefined) ?? [];
  for (const r of added) {
    await db
      .insert(repos)
      .values({ orgId: estate.orgId, estateId: estate.id, ghNodeId: r.node_id, fullName: r.full_name })
      .onConflictDoNothing({ target: repos.ghNodeId });
  }
  for (const r of removed) {
    await db.delete(repos).where(eq(repos.ghNodeId, r.node_id));
  }
}
