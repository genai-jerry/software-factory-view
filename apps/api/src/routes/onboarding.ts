import { FACTORY_LABELS, GitHubHttpError, InstallationClient, parseApproverFile } from "@console/core";
import { estates, gateAssignments, memberships, onboardingRuns, repos } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, userClient, type AppDeps, type RequestCtx } from "../context.js";

/**
 * Onboarding (spec 03): idempotent steps that report found / created / fixed,
 * resumable state in onboarding_runs, and a validation suite that makes no
 * writes on a healthy repo. Steps run under the installation token — the app
 * may automate setup; only humans merge the PR that turns the factory on.
 */

const FACTORY_REPO = "genai-jerry/claude-software-factory";
const FACTORY_REF = "v1";

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

export function registerOnboardingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get<{ Params: { id: string } }>("/api/estates/:id/onboarding", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const estate = (
      await db.select().from(estates).where(and(eq(estates.id, req.params.id), inArray(estates.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!estate) return reply.code(404).send({ error: "organisation not found" });
    const repoRows = await db.select().from(repos).where(eq(repos.estateId, estate.id));
    const out = [];
    for (const r of repoRows) {
      const steps = await db.select().from(onboardingRuns).where(eq(onboardingRuns.repoId, r.id));
      out.push({
        repoId: r.id,
        fullName: r.fullName,
        factoryEnabled: r.factoryEnabled,
        steps: Object.fromEntries(steps.map((s) => [s.step, { status: s.status, detail: s.detail, updatedAt: s.updatedAt }])),
      });
    }
    return { estateId: estate.id, repos: out };
  });

  /** Step 1 — labels: create the 14 factory:* labels idempotently; report drift fixed. */
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
      for (const label of FACTORY_LABELS) {
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

  /** Step 2 — secrets: write-through to GitHub; the Console never stores the value. */
  app.post<{ Params: { id: string }; Body: { name: string; value: string } }>(
    "/api/repos/:id/onboarding/secret",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const target = await loadAdminRepo(deps, ctx, req.params.id, reply);
      if (!target) return;
      const { repo, client, owner, name } = target;
      const secretName = req.body?.name;
      const value = req.body?.value;
      if (!secretName || !value) return reply.code(400).send({ error: "name and value required" });
      const allowed = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_CROSS_REPO_TOKEN"];
      if (!allowed.includes(secretName)) {
        return reply.code(400).send({ error: `secret must be one of ${allowed.join(", ")}` });
      }
      try {
        await client.putActionsSecret(owner, name, secretName, value);
        await recordStep(deps, repo, "secrets", "ok", { name: secretName, writtenAt: new Date().toISOString() });
        return { ok: true, name: secretName };
      } catch (err) {
        await recordStep(deps, repo, "secrets", "failed", { name: secretName, error: (err as Error).message });
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

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
    const { repo, client, owner, name } = target;

    try {
      // Idempotence: re-running re-verifies rather than duplicating the PR —
      // unless the stub still uses `secrets: inherit`, which does not forward
      // Anthropic credentials across GitHub accounts. That case opens a patch PR.
      const existingStub = await client.getFileAtRef(owner, name, ".github/workflows/factory-pipeline.yml");
      if (existingStub && stubPassesCallerSecrets(existingStub.content)) {
        await recordStep(deps, repo, "stubs", "ok", { found: true });
        return { ok: true, found: true, message: "stub already on the repo — nothing to do" };
      }
      if (existingStub) {
        const patched = rewriteInheritToNamedSecrets(existingStub.content);
        if (patched === existingStub.content) {
          await recordStep(deps, repo, "stubs", "ok", { found: true });
          return { ok: true, found: true, message: "stub already on the repo — nothing to do" };
        }
        const headSha = await client.getBranchHeadSha(owner, name, repo.defaultBranch);
        if (!headSha) return reply.code(409).send({ error: `cannot resolve head of ${repo.defaultBranch}` });
        const branch = "factory-console/pass-caller-secrets";
        if (!(await client.getBranchHeadSha(owner, name, branch))) {
          await client.createBranch(owner, name, branch, headSha);
        }
        const current = await client.getFileAtRef(owner, name, ".github/workflows/factory-pipeline.yml", branch);
        if (current?.content !== patched) {
          await client.putFile(owner, name, ".github/workflows/factory-pipeline.yml", {
            message: "factory: pass Anthropic secrets into the reusable pipeline",
            content: patched,
            branch,
            sha: current?.sha,
          });
        }
        const pr = await ensurePull(client, owner, name, branch, repo.defaultBranch, {
          title: "Pass Anthropic secrets into the factory pipeline",
          body: SECRETS_PATCH_PR_BODY,
        });
        await recordStep(deps, repo, "stubs", "ok", { prNumber: pr.number, prUrl: pr.html_url, patched: true });
        return { ok: true, prNumber: pr.number, prUrl: pr.html_url, patched: true };
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

      const files = stubFiles(approvers);
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
        body: STUB_PR_BODY,
      });
      await recordStep(deps, repo, "stubs", "ok", { prNumber: pr.number, prUrl: pr.html_url });
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
   * asks instead. Filing an issue labelled `factory:profile` starts the
   * Profiler role inside the repo's *own* Actions runner, where the code
   * already is; it drafts the profile, verifies the commands by running them,
   * and opens a PR for a human to merge. What comes back to the Console is a
   * PR and, once merged, one file it already fetches.
   *
   * Filed under the signed-in user's identity, not the App's: the router
   * ignores bot-authored issues on `opened`, and this is a person asking.
   */
  app.post<{ Params: { id: string } }>("/api/repos/:id/onboarding/profile", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const target = await loadAdminRepo(deps, ctx, req.params.id, reply);
    if (!target) return;
    const { repo, client, owner, name } = target;

    try {
      // Idempotence, like every other step: a profile on the default branch is
      // the finished state, so re-running verifies instead of filing again.
      const existing = await client.getFileAtRef(owner, name, ".factory/profile.json");
      if (existing) {
        await recordStep(deps, repo, "profile", "ok", { found: true });
        return { ok: true, found: true, message: "profile already on the default branch — nothing to do" };
      }

      // Preconditions, checked rather than assumed. Both failures would
      // otherwise land as a red Actions run the Console can see the conclusion
      // of but not the reason for, and the operator would be reading logs to
      // learn something answerable here.
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

      // Self-healing, the same way the pipeline creates factory:in-progress on
      // first use: a repo onboarded before the Profiler existed never re-ran
      // setup-labels.sh, and the trigger label has to exist to be applied.
      await client.createLabel(owner, name, PROFILE_LABEL);

      // The profile issue is a singleton — one per repo, reused — so the
      // drafts, the drift checks and their evidence read as one thread.
      const user = userClient(deps, ctx);
      const found = (await client.listIssuesByLabel(owner, name, PROFILE_LABEL.name))[0];
      if (found) {
        if (found.state === "closed") await user.reopenIssue(owner, name, found.number);
        // The Profiler drops the label when it finishes, so re-applying is what
        // asks for another run. Remove first for the case where a previous run
        // died before its cleanup: adding a label that is already there is a
        // no-op and emits no event, which would look like a button that does
        // nothing.
        await user.removeLabel(owner, name, found.number, PROFILE_LABEL.name);
        await user.addLabels(owner, name, found.number, [PROFILE_LABEL.name]);
        await recordStep(deps, repo, "profile", "pending", { issueNumber: found.number, issueUrl: found.html_url });
        return { ok: true, issueNumber: found.number, issueUrl: found.html_url, rerun: true };
      }

      const issue = await user.createIssue(owner, name, {
        title: PROFILE_ISSUE_TITLE,
        labels: [PROFILE_LABEL.name],
        body: PROFILE_ISSUE_BODY,
      });
      await recordStep(deps, repo, "profile", "pending", { issueNumber: issue.number, issueUrl: issue.html_url });
      return { ok: true, issueNumber: issue.number, issueUrl: issue.html_url, rerun: false };
    } catch (err) {
      await recordStep(deps, repo, "profile", "failed", { error: (err as Error).message });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Step 7 — validation suite: green/red per check, zero writes on a healthy repo. */
  app.post<{ Params: { id: string } }>("/api/repos/:id/onboarding/validate", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const target = await loadAdminRepo(deps, ctx, req.params.id, reply);
    if (!target) return;
    const { repo, client, owner, name } = target;

    const checks: Array<{ check: string; ok: boolean | null; detail: string }> = [];
    const push = (check: string, ok: boolean | null, detail: string) => checks.push({ check, ok, detail });

    try {
      // 1. Labels present and exact.
      const labels = await client.listLabels(owner, name);
      const byName = new Map(labels.map((l) => [l.name, l]));
      const missing = FACTORY_LABELS.filter((l) => !byName.has(l.name)).map((l) => l.name);
      const drifted = FACTORY_LABELS.filter((l) => {
        const have = byName.get(l.name);
        return have && (have.color.toLowerCase() !== l.color.toLowerCase() || have.description !== l.description);
      }).map((l) => l.name);
      push(
        "labels",
        missing.length === 0 && drifted.length === 0,
        missing.length ? `missing: ${missing.join(", ")}` : drifted.length ? `drifted: ${drifted.join(", ")}` : "all 14 present and exact",
      );

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
      }
      const guard = await client.getFileAtRef(owner, name, ".github/workflows/factory-branch-guard.yml");
      push("branch-guard-stub", Boolean(guard), guard ? "present" : "missing — no factory:incident on direct main commits");

      // 3. Repository-level secret exists (presence only).
      const hasKey = (await client.getActionsSecret(owner, name, "ANTHROPIC_API_KEY")) || (await client.getActionsSecret(owner, name, "CLAUDE_CODE_OAUTH_TOKEN"));
      push("actions-secret", hasKey, hasKey ? "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN present" : "neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set as a repository secret");

      // 4. profile.json parses and carries the schema's required keys.
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

      // 5. factory-models.json roles parse.
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

      // 6. factory-approvers.json users are collaborators.
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

      // 7. OpenSpec initialised.
      const openspec = await client.listDir(owner, name, "openspec");
      push("openspec", openspec.length > 0, openspec.length ? "openspec/ present" : "openspec/ missing — run step 3 (Install OpenSpec) and merge the PR");

      // 8. Issue template present.
      const template = await client.getFileAtRef(owner, name, ".github/ISSUE_TEMPLATE/factory-requirement.yml");
      push("issue-template", Boolean(template), template ? "present" : "missing — requesters have no entry point");

      // 9. Cross-repo PAT probe — needs the repo-side secret value, which the Console never holds.
      push("cross-repo-token", null, "not checkable from the Console (the secret value never leaves GitHub); verify via a canary run on a multi-repo epic");

      const allOk = checks.every((c) => c.ok !== false);
      await recordStep(deps, repo, "validate", allOk ? "ok" : "failed", { checks });
      return { ok: allOk, checks };
    } catch (err) {
      await recordStep(deps, repo, "validate", "failed", { error: (err as Error).message });
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
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    reply.code(403).send({ error: "onboarding requires an admin or owner role" });
    return null;
  }
  const estate = (await db.select().from(estates).where(eq(estates.id, repo.estateId)).limit(1))[0]!;
  const client = new InstallationClient(deps.cfg.GITHUB_API_URL, auth, estate.installationId);
  const [owner, name] = repo.fullName.split("/") as [string, string];
  return { repo, estate, client, owner, name };
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

function rewriteInheritToNamedSecrets(content: string): string {
  if (stubPassesCallerSecrets(content) || !/secrets:\s*inherit/.test(content)) return content;
  return content.replace(/^[ \t]*secrets:\s*inherit[ \t]*$/m, CALLER_SECRET_PASS);
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
function stubFiles(approvers: { spec: string[]; design: string[]; implementation: string[]; release: string[] }): Record<string, string> {
  return {
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
}

const STUB_PR_BODY = `This PR carries the consuming repo's whole factory footprint. One line per file:

- \`.github/workflows/factory-pipeline.yml\` — caller stub wiring GitHub events to the factory's reusable pipeline (permissions block intact — do not remove it).
- \`.github/workflows/factory-branch-guard.yml\` — files a factory:incident issue if a commit lands on main without a PR.
- \`.github/factory-models.json\` — model preference chain per role; edit and merge to retune.
- \`.github/factory-approvers.json\` — who owns each gate; pre-filled from this organisation's gate assignments.
- \`.claude/settings.json\` — merge deny-list (half of the G3 enforcement) + factory plugin registration.
- \`.github/ISSUE_TEMPLATE/factory-requirement.yml\` — the intake entry point.

Add \`.factory/profile.json\` before or after merging (see the factory handbook §2c) — it is the one file whose contents are genuinely yours.

**Merging this PR is the act that enables the factory** — workflow stubs only fire from the default branch.

---
_Generated by [Factory Console](https://github.com/genai-jerry/software-factory-view)_
`;

const SECRETS_PATCH_PR_BODY = `The factory pipeline is a reusable workflow in another repository. GitHub only forwards \`secrets: inherit\` inside the same Organisation or Enterprise, so this repository's \`CLAUDE_CODE_OAUTH_TOKEN\` / \`ANTHROPIC_API_KEY\` never reached the agent job — it failed at **Require Anthropic credentials** even when the secret was set.

This PR passes those secrets by name. Merge it, then re-run the failed factory workflow.

---
_Generated by [Factory Console](https://github.com/genai-jerry/software-factory-view)_
`;
