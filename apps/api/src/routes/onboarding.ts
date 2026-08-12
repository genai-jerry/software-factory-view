import { FACTORY_LABELS, InstallationClient, parseApproverFile } from "@console/core";
import { estates, gateAssignments, memberships, onboardingRuns, repos } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps, type RequestCtx } from "../context.js";

/**
 * Onboarding (spec 03): idempotent steps that report found / created / fixed,
 * resumable state in onboarding_runs, and a validation suite that makes no
 * writes on a healthy repo. Steps run under the installation token — the app
 * may automate setup; only humans merge the PR that turns the factory on.
 */

const FACTORY_REPO = "genai-jerry/claude-software-factory";
const FACTORY_REF = "v1";

export function registerOnboardingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get<{ Params: { id: string } }>("/api/estates/:id/onboarding", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const estate = (
      await db.select().from(estates).where(and(eq(estates.id, req.params.id), inArray(estates.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!estate) return reply.code(404).send({ error: "estate not found" });
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
      // Idempotence: re-running re-verifies rather than duplicating the PR.
      const existingStub = await client.getFileAtRef(owner, name, ".github/workflows/factory-pipeline.yml");
      if (existingStub) {
        await recordStep(deps, repo, "stubs", "ok", { found: true });
        return { ok: true, found: true, message: "stub already on the repo — nothing to do" };
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

      const pr = await client.createPull(owner, name, {
        title: "Enable the software factory",
        head: branch,
        base: repo.defaultBranch,
        body: STUB_PR_BODY,
      });
      await recordStep(deps, repo, "stubs", "ok", { prNumber: pr.number, prUrl: pr.html_url });
      return { ok: true, prNumber: pr.number, prUrl: pr.html_url };
    } catch (err) {
      await recordStep(deps, repo, "stubs", "failed", { error: (err as Error).message });
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Step 6 — validation suite: green/red per check, zero writes on a healthy repo. */
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
      }
      const guard = await client.getFileAtRef(owner, name, ".github/workflows/factory-branch-guard.yml");
      push("branch-guard-stub", Boolean(guard), guard ? "present" : "missing — no factory:incident on direct main commits");

      // 3. Repository-level secret exists (presence only).
      const hasKey = (await client.getActionsSecret(owner, name, "ANTHROPIC_API_KEY")) || (await client.getActionsSecret(owner, name, "CLAUDE_CODE_OAUTH_TOKEN"));
      push("actions-secret", hasKey, hasKey ? "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN present" : "neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set as a repository secret");

      // 4. profile.json parses and carries the schema's required keys.
      const profile = await client.getFileAtRef(owner, name, ".factory/profile.json");
      if (!profile) push("profile", false, ".factory/profile.json missing — implementer/reviewer/qa are hard-blocked");
      else {
        try {
          const parsed = JSON.parse(profile.content) as Record<string, unknown>;
          const required = ["repo", "stack", "branches", "commands"];
          const absent = required.filter((k) => !(k in parsed));
          push("profile", absent.length === 0, absent.length ? `missing required keys: ${absent.join(", ")}` : "parses, required keys present");
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
    if (!estate) return reply.code(404).send({ error: "estate not found" });
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
  workflow_dispatch:
    inputs:
      issue_number:
        description: "Issue (or PR) number to run the role against"
        required: true
      role:
        description: "Factory role to run"
        required: true
        type: choice
        options: [intake, planner, architect, dispatch, implementer, reviewer, qa, release, ops]

concurrency:
  group: factory-\${{ github.event.issue.number || inputs.issue_number }}
  cancel-in-progress: false

permissions:
  contents: write
  issues: write
  pull-requests: write
  id-token: write

jobs:
  factory:
    uses: ${FACTORY_REPO}/.github/workflows/factory-pipeline.yml@${FACTORY_REF}
    secrets: inherit
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
- \`.github/factory-approvers.json\` — who owns each gate; pre-filled from this estate's gate assignments.
- \`.claude/settings.json\` — merge deny-list (half of the G3 enforcement) + factory plugin registration.
- \`.github/ISSUE_TEMPLATE/factory-requirement.yml\` — the intake entry point.

Add \`.factory/profile.json\` before or after merging (see the factory handbook §2c) — it is the one file whose contents are genuinely yours.

**Merging this PR is the act that enables the factory** — workflow stubs only fire from the default branch.

---
_Generated by [Factory Console](https://github.com/genai-jerry/software-factory-view)_
`;
