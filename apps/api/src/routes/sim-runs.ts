import { GitHubHttpError, parseSimulate, TESTING_POLICY_PATH, type UserClient } from "@console/core";
import { repos } from "@console/db";
import { and, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, userClient, type AppDeps, type RequestCtx } from "../context.js";
import { githubMessage } from "../gh-write.js";
import { SignInRequiredError } from "../user-token.js";
import { resolveRepoFilter, type RepoFilterQuery } from "./read.js";

/**
 * Simulated runs: the scenario runs a repo's `.github/factory-testing.json`
 * `simulate` block points at (`run_repo`, `status_context`).
 *
 * Whether a deploy to staging starts a run is the run repo's Actions
 * variable `SIM_SCENARIOS`: `manual` means by hand (deploys only queue their
 * commit until someone runs the workflow), anything else — or no variable —
 * means automatic. One variable covers every repo that deploys to that sim,
 * so the switch belongs to the run repo, not to any one service.
 *
 * Every GitHub call here is the acting user's: turning a shared test run off
 * is a decision with an author, the same as a label or a comment.
 */

export const SIM_VARIABLE = "SIM_SCENARIOS";
export const SIM_WORKFLOW = "sim-scenarios.yml";

export type SimMode = "automatic" | "manual";

export interface SimRun {
  /** The repo whose `simulate` block this is (owner/name). */
  repo: string;
  runRepo: string;
  statusContext: string | null;
  /** Null when the variable could not be read; `reason` then says why. */
  mode: SimMode | null;
  reason: string | null;
  /** The status `statusContext` left on this repo's staging head, if any. */
  latest: { state: string; description: string | null; url: string | null; sha: string } | null;
}

const split = (full: string) => {
  const i = full.indexOf("/");
  return [full.slice(0, i), full.slice(i + 1)] as const;
};

interface SimRepo {
  fullName: string;
  stagingBranch: string;
  runRepo: string;
  statusContext: string | null;
}

/**
 * The repos (of this user's orgs, and of `filter` when given) whose testing
 * file has a `simulate` block. A repo whose file says system tests are off is
 * skipped without a read; one GitHub will not show is skipped quietly.
 */
async function simRepos(deps: AppDeps, ctx: RequestCtx, gh: UserClient, filter: string[] | null): Promise<SimRepo[]> {
  const where = filter
    ? and(inArray(repos.orgId, ctx.orgIds), inArray(repos.id, filter))
    : inArray(repos.orgId, ctx.orgIds);
  const rows = await deps.dbh.db
    .select({ fullName: repos.fullName, stagingBranch: repos.stagingBranch, systemTests: repos.systemTests })
    .from(repos)
    .where(where);
  const found = await Promise.all(
    rows
      .filter((r) => r.systemTests !== false)
      .map(async (r): Promise<SimRepo | null> => {
        const [owner, name] = split(r.fullName);
        try {
          const file = await gh.getFileAtRef(owner, name, TESTING_POLICY_PATH);
          if (!file) return null;
          const sim = parseSimulate(JSON.parse(file.content));
          return sim && { fullName: r.fullName, stagingBranch: r.stagingBranch ?? "staging", ...sim };
        } catch (err) {
          if (err instanceof SignInRequiredError) throw err;
          return null; // unreadable or unparseable: no sim to show for it
        }
      }),
  );
  return found.filter((s): s is SimRepo => s !== null).sort((a, b) => a.fullName.localeCompare(b.fullName));
}

const NEEDS = (runRepo: string) =>
  `This needs the Console's GitHub App granted Variables: write and Actions: write on ${runRepo}, and your own write access to ${runRepo}.`;

/** The run repo's mode, or why it could not be read. */
async function readMode(gh: UserClient, runRepo: string): Promise<{ mode: SimMode | null; reason: string | null }> {
  const [owner, name] = split(runRepo);
  try {
    const value = await gh.getActionsVariable(owner, name, SIM_VARIABLE);
    if (value === null) {
      // A missing variable and a repo GitHub will not show both answer 404:
      // only call it automatic when the repo itself is visible.
      await gh.getRepo(owner, name);
      return { mode: "automatic", reason: null };
    }
    return { mode: value.trim().toLowerCase() === "manual" ? "manual" : "automatic", reason: null };
  } catch (err) {
    if (err instanceof SignInRequiredError) return { mode: null, reason: err.message };
    const detail = err instanceof GitHubHttpError ? githubMessage(err) : (err as Error).message;
    return { mode: null, reason: `GitHub would not show the ${SIM_VARIABLE} variable on ${runRepo} (${detail}). ${NEEDS(runRepo)}` };
  }
}

/** Turn a refused write into GitHub's own answer, as gh-write.ts does for comments and labels. */
function refuse(reply: FastifyReply, err: unknown, what: string, runRepo: string) {
  if (err instanceof SignInRequiredError) return reply.code(401).send({ error: err.message, reauth: true });
  if (err instanceof GitHubHttpError) {
    const detail = githubMessage(err);
    if (err.status === 401) {
      return reply.code(401).send({ error: `GitHub rejected your sign-in (${detail}) — sign in again`, reauth: true });
    }
    if (err.status === 403 || err.status === 404) {
      return reply.code(403).send({ error: `GitHub declined to ${what} on ${runRepo}: ${detail}. ${NEEDS(runRepo)}` });
    }
    return reply.code(502).send({ error: `GitHub declined to ${what} on ${runRepo}: ${detail}` });
  }
  return reply.code(502).send({ error: `could not reach GitHub to ${what} on ${runRepo}: ${(err as Error).message}` });
}

export function registerSimRunRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Querystring: RepoFilterQuery }>("/api/sim-runs", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const filter = await resolveRepoFilter(deps, ctx, req.query);
    if (filter && filter.length === 0) return { sims: [] };
    const gh = userClient(deps, ctx);
    let found: SimRepo[];
    try {
      found = await simRepos(deps, ctx, gh, filter);
    } catch (err) {
      return refuse(reply, err, "read the testing settings", "your repositories");
    }
    const modes = new Map<string, Promise<{ mode: SimMode | null; reason: string | null }>>();
    const sims: SimRun[] = await Promise.all(
      found.map(async (s) => {
        if (!modes.has(s.runRepo)) modes.set(s.runRepo, readMode(gh, s.runRepo));
        const [owner, name] = split(s.fullName);
        const status = s.statusContext
          ? await gh.getCommitStatus(owner, name, s.stagingBranch, s.statusContext).catch(() => null)
          : null;
        return {
          repo: s.fullName,
          runRepo: s.runRepo,
          statusContext: s.statusContext,
          ...(await modes.get(s.runRepo)!),
          latest: status && { state: status.state, description: status.description, url: status.target_url, sha: status.sha },
        };
      }),
    );
    return { sims };
  });

  /** Only a run repo some repo of this user's orgs names may be switched or run. */
  const allowed = async (ctx: RequestCtx, gh: UserClient, runRepo: unknown): Promise<string | null> => {
    if (typeof runRepo !== "string" || !runRepo.includes("/")) return null;
    const found = await simRepos(deps, ctx, gh, null);
    return found.some((s) => s.runRepo === runRepo) ? runRepo : null;
  };

  app.post<{ Body: { runRepo?: string; mode?: string } }>("/api/sim-runs/mode", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const mode = req.body?.mode;
    if (mode !== "automatic" && mode !== "manual") return reply.code(400).send({ error: "mode must be automatic or manual" });
    const gh = userClient(deps, ctx);
    let runRepo: string | null;
    try {
      runRepo = await allowed(ctx, gh, req.body?.runRepo);
    } catch (err) {
      return refuse(reply, err, "read the testing settings", "your repositories");
    }
    if (!runRepo) return reply.code(404).send({ error: "no repository of yours runs its simulated tests there" });
    const [owner, name] = split(runRepo);
    try {
      if (mode === "manual") await gh.setActionsVariable(owner, name, SIM_VARIABLE, "manual");
      else await gh.deleteActionsVariable(owner, name, SIM_VARIABLE);
    } catch (err) {
      return refuse(reply, err, mode === "manual" ? `set ${SIM_VARIABLE}` : `remove ${SIM_VARIABLE}`, runRepo);
    }
    return { runRepo, mode };
  });

  app.post<{ Body: { runRepo?: string } }>("/api/sim-runs/run", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const gh = userClient(deps, ctx);
    let runRepo: string | null;
    try {
      runRepo = await allowed(ctx, gh, req.body?.runRepo);
    } catch (err) {
      return refuse(reply, err, "read the testing settings", "your repositories");
    }
    if (!runRepo) return reply.code(404).send({ error: "no repository of yours runs its simulated tests there" });
    const [owner, name] = split(runRepo);
    try {
      const { default_branch } = await gh.getRepo(owner, name);
      await gh.dispatchWorkflow(owner, name, SIM_WORKFLOW, default_branch, {});
    } catch (err) {
      return refuse(reply, err, "start the simulated run", runRepo);
    }
    return { runRepo, started: true };
  });
}
