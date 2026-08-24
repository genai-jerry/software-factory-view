import {
  AGENT_SECRET_NAMES,
  FACTORY_KIND_LABELS,
  FACTORY_LABELS,
  GitHubHttpError,
  githubActionsEnabled,
  InstallationClient,
  isAgentSecretName,
  parseApproverFile,
  parseRepoOrchestratorEngine,
  repoEngineName,
} from "@console/core";
import { auditLog, estates, gateAssignments, memberships, onboardingRuns, orgs, pullRequests, repos } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, userClient, type AppDeps, type RequestCtx } from "../context.js";
import { dispatchFactoryRole, syncDispatchStatus } from "../orchestrator-dispatch.js";
import { orgHasRetainedAgentSecret, readRetainedAgentSecrets, retainOrchestratorSecret } from "../orchestrator-secrets.js";

/**
 * Onboarding (spec 03): idempotent steps that report found / created / fixed,
 * resumable state in onboarding_runs, and a validation suite that makes no
 * writes on a healthy repo. Steps run under the installation token — the app
 * may automate setup; only humans merge the PR that turns the factory on.
 */

const FACTORY_REPO = "genai-jerry/claude-software-factory";
const FACTORY_REF = "v1";

/**
 * Anthropic's Claude GitHub App. At run time `claude-code-action` exchanges the
 * workflow's OIDC token for an installation token of this App — that token is
 * how agent jobs comment on issues and open PRs. It is a run-time dependency
 * the wizard used to say nothing about: with the App missing, setup looks
 * green and then every agent job dies at startup with "Claude Code is not
 * installed on this repository" (a 401 from the token exchange).
 */
const CLAUDE_APP_URL = "https://github.com/apps/claude";

/**
 * The profile issue's trigger label. Deliberately not in FACTORY_LABELS: that
 * list is the board's state model (`isFactoryState` drives the projections),
 * and this is a kind marker on one maintenance issue, not a place in the
 * pipeline.
 */
const PROFILE_LABEL = {
  name: "factory:profile",
  color: "5A4A7A",
  description: "Repo profile issue: the Profiler drafts and re-checks .factory/profile.json (kind, not a state)",
};
const PROFILE_ISSUE_TITLE = "Factory: repo profile";
const PROFILE_ISSUE_BODY = [
  "The **Profiler** drafts this repository's `.factory/profile.json` — the stack facts every factory",
  "role treats as authoritative here (FACTORY.md §2c).",
  "",
  "It runs in this repository's own Actions runner, reads the code, and *runs* the test/build/lint",
  "commands it proposes rather than guessing them. It opens a PR with its evidence field by field.",
  "**Review that PR before merging it** — merging is where you agree to what the factory will treat",
  "as true from then on.",
  "",
  "Re-run it any time by removing and re-applying the `factory:profile` label. A push to the default",
  "branch that touches a manifest, lockfile, CI workflow or tool config re-checks it automatically.",
  "",
  "Filed by the Factory Console.",
].join("\n");

async function findProfileIssue(
  client: InstallationClient,
  owner: string,
  name: string,
): Promise<{ number: number; html_url: string; state: string } | undefined> {
  const labelled = (await client.listIssuesByLabel(owner, name, PROFILE_LABEL.name))[0];
  if (labelled) return labelled;
  const recent = await client.listIssues(owner, name, 1);
  return recent.find((i) => i.title === PROFILE_ISSUE_TITLE && !i.pull_request);
}

export function registerOnboardingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get<{ Params: { id: string } }>("/api/estates/:id/onboarding", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const estate = (
      await db.select().from(estates).where(and(eq(estates.id, req.params.id), inArray(estates.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!estate) return reply.code(404).send({ error: "organisation not found" });
    const org = (await db.select().from(orgs).where(eq(orgs.id, estate.orgId)).limit(1))[0]!;
    const engine = org.orchestrator;
    const repoRows = await db.select().from(repos).where(eq(repos.estateId, estate.id));
    const out = [];
    for (const r of repoRows) {
      let steps = await db.select().from(onboardingRuns).where(eq(onboardingRuns.repoId, r.id));
      const profile = steps.find((s) => s.step === "profile");
      if (profile && (profile.status === "pending" || profile.status === "failed")) {
        const sync = await syncDispatchStatus(deps.cfg, (profile.detail ?? {}) as Record<string, unknown>);
        if (sync) {
          await db
            .update(onboardingRuns)
            .set({ status: sync.status, detail: sync.detail, updatedAt: new Date() })
            .where(eq(onboardingRuns.id, profile.id));
          steps = await db.select().from(onboardingRuns).where(eq(onboardingRuns.repoId, r.id));
        }
      }
      out.push({
        repoId: r.id,
        fullName: r.fullName,
        factoryEnabled: r.factoryEnabled,
        steps: Object.fromEntries(steps.map((s) => [s.step, { status: s.status, detail: s.detail, updatedAt: s.updatedAt }])),
      });
    }
    return {
      estateId: estate.id,
      orchestrator: {
        engine: engine === "software-factory" ? "software-factory" : "github-actions",
        githubActionsEnabled: githubActionsEnabled(engine),
      },
      repos: out,
    };
  });

  /** Step 1 — labels: create the full factory:* label set idempotently; report drift fixed. */
  app.post<{ Params: { id: string } }>("/api/repos/:id/onboarding/labels", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const target = await loadAdminRepo(deps, ctx, req.params.id, reply);
    if (!target) return;
    const { repo, client, owner, name } = target;

    const result = { found: 0, created: 0, fixed: 0 };
    try {
      const existing = await client.listLabels(owner, name);
      const byName = new Map(existing.map((l) => [l.name, l]));
      for (const label of [...FACTORY_LABELS, ...FACTORY_KIND_LABELS]) {
        const have = byName.get(label.name);
        if (have && have.color.toLowerCase() === label.color.toLowerCase() && have.description === label.description) {
          result.found++;
          continue;
        }
        const outcome = await client.createLabel(owner, name, label);
        if (outcome === "created") result.created++;
        else result.fixed++;
      }
      await recordStep(deps, repo, "labels", "ok", result);
      return { ok: true, ...result };
    } catch (err) {
      await recordStep(deps, repo, "labels", "failed", { error: (err as Error).message });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Step 2 — secrets: retained in the Console; written to Actions only when that engine is on. */
  app.post<{ Params: { id: string }; Body: { name: string; value: string } }>(
    "/api/repos/:id/onboarding/secret",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const target = await loadAdminRepo(deps, ctx, req.params.id, reply);
      if (!target) return;
      const { repo, org, client, owner, name } = target;
      const secretName = req.body?.name;
      const value = req.body?.value;
      if (!secretName || !value) return reply.code(400).send({ error: "name and value required" });
      if (!isAgentSecretName(secretName)) {
        return reply.code(400).send({ error: `secret must be one of ${AGENT_SECRET_NAMES.join(", ")}` });
      }
      const actions = githubActionsEnabled(org.orchestrator);
      if (!actions && !deps.cfg.CONSOLE_MASTER_KEY) {
        return reply.code(409).send({
          error:
            "GitHub Actions is disabled for this organisation, so the token must be stored in the Console — set CONSOLE_MASTER_KEY first",
        });
      }
      try {
        const { stored } = await retainOrchestratorSecret(deps, {
          orgId: repo.orgId,
          name: secretName,
          value,
          updatedBy: ctx.login,
        });
        if (actions) {
          await client.putActionsSecret(owner, name, secretName, value);
        }
        await recordStep(deps, repo, "secrets", "ok", {
          name: secretName,
          writtenAt: new Date().toISOString(),
          stored,
          githubActions: actions,
        });
        return { ok: true, name: secretName, stored, githubActions: actions };
      } catch (err) {
        await recordStep(deps, repo, "secrets", "failed", { name: secretName, error: (err as Error).message });
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * The Claude GitHub App step. GitHub lets an App list only its *own*
   * installations, and the Claude App is Anthropic's, not this Console's — so
   * there is nothing to probe. What the step records is a human's confirmation
   * that they installed it (same honesty as the cross-repo-token validation
   * check), and until someone has actually looked, the wizard keeps the repo
   * at "needs setup" instead of letting the first agent run be the discovery.
   */
  app.post<{ Params: { id: string } }>("/api/repos/:id/onboarding/claude-app", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const target = await loadAdminRepo(deps, ctx, req.params.id, reply);
    if (!target) return;
    await recordStep(deps, target.repo, "claude-app", "ok", {
      confirmedBy: ctx.login,
      confirmedAt: new Date().toISOString(),
      appUrl: CLAUDE_APP_URL,
    });
    return { ok: true, confirmedBy: ctx.login };
  });

  /**
   * Step 3 — OpenSpec: no terminal required. Queues a worker job that runs the
   * pinned upstream CLI in a scratch directory and pushes the scaffold onto the
   * enablement branch, so it rides the same human-merged PR as the stubs.
   */
  app.post<{ Params: { id: string } }>("/api/repos/:id/onboarding/openspec", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const target = await loadAdminRepo(deps, ctx, req.params.id, reply);
    if (!target) return;
    const { repo, client, owner, name } = target;
    try {
      // Idempotence: initialised on the default branch means nothing to queue.
      const existing = await client.listDir(owner, name, "openspec");
      if (existing.length > 0) {
        await recordStep(deps, repo, "openspec", "ok", { found: true });
        return { ok: true, found: true, message: "openspec/ already on the repo — nothing to do" };
      }
      await recordStep(deps, repo, "openspec", "pending", { queuedAt: new Date().toISOString() });
      await deps.openspecQueue.add("init", { repoId: repo.id }, { removeOnComplete: 100, removeOnFail: 100 });
      return { ok: true, queued: true };
    } catch (err) {
      await recordStep(deps, repo, "openspec", "failed", { error: (err as Error).message });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Step 5 — stub-files PR: the consuming repo's whole footprint, one PR, human-merged. */
  app.post<{ Params: { id: string } }>("/api/repos/:id/onboarding/stubs", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const target = await loadAdminRepo(deps, ctx, req.params.id, reply);
    if (!target) return;
    const { repo, org, client, owner, name } = target;
    const actions = githubActionsEnabled(org.orchestrator);

    try {
      // Idempotence: re-running re-verifies rather than duplicating the PR —
      // unless the stub still uses `secrets: inherit` or omits factory_repo.
      // Inherit does not forward Anthropic credentials across GitHub accounts;
      // omitting factory_repo makes the v1 pipeline clone the caller's OWN
      // repo at the factory ref (workflow_ref names the caller, not the
      // factory) — "Remote branch v1 not found", or a git username prompt
      // when the caller repo is private. This path is GitHub Actions only:
      // when Actions is disabled we never patch or require workflow stubs.
      if (actions) {
        const existingStub = await client.getFileAtRef(owner, name, ".github/workflows/factory-pipeline.yml");
        if (existingStub && stubIsCurrent(existingStub.content)) {
          await recordStep(deps, repo, "stubs", "ok", { found: true, githubActions: true });
          return { ok: true, found: true, message: "stub already on the repo — nothing to do" };
        }
        if (existingStub) {
          const patched = rewriteCallerStub(existingStub.content);
          if (patched === existingStub.content) {
            await recordStep(deps, repo, "stubs", "ok", { found: true, githubActions: true });
            return { ok: true, found: true, message: "stub already on the repo — nothing to do" };
          }
          const headSha = await client.getBranchHeadSha(owner, name, repo.defaultBranch);
          if (!headSha) return reply.code(409).send({ error: `cannot resolve head of ${repo.defaultBranch}` });
          const branch = "factory-console/fix-caller-stub";
          if (!(await client.getBranchHeadSha(owner, name, branch))) {
            await client.createBranch(owner, name, branch, headSha);
          }
          const current = await client.getFileAtRef(owner, name, ".github/workflows/factory-pipeline.yml", branch);
          if (current?.content !== patched) {
            await client.putFile(owner, name, ".github/workflows/factory-pipeline.yml", {
              message: "factory: pass caller secrets and factory_repo into the reusable pipeline",
              content: patched,
              branch,
              sha: current?.sha,
            });
          }
          const pr = await ensurePull(client, owner, name, branch, repo.defaultBranch, {
            title: "Fix factory caller stub",
            body: STUB_PATCH_PR_BODY,
          });
          await recordStep(deps, repo, "stubs", "ok", { prNumber: pr.number, prUrl: pr.html_url, patched: true, githubActions: true });
          return { ok: true, prNumber: pr.number, prUrl: pr.html_url, patched: true };
        }
      } else {
        const existingCfg = await client.getFileAtRef(owner, name, ".github/factory-orchestrator.json");
        if (existingCfg && parseRepoOrchestratorEngine(existingCfg.content) === "langgraph") {
          await recordStep(deps, repo, "stubs", "ok", { found: true, githubActions: false });
          return { ok: true, found: true, message: "Software Factory orchestrator already claimed on this repo — nothing to do" };
        }
      }

      const approverRows = await db.select().from(gateAssignments).where(eq(gateAssignments.estateId, repo.estateId));
      const approversFromEstate = (gate: string) => [
        ...new Set(approverRows.filter((a) => a.gate === gate).map((a) => a.login)),
      ];
      const approvers = {
        spec: approversFromEstate("spec"),
        design: approversFromEstate("design"),
        implementation: approversFromEstate("implementation"),
        release: approversFromEstate("release"),
      };

      const headSha = await client.getBranchHeadSha(owner, name, repo.defaultBranch);
      if (!headSha) return reply.code(409).send({ error: `cannot resolve head of ${repo.defaultBranch}` });
      const branch = "factory-console/enable-factory";
      const existingBranch = await client.getBranchHeadSha(owner, name, branch);
      if (!existingBranch) await client.createBranch(owner, name, branch, headSha);

      const files = stubFiles(approvers, org.orchestrator);
      for (const [path, content] of Object.entries(files)) {
        const current = await client.getFileAtRef(owner, name, path, branch);
        if (current?.content === content) continue;
        await client.putFile(owner, name, path, {
          message: `factory: add ${path}`,
          content,
          branch,
          sha: current?.sha,
        });
      }

      const pr = await ensurePull(client, owner, name, branch, repo.defaultBranch, {
        title: "Enable the software factory",
        body: stubPrBody(actions),
      });
      await recordStep(deps, repo, "stubs", "ok", { prNumber: pr.number, prUrl: pr.html_url, githubActions: actions });
      return { ok: true, prNumber: pr.number, prUrl: pr.html_url };
    } catch (err) {
      await recordStep(deps, repo, "stubs", "failed", { error: (err as Error).message });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * Step 6 — the repo profile (FACTORY.md §2c).
   *
   * The Console does not write this one and could not write it well: the
   * profile is the repo's stack facts, and deriving them means reading the
   * code, which is the one thing the Console has no business holding. So it
   * asks instead. Filing an issue labelled `factory:profile` is the ask. Under
   * GitHub Actions that label starts the Profiler in the repo's own runner.
   * Under Software Factory the Console App's webhook never reaches the
   * orchestrator, so this route also POSTs /dispatch after filing.
   *
   * Filed under the signed-in user's identity, not the App's: the router
   * ignores bot-authored issues on `opened`, and this is a person asking.
   */
  app.post<{ Params: { id: string } }>("/api/repos/:id/onboarding/profile", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const target = await loadAdminRepo(deps, ctx, req.params.id, reply);
    if (!target) return;
    const { repo, estate, org, client, owner, name } = target;
    const actions = githubActionsEnabled(org.orchestrator);

    try {
      // A profile already on the default branch is the *current* draft, not a
      // finished conversation. Re-running asks the Profiler to re-read the
      // code and open a correction PR if it disagrees — the way to fix a
      // stale or wrong profile without the Console ever reading the source.

      // Preconditions, checked rather than assumed. GitHub Actions failures
      // would otherwise land as a red run the Console can see the conclusion
      // of but not the reason for. When Actions is disabled the Software
      // Factory orchestrator is the motor, so we check its claim and the
      // Console-retained credential instead of workflow stubs and Actions secrets.
      if (actions) {
        const stub = await client.getFileAtRef(owner, name, ".github/workflows/factory-pipeline.yml");
        if (!stub) {
          return reply.code(409).send({
            error:
              "the enablement PR is not merged yet — GitHub only fires workflows that exist on the default branch, so nothing would start. Merge it, then run this step.",
          });
        }
        const hasKey =
          (await client.getActionsSecret(owner, name, "ANTHROPIC_API_KEY")) ||
          (await client.getActionsSecret(owner, name, "CLAUDE_CODE_OAUTH_TOKEN"));
        if (!hasKey) {
          return reply.code(409).send({
            error: "no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN on this repo — the agent run would fail before it read a line of code. Run the secret step first.",
          });
        }
      } else {
        const cfg = await client.getFileAtRef(owner, name, ".github/factory-orchestrator.json");
        if (!cfg || parseRepoOrchestratorEngine(cfg.content) !== "langgraph") {
          return reply.code(409).send({
            error:
              "the enablement PR is not merged yet — the Software Factory orchestrator only claims a repo whose default branch has `.github/factory-orchestrator.json` with engine langgraph. Merge it, then run this step.",
          });
        }
        if (!(await orgHasRetainedAgentSecret(deps, repo.orgId))) {
          return reply.code(409).send({
            error:
              "no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN stored in the Console — GitHub Actions is disabled, so the orchestrator cannot read a repo Actions secret. Run the secret step first.",
          });
        }
      }

      // Self-healing, the same way the pipeline creates factory:in-progress on
      // first use: a repo onboarded before the Profiler existed never re-ran
      // setup-labels.sh, and the trigger label has to exist to be applied.
      await client.createLabel(owner, name, PROFILE_LABEL);

      // The profile issue is a singleton — one per repo, reused — so the
      // drafts, the drift checks and their evidence read as one thread. The
      // Profiler drops `factory:profile` when it finishes, so look up by title
      // when the label is gone.
      const user = userClient(deps, ctx);
      const found = await findProfileIssue(client, owner, name);
      if (found) {
        if (found.state === "closed") await user.reopenIssue(owner, name, found.number);
        // The Profiler drops the label when it finishes, so re-applying is what
        // asks for another run. Remove first for the case where a previous run
        // died before its cleanup: adding a label that is already there is a
        // no-op and emits no event, which would look like a button that does
        // nothing.
        await user.removeLabel(owner, name, found.number, PROFILE_LABEL.name);
        await user.addLabels(owner, name, found.number, [PROFILE_LABEL.name]);
        // requestedAt is the attribution window: the worker only pins Actions
        // runs (and their failures) to this step when they started after it.
        // A fresh detail object on purpose — every ask starts a clean story.
        const detail = {
          issueNumber: found.number,
          issueUrl: found.html_url,
          requestedAt: new Date().toISOString(),
          ...(actions ? {} : await dispatchProfiler(deps, repo.orgId, estate.installationId, owner, name, found.number)),
        };
        await recordStep(deps, repo, "profile", "pending", detail);
        return { ok: true, issueNumber: found.number, issueUrl: found.html_url, rerun: true };
      }

      const issue = await user.createIssue(owner, name, {
        title: PROFILE_ISSUE_TITLE,
        labels: [PROFILE_LABEL.name],
        body: PROFILE_ISSUE_BODY,
      });
      const detail = {
        issueNumber: issue.number,
        issueUrl: issue.html_url,
        requestedAt: new Date().toISOString(),
        ...(actions ? {} : await dispatchProfiler(deps, repo.orgId, estate.installationId, owner, name, issue.number)),
      };
      await recordStep(deps, repo, "profile", "pending", detail);
      return { ok: true, issueNumber: issue.number, issueUrl: issue.html_url, rerun: false };
    } catch (err) {
      await recordStep(deps, repo, "profile", "failed", { error: (err as Error).message });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * Merge the Profiler's correction PR — the human act the whole step points
   * at, made reachable from the card that started the run. As the signed-in
   * user, never the App: agreeing to the repo's stack facts is a person's
   * signature (same split as the gate merges — the App deliberately has no
   * merge method). The PR to merge is whatever the webhook flow recorded, so
   * the Console merges only the PR it has been showing the user.
   */
  app.post<{ Params: { id: string } }>("/api/repos/:id/onboarding/profile/merge", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const target = await loadAdminRepo(deps, ctx, req.params.id, reply);
    if (!target) return;
    const { repo, owner, name } = target;

    const step = (
      await db
        .select()
        .from(onboardingRuns)
        .where(and(eq(onboardingRuns.repoId, repo.id), eq(onboardingRuns.step, "profile")))
        .limit(1)
    )[0];
    const detail = (step?.detail ?? {}) as { prNumber?: unknown; prUrl?: unknown; prState?: unknown } & Record<string, unknown>;
    if (!step || typeof detail.prNumber !== "number" || detail.prState !== "open") {
      return reply.code(409).send({
        error: "no open Profiler PR is recorded for this repo — run the profile step and wait for the PR to appear here",
      });
    }

    const gh = userClient(deps, ctx);
    try {
      const result = await gh.mergePull(owner, name, detail.prNumber, { method: "squash" });
      await db.insert(auditLog).values({
        orgId: repo.orgId,
        actorUserId: ctx.userId,
        action: "pr.merge",
        target: `${owner}/${name}#${detail.prNumber}`,
        payload: { mergeSha: result.sha, kind: "profile" },
      });
      // Converge the projection now rather than waiting for the webhook round-trip.
      await db
        .update(pullRequests)
        .set({ state: "merged", mergedAt: new Date(), mergeCommitSha: result.sha })
        .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.number, detail.prNumber)));
      await recordStep(deps, repo, "profile", "ok", {
        ...detail,
        prState: "merged",
        mergedBy: ctx.login,
        mergeSha: result.sha,
      });
      return { ok: true, sha: result.sha, prNumber: detail.prNumber };
    } catch (err) {
      // GitHub said no (review required, conflicts, branch protection) —
      // surface that as GitHub's answer, not a Console fault, and leave the
      // step exactly as it was: the PR is still open and still mergeable on
      // GitHub once the objection is dealt with.
      return reply.code(409).send({ error: `GitHub declined the merge: ${(err as Error).message}` });
    }
  });

  /** Step 7 — validation suite: green/red per check, zero writes on a healthy repo. */
  app.post<{ Params: { id: string } }>("/api/repos/:id/onboarding/validate", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const target = await loadAdminRepo(deps, ctx, req.params.id, reply);
    if (!target) return;
    const { repo, org, client, owner, name } = target;
    const actions = githubActionsEnabled(org.orchestrator);

    const checks: Array<{ check: string; ok: boolean | null; detail: string }> = [];
    const push = (check: string, ok: boolean | null, detail: string) => checks.push({ check, ok, detail });

    try {
      // 1. Labels present and exact.
      const labels = await client.listLabels(owner, name);
      const byName = new Map(labels.map((l) => [l.name, l]));
      const wanted = [...FACTORY_LABELS, ...FACTORY_KIND_LABELS];
      const missing = wanted.filter((l) => !byName.has(l.name)).map((l) => l.name);
      const drifted = wanted.filter((l) => {
        const have = byName.get(l.name);
        return have && (have.color.toLowerCase() !== l.color.toLowerCase() || have.description !== l.description);
      }).map((l) => l.name);
      push(
        "labels",
        missing.length === 0 && drifted.length === 0,
        missing.length ? `missing: ${missing.join(", ")}` : drifted.length ? `drifted: ${drifted.join(", ")}` : `all ${wanted.length} present and exact`,
      );

      const orchestratorFile = await client.getFileAtRef(owner, name, ".github/factory-orchestrator.json");
      const claimed = parseRepoOrchestratorEngine(orchestratorFile?.content);
      if (actions) {
        // 2. Stubs on default branch with permissions: intact and refs in sync.
        const stub = await client.getFileAtRef(owner, name, ".github/workflows/factory-pipeline.yml");
        if (!stub) push("pipeline-stub", false, "not on the default branch — the pipeline cannot fire");
        else {
          const hasPermissions = /^permissions:/m.test(stub.content);
          const usesRef = stub.content.match(/uses:\s*\S+@(\S+)/)?.[1];
          const factoryRef = stub.content.match(/factory_ref:\s*(\S+)/)?.[1];
          const refsSync = Boolean(usesRef && factoryRef && usesRef === factoryRef);
          push(
            "pipeline-stub",
            hasPermissions && refsSync,
            !hasPermissions
              ? "permissions: block missing — runs will die at startup_failure"
              : !refsSync
                ? `uses:@${usesRef} vs factory_ref:${factoryRef} — version skew`
                : `present, permissions intact, pinned at ${usesRef}`,
          );
          push(
            "pipeline-secrets",
            stubPassesCallerSecrets(stub.content),
            stubPassesCallerSecrets(stub.content)
              ? "caller passes ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN by name"
              : /secrets:\s*inherit/.test(stub.content)
                ? "secrets: inherit does not forward secrets across GitHub accounts — re-run the stub-files step"
                : "caller does not pass Anthropic secrets into the reusable workflow",
          );
          push(
            "pipeline-factory-repo",
            stubPassesFactoryRepo(stub.content),
            stubPassesFactoryRepo(stub.content)
              ? `caller passes factory_repo (${stub.content.match(/factory_repo:\s*(\S+)/)?.[1]})`
              : "factory_repo missing — the pipeline clones this repo itself at the factory ref instead of the factory (`Remote branch v1 not found`). Re-run the stub-files step",
          );
        }
        const guard = await client.getFileAtRef(owner, name, ".github/workflows/factory-branch-guard.yml");
        push("branch-guard-stub", Boolean(guard), guard ? "present" : "missing — no factory:incident on direct main commits");

        // 3. Repository-level secret exists (presence only).
        const hasKey = (await client.getActionsSecret(owner, name, "ANTHROPIC_API_KEY")) || (await client.getActionsSecret(owner, name, "CLAUDE_CODE_OAUTH_TOKEN"));
        push("actions-secret", hasKey, hasKey ? "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN present" : "neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set as a repository secret");
      } else {
        push(
          "orchestrator-config",
          claimed === "langgraph",
          claimed === "langgraph"
            ? "`.github/factory-orchestrator.json` claims the Software Factory orchestrator"
            : "GitHub Actions is disabled — merge an enablement PR that sets `.github/factory-orchestrator.json` engine to langgraph",
        );
        const retained = await orgHasRetainedAgentSecret(deps, repo.orgId);
        push(
          "console-secret",
          retained,
          retained
            ? "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN stored in the Console for the orchestrator"
            : "neither agent token is stored in the Console — GitHub Actions is disabled so Actions secrets are not used",
        );
      }

      // 4. Claude GitHub App — only required when GitHub Actions runs
      // claude-code-action. The Software Factory orchestrator uses its own App.
      if (actions) {
        const claudeApp = (
          await db
            .select()
            .from(onboardingRuns)
            .where(and(eq(onboardingRuns.repoId, repo.id), eq(onboardingRuns.step, "claude-app")))
            .limit(1)
        )[0];
        const confirmedBy = claudeApp?.status === "ok" ? (claudeApp.detail as { confirmedBy?: unknown }).confirmedBy : null;
        push(
          "claude-github-app",
          claudeApp?.status === "ok" ? true : null,
          claudeApp?.status === "ok"
            ? `installation confirmed${typeof confirmedBy === "string" ? ` by ${confirmedBy}` : ""} (the Console cannot see another App's installations, so this records the human check)`
            : `not confirmable from the Console — agent runs exchange an OIDC token for the Claude App's credentials, and without the App installed every run fails with "Claude Code is not installed on this repository". Install it at ${CLAUDE_APP_URL}, then confirm the wizard step`,
        );
      }

      // 5. profile.json parses and carries the schema's required keys.
      const profile = await client.getFileAtRef(owner, name, ".factory/profile.json");
      if (!profile) {
        push("profile", false, ".factory/profile.json missing — implementer/reviewer/qa are hard-blocked. Run the profile step: the Profiler drafts it from the code and opens a PR");
      } else {
        try {
          const parsed = JSON.parse(profile.content) as Record<string, unknown>;
          const required = ["repo", "stack", "branches", "commands"];
          const absent = required.filter((k) => !(k in parsed));
          // Schema-valid and useless is a real state: the required keys say
          // nothing about the fields that carry the repo's actual knowledge, and
          // a profile with no conventions and no gotchas leaves the roles
          // guessing exactly where guessing costs the most.
          const thin = (["conventions", "gotchas", "review_checklist", "qa_notes"] as const).filter((k) => {
            const v = parsed[k];
            return !Array.isArray(v) || v.length === 0;
          });
          const commands = (parsed.commands ?? {}) as Record<string, unknown>;
          const noCommands = ["test", "build", "lint"].every((k) => !commands[k]);
          const notes = [
            absent.length ? `missing required keys: ${absent.join(", ")}` : null,
            thin.length ? `empty: ${thin.join(", ")}` : null,
            noCommands ? "every command is null — no role can verify its own work here" : null,
          ].filter(Boolean);
          push(
            "profile",
            absent.length === 0,
            notes.length ? notes.join("; ") : "parses, required keys present, carries repo knowledge",
          );
        } catch (e) {
          push("profile", false, `does not parse: ${(e as Error).message}`);
        }
      }

      // 6. factory-models.json roles parse.
      const models = await client.getFileAtRef(owner, name, ".github/factory-models.json");
      if (!models) push("models", false, ".github/factory-models.json missing — every role falls back to the default model");
      else {
        try {
          const parsed = JSON.parse(models.content) as Record<string, unknown>;
          const roles = Object.keys(parsed).filter((k) => !k.startsWith("_"));
          push("models", roles.length > 0, `roles configured: ${roles.join(", ")}`);
        } catch (e) {
          push("models", false, `does not parse: ${(e as Error).message}`);
        }
      }

      // 7. factory-approvers.json users are collaborators.
      const approversFile = await client.getFileAtRef(owner, name, ".github/factory-approvers.json");
      if (!approversFile) push("approvers", false, ".github/factory-approvers.json missing — gates are unassigned");
      else {
        try {
          const parsed = parseApproverFile(JSON.parse(approversFile.content));
          const collaborators = new Set((await client.listCollaborators(owner, name)).map((c) => c.login));
          const all = [...new Set([...parsed.spec, ...parsed.design, ...parsed.implementation, ...parsed.release])];
          const strangers = all.filter((l) => !collaborators.has(l));
          push(
            "approvers",
            strangers.length === 0,
            strangers.length ? `not collaborators (silently unassignable): ${strangers.join(", ")}` : all.length ? `all approvers are collaborators` : "empty lists — any collaborator may approve",
          );
        } catch (e) {
          push("approvers", false, `does not parse: ${(e as Error).message}`);
        }
      }

      // 8. OpenSpec initialised.
      const openspec = await client.listDir(owner, name, "openspec");
      push("openspec", openspec.length > 0, openspec.length ? "openspec/ present" : "openspec/ missing — run step 4 (Install OpenSpec) and merge the PR");

      // 9. Issue template present.
      const template = await client.getFileAtRef(owner, name, ".github/ISSUE_TEMPLATE/factory-requirement.yml");
      push("issue-template", Boolean(template), template ? "present" : "missing — requesters have no entry point");

      // 10. Cross-repo PAT probe — Actions secrets are unreadable; Console-retained
      // tokens are presence-only here (the value never leaves the API).
      if (actions) {
        push("cross-repo-token", null, "not checkable from the Console (the secret value never leaves GitHub); verify via a canary run on a multi-repo epic");
      }

      const allOk = checks.every((c) => c.ok !== false);
      await recordStep(deps, repo, "validate", allOk ? "ok" : "failed", { checks });
      return { ok: allOk, checks };
    } catch (err) {
      await recordStep(deps, repo, "validate", "failed", { error: (err as Error).message });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * Reset — remove the factory footprint so setup can be run again. The
   * confirm dialog is the human act that turns the factory off: files are
   * deleted straight from the default branch, and only branch protection
   * demotes the reset to a PR a human merges. Either way the Console-side
   * setup history is cleared so the repo reads as clean, and the stale
   * `factory-console/*` working branches are pruned — a leftover
   * enable-factory branch is what makes a later stub-files run die with
   * "No commits between <default> and factory-console/enable-factory".
   */
  app.post<{ Params: { id: string } }>("/api/repos/:id/onboarding/reset", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const target = await loadAdminRepo(deps, ctx, req.params.id, reply);
    if (!target) return;
    const { repo, client, owner, name } = target;

    try {
      const headSha = await client.getBranchHeadSha(owner, name, repo.defaultBranch);
      if (!headSha) return reply.code(409).send({ error: `cannot resolve head of ${repo.defaultBranch}` });

      const files = await collectFactoryFootprint(client, owner, name, repo.defaultBranch);
      if (files.length === 0) {
        // Already clean on GitHub — the remaining footprint is Console state
        // (green step badges from the previous setup) and stale branches.
        await pruneFactoryBranches(client, owner, name);
        await clearSetupState(deps, repo);
        await recordStep(deps, repo, "reset", "ok", { mode: "clean", removed: [] });
        return { ok: true, mode: "clean", removed: [], defaultBranch: repo.defaultBranch };
      }

      const removed: string[] = [];
      let blocked: GitHubHttpError | null = null;
      for (const file of files) {
        try {
          await client.deleteFile(owner, name, file.path, {
            message: `factory: remove ${file.path}`,
            sha: file.sha,
            branch: repo.defaultBranch,
          });
          removed.push(file.path);
        } catch (e) {
          // 403/409/422 are how GitHub says "not on this branch directly" —
          // protection rules, required PRs, push restrictions. Anything else
          // (rate limit, 5xx) is a real failure and aborts the reset.
          if (e instanceof GitHubHttpError && [403, 409, 422].includes(e.status) && removed.length === 0) {
            blocked = e;
            break;
          }
          throw e;
        }
      }

      if (blocked) {
        // Fall back to the PR flow: deletions land on a working branch and a
        // human merge finishes the reset. Setup history is kept — the repo is
        // not clean until that PR merges; a second Reset after merging clears it.
        const branch = "factory-console/reset-factory";
        if (!(await client.getBranchHeadSha(owner, name, branch))) {
          await client.createBranch(owner, name, branch, headSha);
        }
        for (const file of files) {
          const onBranch = await client.getFileAtRef(owner, name, file.path, branch);
          if (!onBranch) continue;
          await client.deleteFile(owner, name, file.path, {
            message: `factory: remove ${file.path}`,
            sha: onBranch.sha,
            branch,
          });
        }
        const pr = await ensurePull(client, owner, name, branch, repo.defaultBranch, {
          title: "Remove the software factory from this repository",
          body: RESET_PR_BODY(files.map((f) => f.path)),
        });
        await recordStep(deps, repo, "reset", "pending", {
          mode: "pr",
          prNumber: pr.number,
          prUrl: pr.html_url,
          removed: files.map((f) => f.path),
          reason: blocked.message,
        });
        return { ok: true, mode: "pr", prNumber: pr.number, prUrl: pr.html_url, removed: files.map((f) => f.path) };
      }

      await pruneFactoryBranches(client, owner, name);
      await clearSetupState(deps, repo);
      await recordStep(deps, repo, "reset", "ok", { mode: "direct", removed, branch: repo.defaultBranch });
      return { ok: true, mode: "direct", removed, defaultBranch: repo.defaultBranch };
    } catch (err) {
      await recordStep(deps, repo, "reset", "failed", { error: (err as Error).message });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Kick a reconcile for an estate (adopt-existing-install entry point). */
  app.post<{ Params: { id: string } }>("/api/estates/:id/reconcile", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const estate = (
      await db.select().from(estates).where(and(eq(estates.id, req.params.id), inArray(estates.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!estate) return reply.code(404).send({ error: "organisation not found" });
    await deps.reconcileQueue.add("on-demand", { estateIds: [estate.id] }, { removeOnComplete: 100 });
    return { ok: true, queued: true };
  });
}

/* ------------------------------- helpers ------------------------------- */

async function loadAdminRepo(deps: AppDeps, ctx: RequestCtx, repoId: string, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  const auth = await deps.credentials.auth();
  if (!auth) {
    reply.code(409).send({ error: "no GitHub App registered — complete setup first" });
    return null;
  }
  const { db } = deps.dbh;
  const repo = (await db.select().from(repos).where(and(eq(repos.id, repoId), inArray(repos.orgId, ctx.orgIds))).limit(1))[0];
  if (!repo) {
    reply.code(404).send({ error: "repo not found" });
    return null;
  }
  const membership = (
    await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, repo.orgId), eq(memberships.userId, ctx.userId)))
      .limit(1)
  )[0];
  let role = membership?.role ?? null;
  if (role === "member" && (await isRepoAdminOnGitHub(deps, ctx, repo.fullName))) {
    // Console roles can lag GitHub's: the first user to sign in takes "owner"
    // and everyone after lands as auto-assigned "member" (bootstrapMemberships)
    // — including the person who administers the repo on GitHub. GitHub is the
    // authority on who may configure a repository, so promote rather than
    // refuse. Deliberately hand-assigned roles (viewer) are left alone.
    await db
      .update(memberships)
      .set({ role: "admin" })
      .where(and(eq(memberships.orgId, repo.orgId), eq(memberships.userId, ctx.userId)));
    role = "admin";
  }
  if (role !== "owner" && role !== "admin") {
    reply.code(403).send({
      error: `onboarding requires an admin or owner role — your role in this organisation is "${role ?? "none"}". Ask an owner to promote you, or sign in with the GitHub account that administers ${repo.fullName}.`,
    });
    return null;
  }
  const estate = (await db.select().from(estates).where(eq(estates.id, repo.estateId)).limit(1))[0]!;
  const org = (await db.select().from(orgs).where(eq(orgs.id, repo.orgId)).limit(1))[0]!;
  const client = new InstallationClient(deps.cfg.GITHUB_API_URL, auth, estate.installationId);
  const [owner, name] = repo.fullName.split("/") as [string, string];
  return { repo, estate, org, client, owner, name };
}

/** Whether the signed-in user's own GitHub identity administers the repo. */
async function isRepoAdminOnGitHub(deps: AppDeps, ctx: RequestCtx, fullName: string): Promise<boolean> {
  try {
    const [owner, name] = fullName.split("/") as [string, string];
    const view = await userClient(deps, ctx).getRepo(owner, name);
    return Boolean(view.permissions?.admin);
  } catch {
    return false; // no OAuth token on file, or GitHub unreachable — fall back to the stored role
  }
}

async function dispatchProfiler(
  deps: AppDeps,
  orgId: string,
  installationId: number,
  owner: string,
  repo: string,
  issue: number,
) {
  let githubToken: string | undefined;
  try {
    const auth = await deps.credentials.auth();
    if (auth) githubToken = await auth.installationToken(installationId);
  } catch {
    /* orchestrator can still mint its own JWT if it has a real App key */
  }
  const secrets = await readRetainedAgentSecrets(deps, orgId);
  return dispatchFactoryRole(deps.cfg, {
    owner,
    repo,
    role: "profiler",
    issue,
    githubToken,
    ...secrets,
  });
}

async function recordStep(
  deps: AppDeps,
  repo: { id: string; orgId: string; estateId: string },
  step: string,
  status: "pending" | "ok" | "failed",
  detail: Record<string, unknown>,
): Promise<void> {
  await deps.dbh.db
    .insert(onboardingRuns)
    .values({ orgId: repo.orgId, estateId: repo.estateId, repoId: repo.id, step, status, detail, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [onboardingRuns.repoId, onboardingRuns.step],
      set: { status, detail, updatedAt: new Date() },
    });
}

/**
 * Caller stubs must pass Anthropic secrets by name. `secrets: inherit` only
 * forwards them when caller and callee live in the same GitHub Organisation
 * or Enterprise; a SaaS factory is called from other accounts (and from
 * personal-user repos), so inherit leaves the agent job with empty credentials.
 */
const CALLER_SECRET_PASS = `    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      FACTORY_CROSS_REPO_TOKEN: \${{ secrets.FACTORY_CROSS_REPO_TOKEN }}`;

function stubPassesCallerSecrets(content: string): boolean {
  return (
    /CLAUDE_CODE_OAUTH_TOKEN:\s*\$\{\{\s*secrets\.CLAUDE_CODE_OAUTH_TOKEN\s*\}\}/.test(content) ||
    /ANTHROPIC_API_KEY:\s*\$\{\{\s*secrets\.ANTHROPIC_API_KEY\s*\}\}/.test(content)
  );
}

function stubPassesFactoryRepo(content: string): boolean {
  return /^\s*factory_repo:\s*\S+/m.test(content);
}

function stubIsCurrent(content: string): boolean {
  return stubPassesCallerSecrets(content) && stubPassesFactoryRepo(content);
}

function rewriteInheritToNamedSecrets(content: string): string {
  if (stubPassesCallerSecrets(content) || !/secrets:\s*inherit/.test(content)) return content;
  return content.replace(/^[ \t]*secrets:\s*inherit[ \t]*$/m, CALLER_SECRET_PASS);
}

function ensureFactoryRepoInput(content: string): string {
  if (stubPassesFactoryRepo(content)) return content;
  if (!/^\s*factory_ref:\s*\S+/m.test(content)) return content;
  return content.replace(/^(\s*factory_ref:\s*\S+)[ \t]*$/m, `$1\n      factory_repo: ${FACTORY_REPO}`);
}

function rewriteCallerStub(content: string): string {
  return ensureFactoryRepoInput(rewriteInheritToNamedSecrets(content));
}

async function ensurePull(
  client: InstallationClient,
  owner: string,
  name: string,
  head: string,
  base: string,
  opts: { title: string; body: string },
): Promise<{ number: number; html_url: string }> {
  try {
    return await client.createPull(owner, name, { title: opts.title, head, base, body: opts.body });
  } catch (e) {
    if (e instanceof GitHubHttpError && e.status === 422) {
      const open = (await client.listPulls(owner, name)).find((p) => p.state === "open" && p.head.ref === head);
      if (open) return { number: open.number, html_url: open.html_url };
    }
    throw e;
  }
}

/** The consuming repo's whole footprint (FACTORY.md §10), templated. */
function stubFiles(
  approvers: { spec: string[]; design: string[]; implementation: string[]; release: string[] },
  consoleEngine: string,
): Record<string, string> {
  const files: Record<string, string> = {
    ".github/workflows/factory-pipeline.yml": `name: Factory pipeline

# Caller stub. All logic lives in the factory repo; this file owns only the
# triggers and the version pin. Bump both refs together when upgrading.

on:
  issues:
    types: [opened, labeled, closed]
  issue_comment:
    types: [created]
  # Profile drift (FACTORY.md §2c): the paths a repo's stack facts go stale
  # from. A push touching one re-runs the Profiler, which opens a PR only where
  # it disagrees with .factory/profile.json. Delete this block to turn the
  # check off; add the manifests your stack actually uses.
  push:
    paths:
      - "package.json"
      - "**/package.json"
      - "pnpm-lock.yaml"
      - "package-lock.json"
      - "yarn.lock"
      - "pyproject.toml"
      - "requirements*.txt"
      - "go.mod"
      - "Cargo.toml"
      - "pom.xml"
      - "build.gradle*"
      - "Gemfile"
      - "composer.json"
      - "Makefile"
      - "Dockerfile"
      - "docker-compose*.yml"
      - ".github/workflows/**"
  workflow_dispatch:
    inputs:
      issue_number:
        description: "Issue (or PR) number to run the role against"
        required: true
      role:
        description: "Factory role to run"
        required: true
        type: choice
        options: [intake, planner, architect, dispatch, implementer, reviewer, qa, release, ops, profiler]

concurrency:
  # Push (profile drift) carries no issue number and gets its own lane.
  group: factory-\${{ github.event.issue.number || inputs.issue_number || 'profile' }}
  cancel-in-progress: false

permissions:
  contents: write
  issues: write
  pull-requests: write
  id-token: write

jobs:
  factory:
    uses: ${FACTORY_REPO}/.github/workflows/factory-pipeline.yml@${FACTORY_REF}
${CALLER_SECRET_PASS}
    with:
      role: \${{ inputs.role }}
      issue_number: \${{ inputs.issue_number }}
      factory_ref: ${FACTORY_REF}
      factory_repo: ${FACTORY_REPO}
`,
    ".github/workflows/factory-branch-guard.yml": `name: Factory branch guard

on:
  push:
    branches: [main]

permissions:
  contents: read
  issues: write

jobs:
  guard:
    uses: ${FACTORY_REPO}/.github/workflows/factory-branch-guard.yml@${FACTORY_REF}
    secrets: inherit
    with:
      factory_ref: ${FACTORY_REF}
`,
    ".github/factory-models.json": `${JSON.stringify(
      {
        _comment:
          "Model preference chain per factory stage: the workflow probes each model in order and uses the first one the repo's credential can access.",
        intake: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"],
        planner: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"],
        architect: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"],
        reviewer: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"],
        implementer: ["claude-opus-5", "claude-sonnet-5"],
        qa: ["claude-opus-5", "claude-sonnet-5"],
        profiler: ["claude-opus-5", "claude-sonnet-5"],
        release: ["claude-opus-5", "claude-sonnet-5"],
        dispatch: ["claude-haiku-4-5-20251001", "claude-sonnet-5"],
        ops: ["claude-haiku-4-5-20251001", "claude-sonnet-5"],
      },
      null,
      2,
    )}\n`,
    ".github/factory-approvers.json": `${JSON.stringify(
      {
        _comment:
          "Gate -> GitHub usernames. spec = G1; design = G2; implementation = who may start ready tasks; release = G3. Empty list = any collaborator.",
        ...approvers,
      },
      null,
      2,
    )}\n`,
    ".claude/settings.json": `${JSON.stringify(
      {
        permissions: { deny: ["mcp__github__merge_pull_request", "mcp__github__enable_pr_auto_merge"] },
        extraKnownMarketplaces: {
          "genai-jerry": { source: { source: "github", repo: FACTORY_REPO } },
        },
        enabledPlugins: { "factory@genai-jerry": true },
      },
      null,
      2,
    )}\n`,
    ".github/ISSUE_TEMPLATE/factory-requirement.yml": `name: Factory requirement
description: File a requirement for the software factory to build
labels: ["factory:intake"]
body:
  - type: textarea
    id: requirement
    attributes:
      label: What should be built?
      description: Plain language. The intake analyst turns this into a spec.
    validations:
      required: true
  - type: textarea
    id: context
    attributes:
      label: Context / constraints
      description: Anything the spec writer should know.
`,
  };
  files[".github/factory-orchestrator.json"] = `${JSON.stringify(
    {
      engine: repoEngineName(consoleEngine),
      endpoint: "",
      runners: { max_parallel: 4 },
    },
    null,
    2,
  )}\n`;
  if (!githubActionsEnabled(consoleEngine)) {
    delete files[".github/workflows/factory-pipeline.yml"];
    delete files[".github/workflows/factory-branch-guard.yml"];
  }
  return files;
}

function stubPrBody(actions: boolean): string {
  const files = actions
    ? `- \`.github/workflows/factory-pipeline.yml\` — caller stub wiring GitHub events to the factory's reusable pipeline (permissions block intact — do not remove it).
- \`.github/workflows/factory-branch-guard.yml\` — files a factory:incident issue if a commit lands on main without a PR.
- \`.github/factory-orchestrator.json\` — engine \`github-actions\` (this org's Console setting).
- \`.github/factory-models.json\` — model preference chain per role; edit and merge to retune.
- \`.github/factory-approvers.json\` — who owns each gate; pre-filled from this organisation's gate assignments.
- \`.claude/settings.json\` — merge deny-list (half of the G3 enforcement) + factory plugin registration.
- \`.github/ISSUE_TEMPLATE/factory-requirement.yml\` — the intake entry point.`
    : `- \`.github/factory-orchestrator.json\` — claims this repo for the Software Factory orchestrator (\`engine: langgraph\`). GitHub Actions is not used.
- \`.github/factory-models.json\` — model preference chain per role; edit and merge to retune.
- \`.github/factory-approvers.json\` — who owns each gate; pre-filled from this organisation's gate assignments.
- \`.claude/settings.json\` — merge deny-list (half of the G3 enforcement) + factory plugin registration.
- \`.github/ISSUE_TEMPLATE/factory-requirement.yml\` — the intake entry point.

No workflow stubs — GitHub Actions is disabled for this organisation.`;

  const firstRun = actions
    ? `**Before the first agent run:** install the [Claude GitHub App](${CLAUDE_APP_URL}) on this repository (and include it under the App's repository access). Agent runs exchange an OIDC token for that App's credentials at run time; without it every run fails with \`Claude Code is not installed on this repository\` — installing the \`@anthropic-ai/claude-code\` npm package is not the same thing.

**Merging this PR is the act that enables the factory** — workflow stubs only fire from the default branch.`
    : `**Merging this PR is the act that enables the factory** — the Software Factory orchestrator claims the repo from the default branch.`;

  return `This PR carries the consuming repo's whole factory footprint. One line per file:

${files}

Add \`.factory/profile.json\` before or after merging (see the factory handbook §2c) — it is the one file whose contents are genuinely yours.

${firstRun}

---
_Generated by [Factory Console](https://github.com/genai-jerry/software-factory-view)_
`;
}

const STUB_PATCH_PR_BODY = `The factory pipeline is a reusable workflow in another repository. Two caller-stub mistakes make agent jobs fail before they start:

- \`secrets: inherit\` does not forward \`CLAUDE_CODE_OAUTH_TOKEN\` / \`ANTHROPIC_API_KEY\` across GitHub accounts.
- Omitting \`factory_repo\` makes the pipeline clone this repository itself at the factory ref instead of the factory. Git reports \`Remote branch v1 not found in upstream origin\` (or \`could not read Username for 'https://github.com'\` on a private repo).

This PR passes secrets by name and sets \`factory_repo\` to the factory that the \`uses:\` line already pins. Merge it, then re-run the failed factory workflow.

---
_Generated by [Factory Console](https://github.com/genai-jerry/software-factory-view)_
`;

/**
 * The Console-side branches setup works on. Left behind after a reset they
 * poison the next enablement: the old branch no longer differs from the
 * default branch, so createPull 422s with "No commits between …".
 */
const FACTORY_WORK_BRANCHES = ["factory-console/enable-factory", "factory-console/fix-caller-stub", "factory-console/reset-factory"];

/** Best-effort: a branch that cannot be pruned must not fail the reset. */
async function pruneFactoryBranches(client: InstallationClient, owner: string, name: string): Promise<void> {
  for (const branch of FACTORY_WORK_BRANCHES) {
    try {
      await client.deleteBranch(owner, name, branch);
    } catch {
      // Protected or otherwise refused — setup recreates branches it needs.
    }
  }
}

/**
 * Forget the recorded setup history so the repo reads as "needs setup" again,
 * not as six green steps over files that no longer exist. The reset row itself
 * is re-recorded by the caller after this runs.
 */
async function clearSetupState(deps: AppDeps, repo: { id: string; orgId: string; estateId: string }): Promise<void> {
  await deps.dbh.db.delete(onboardingRuns).where(eq(onboardingRuns.repoId, repo.id));
  await deps.dbh.db.update(repos).set({ factoryEnabled: false, profileSha: null }).where(eq(repos.id, repo.id));
}

/** Known files the enablement PR writes, plus later factory extras. */
const FACTORY_RESET_FILES = [
  ".github/workflows/factory-pipeline.yml",
  ".github/workflows/factory-branch-guard.yml",
  ".github/workflows/factory-test.yml",
  ".github/factory-orchestrator.json",
  ".github/factory-models.json",
  ".github/factory-approvers.json",
  ".github/factory-release.json",
  ".github/factory-test-request.json",
  ".github/ISSUE_TEMPLATE/factory-requirement.yml",
  ".claude/settings.json",
  ".factory/profile.json",
];

const FACTORY_RESET_DIRS = ["openspec", ".factory", ".claude/commands/opsx"];
const FACTORY_RESET_MAX_FILES = 200;

function RESET_PR_BODY(paths: string[]): string {
  return `This PR removes the software factory from this repository so you can run setup again. Branch protection on the default branch prevented the Console from deleting these files directly, so a human merge finishes the reset.

Files to delete:

${paths.map((p) => `- \`${p}\``).join("\n")}

**Not touched:** \`CLAUDE.md\`, Actions secrets, and \`factory:*\` labels. Merge this PR, then press **Reset factory** in the Console once more — it will see the repo is clean, clear the recorded setup steps, and show you the re-enable checklist.

---
_Generated by [Factory Console](https://github.com/genai-jerry/software-factory-view)_
`;
}

async function collectFactoryFootprint(
  client: InstallationClient,
  owner: string,
  name: string,
  ref: string,
): Promise<Array<{ path: string; sha: string }>> {
  const files = new Map<string, string>();
  const add = (path: string, sha: string) => {
    if (files.size >= FACTORY_RESET_MAX_FILES && !files.has(path)) return;
    files.set(path, sha);
  };

  for (const path of FACTORY_RESET_FILES) {
    const f = await client.getFileAtRef(owner, name, path, ref);
    if (f) add(path, f.sha);
  }
  for (const dir of FACTORY_RESET_DIRS) {
    await walkFactoryDir(client, owner, name, dir, ref, add);
  }
  for (const entry of await client.listDir(owner, name, ".claude/skills", ref)) {
    if (!entry.path.toLowerCase().includes("openspec")) continue;
    if (entry.type === "dir") await walkFactoryDir(client, owner, name, entry.path, ref, add);
    else if (entry.sha) add(entry.path, entry.sha);
  }

  return [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, sha]) => ({ path, sha }));
}

async function walkFactoryDir(
  client: InstallationClient,
  owner: string,
  name: string,
  dir: string,
  ref: string,
  add: (path: string, sha: string) => void,
  depth = 0,
): Promise<void> {
  if (depth > 8) return;
  const entries = await client.listDir(owner, name, dir, ref);
  for (const entry of entries) {
    if (entry.type === "dir") await walkFactoryDir(client, owner, name, entry.path, ref, add, depth + 1);
    else if (entry.path && entry.sha) add(entry.path, entry.sha);
  }
}
