import { FACTORY_KIND_LABELS, FACTORY_LABELS, GitHubHttpError, InstallationClient } from "@console/core";
import { auditLog, estates, gateAssignments, onboardingRuns, projects, repos } from "@console/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, userClient, type AppDeps, type RequestCtx } from "../context.js";
import { stubFiles } from "./onboarding.js";
import { loadOrg } from "./settings.js";

/**
 * A repository for a new product, made from Compass (Shape → a new product →
 * Open as work → Create a repository).
 *
 * The repository is created as the signed-in person (their account, or an
 * organisation the Compass App is installed on), with a README on its
 * default branch. Compass then commits the factory's files straight onto it —
 * an empty repository has nothing to review, so there is no setup PR — cuts
 * the staging branch from it, creates the labels, and registers it in a
 * project with the factory on. The stack is not chosen here: the profile says
 * so, and the first epic's design chooses it (FACTORY.md §2c, a new
 * repository).
 */

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The profile of a repository with no code yet: valid, and honest about it. */
export function greenfieldProfile(fullName: string, description: string, stagingBranch: string | null, defaultBranch: string): string {
  return `${JSON.stringify(
    {
      repo: fullName,
      estate_role: description ? `A new product: ${description}` : "A new product, with its own repository.",
      stack:
        "Not chosen yet. This is a new repository with no code. The first epic's design chooses the stack (approved at G2); the task that scaffolds it fills in this profile.",
      branches: { default: defaultBranch, staging: stagingBranch && stagingBranch !== "staging" ? stagingBranch : null },
      commands: { test: null, build: null, lint: null },
      conventions: [],
      gotchas: [
        "New repository: there is no code yet. Do not assume a stack the approved design did not choose.",
        "The task that scaffolds the project sets stack, commands (test, build, lint — each one a command it ran) and conventions in this file, in the same PR.",
      ],
    },
    null,
    2,
  )}\n`;
}

async function accountsOf(deps: AppDeps, ctx: RequestCtx, orgId: string) {
  const rows = await deps.dbh.db.select().from(estates).where(eq(estates.orgId, orgId));
  const gh = userClient(deps, ctx);
  const [me, installs] = await Promise.all([gh.me(), gh.listMyInstallations()]);
  const byId = new Map(installs.map((i) => [i.id, i.account]));
  return rows.map((e) => {
    const account = byId.get(e.installationId);
    const isOrg = account?.type === "Organization";
    // A personal account takes repos only from its owner.
    const canCreate = Boolean(account) && (isOrg || account!.login.toLowerCase() === me.login.toLowerCase());
    return { estateId: e.id, login: account?.login ?? e.name, type: account?.type ?? "unknown", canCreate, isOrg, installationId: e.installationId };
  });
}

export function registerNewRepoRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  /** Where a new repository can go: the GitHub accounts this org's Compass App is installed on. */
  app.get<{ Params: { id: string } }>("/api/orgs/:id/repo-homes", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: false });
    if (!found) return;
    const accounts = await accountsOf(deps, ctx, found.org.id);
    return {
      canEdit: found.membership.role === "owner" || found.membership.role === "admin",
      accounts: accounts.map(({ estateId, login, type, canCreate }) => ({ estateId, login, type, canCreate })),
    };
  });

  app.post<{
    Params: { id: string };
    Body: { estateId?: string; name?: string; description?: string; private?: boolean; projectName?: string };
  }>("/api/orgs/:id/repos", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
    if (!found) return;
    const org = found.org;
    const b = req.body ?? {};
    const name = (b.name ?? "").trim();
    if (!NAME.test(name)) return reply.code(400).send({ error: "Name the repository with letters, digits, dots, dashes or underscores." });
    const description = (b.description ?? "").trim().slice(0, 300);
    const auth = await deps.credentials.auth();
    if (!auth) return reply.code(409).send({ error: "no GitHub App registered — complete setup first" });

    const accounts = await accountsOf(deps, ctx, org.id);
    const home = accounts.find((a) => a.estateId === b.estateId);
    if (!home) return reply.code(400).send({ error: "Pick where the repository goes." });
    if (!home.canCreate) {
      return reply.code(403).send({ error: `Compass can only create repositories in your own GitHub account or an organisation; ${home.login} is someone else's account.` });
    }

    // 1. The repository, as the person, with a first commit on its default branch.
    let created: Awaited<ReturnType<ReturnType<typeof userClient>["createRepo"]>>;
    try {
      created = await userClient(deps, ctx).createRepo(home.isOrg ? home.login : null, { name, description, private: b.private !== false });
    } catch (err) {
      const e = err as GitHubHttpError;
      if (e instanceof GitHubHttpError && e.status === 422) return reply.code(409).send({ error: `${home.login}/${name} already exists, or the name is not allowed.` });
      if (e instanceof GitHubHttpError && (e.status === 403 || e.status === 404)) {
        return reply.code(403).send({
          error:
            "GitHub refused to create the repository. The Compass GitHub App needs the Administration (read and write) permission: an App owner adds it in the App's settings, then you accept it on the installation. Then try again.",
        });
      }
      return reply.code(502).send({ error: `GitHub could not create the repository: ${(err as Error).message}` });
    }
    const [owner, repoName] = created.full_name.split("/") as [string, string];
    const client = new InstallationClient(deps.cfg.GITHUB_API_URL, auth, home.installationId);

    // The App sees a new repository a moment after it exists (all-repositories installs).
    let headSha: string | null = null;
    for (let i = 0; i < 8 && !headSha; i++) {
      headSha = await client.getBranchHeadSha(owner, repoName, created.default_branch).catch(() => null);
      if (!headSha) await new Promise((r) => setTimeout(r, Number(process.env.NEW_REPO_POLL_MS ?? 1500)));
    }
    const repoRow = (
      await db
        .insert(repos)
        .values({ orgId: org.id, estateId: home.estateId, ghNodeId: created.node_id, fullName: created.full_name, defaultBranch: created.default_branch })
        .onConflictDoUpdate({ target: repos.ghNodeId, set: { fullName: created.full_name, defaultBranch: created.default_branch } })
        .returning()
    )[0]!;
    if (!headSha) {
      return reply.code(202).send({
        repoId: repoRow.id,
        fullName: created.full_name,
        htmlUrl: created.html_url,
        setUp: false,
        error:
          "The repository was created, but the Compass App cannot see it yet. If the App is installed on selected repositories only, add this one on GitHub, then finish setup on Onboarding.",
      });
    }

    const steps: Record<string, unknown> = {};
    try {
      // 2. The factory's files, committed straight onto the default branch.
      const approverRows = await db.select().from(gateAssignments).where(eq(gateAssignments.estateId, home.estateId));
      const by = (gate: string) => [...new Set(approverRows.filter((a) => a.gate === gate).map((a) => a.login))];
      const me = ctx.login;
      const or = (list: string[]) => (list.length ? list : [me]);
      const approvers = {
        spec: or(by("spec")),
        design: or(by("design")),
        implementation: or(by("implementation")),
        testers: or(by("testers")),
        staging: or(by("staging")),
        release: or(by("release")),
      };
      const staging = org.stagingBranch ?? "staging";
      const files = {
        ...stubFiles(approvers, org.orchestrator, { defaultBranch: created.default_branch, stagingBranch: org.stagingBranch }),
        ".factory/profile.json": greenfieldProfile(created.full_name, description, org.stagingBranch, created.default_branch),
      };
      for (const [path, content] of Object.entries(files)) {
        await client.putFile(owner, repoName, path, { message: `factory: add ${path}`, content, branch: created.default_branch });
      }
      steps.stubs = Object.keys(files);

      // 3. Staging, cut from the default branch with the factory's files on it.
      const head = await client.getBranchHeadSha(owner, repoName, created.default_branch);
      if (head) await client.createBranch(owner, repoName, staging, head);
      steps.staging = staging;

      // 4. The labels the router reads.
      for (const label of [...FACTORY_LABELS, ...FACTORY_KIND_LABELS]) await client.createLabel(owner, repoName, label);
    } catch (err) {
      return reply.code(202).send({
        repoId: repoRow.id,
        fullName: created.full_name,
        htmlUrl: created.html_url,
        setUp: false,
        error: `The repository was created, but setting it up stopped: ${(err as Error).message}. Finish it on Onboarding.`,
      });
    }

    // 5. A project for the product, and the factory on.
    const projectName = (b.projectName ?? "").trim().slice(0, 80) || repoName;
    const project =
      (await db.select().from(projects).where(and(eq(projects.orgId, org.id), eq(projects.name, projectName))).limit(1))[0] ??
      (await db.insert(projects).values({ orgId: org.id, name: projectName }).returning())[0]!;
    await db.update(repos).set({ factoryEnabled: true, projectId: project.id }).where(eq(repos.id, repoRow.id));
    const now = new Date();
    for (const [step, detail] of [
      ["labels", { createdWithRepo: true }],
      ["stubs", { committed: steps.stubs, createdWithRepo: true }],
      ["profile", { greenfield: true, createdWithRepo: true }],
    ] as const) {
      await db
        .insert(onboardingRuns)
        .values({ orgId: org.id, estateId: home.estateId, repoId: repoRow.id, step, status: "ok", detail, updatedAt: now })
        .onConflictDoUpdate({ target: [onboardingRuns.repoId, onboardingRuns.step], set: { status: "ok", detail, updatedAt: now } });
    }
    // OpenSpec's scaffold comes from its own CLI; the worker opens that PR.
    // Merged as soon as it opens: a repository Compass just made has nothing in it to review.
    await deps.openspecQueue.add("init", { repoId: repoRow.id, autoMerge: true }, { removeOnComplete: 100, removeOnFail: 100 }).catch(() => undefined);
    await db.insert(auditLog).values({
      orgId: org.id,
      actorUserId: ctx.userId,
      action: "repo.create",
      target: created.full_name,
      payload: { private: created.private, staging: steps.staging, project: projectName },
    });
    return { repoId: repoRow.id, fullName: created.full_name, htmlUrl: created.html_url, setUp: true, projectId: project.id };
  });
}
