import { GitHubHttpError, type GhIssue } from "@console/core";
import { auditLog, issueStateHistory, issues, projects, repos } from "@console/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { alias } from "drizzle-orm/pg-core";
import { lineFor } from "../activity.js";
import { requireAuth, userClient, type AppDeps, type RequestCtx } from "../context.js";
import { githubMessage } from "../gh-write.js";
import { SignInRequiredError } from "../user-token.js";
import { resolveRepoFilter, type RepoFilterQuery } from "./read.js";

/**
 * Activity (redesign board 3b) and Add work (board 3).
 *
 * Activity is a read over the state moves the projection records, written
 * as one line each. Add work opens the GitHub issue as the acting user with
 * `factory:intake`, which is what starts the Intake Analyst; `factory:expedite`
 * goes on with it when the person chose the fast lane. The issue reaches the
 * Work list through the webhook like any other.
 */
export function registerActivityRoutes(app: FastifyInstance, deps: AppDeps): void {
  const db = deps.dbh.db;

  app.get<{ Querystring: RepoFilterQuery & { limit?: string } }>("/api/activity", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repoFilter = await resolveRepoFilter(deps, ctx, req.query);
    if (repoFilter && repoFilter.length === 0) return { lines: [] };
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);

    const parent = alias(issues, "parent");
    const rows = await db
      .select({
        at: issueStateHistory.occurredAt,
        fromState: issueStateHistory.fromState,
        toState: issueStateHistory.toState,
        actor: issueStateHistory.actor,
        issueId: issues.id,
        kind: issues.kind,
        number: issues.number,
        title: issues.title,
        parentId: issues.parentIssueId,
        epicTitle: parent.title,
        epicNumber: parent.number,
        repo: repos.fullName,
      })
      .from(issueStateHistory)
      .innerJoin(issues, eq(issues.id, issueStateHistory.issueId))
      .innerJoin(repos, eq(repos.id, issues.repoId))
      .leftJoin(parent, eq(parent.id, issues.parentIssueId))
      .where(and(inArray(issueStateHistory.orgId, ctx.orgIds), ...(repoFilter ? [inArray(issues.repoId, repoFilter)] : [])))
      .orderBy(desc(issueStateHistory.occurredAt))
      .limit(limit * 2);

    const lines = [];
    for (const r of rows) {
      const line = lineFor({
        toState: r.toState,
        fromState: r.fromState,
        actor: r.actor,
        kind: r.kind,
        number: r.number,
        title: r.title,
        epicTitle: r.epicTitle,
        epicNumber: r.epicNumber,
      });
      if (!line) continue;
      // Two label moves can say the same thing about the same issue minutes
      // apart (in-test → on-epic, then ready-to-ship → on-epic). One line.
      const prev = lines[lines.length - 1];
      if (prev && prev.text === line.text && prev.issueId === r.issueId) continue;
      lines.push({
        issueId: r.issueId,
        at: r.at,
        who: line.who,
        person: line.person,
        text: line.text,
        stage: line.stage,
        repo: r.repo,
        epicId: r.parentId ?? r.issueId,
      });
      if (lines.length >= limit) break;
    }
    return { lines };
  });

  app.post<{ Body: { repoId: string; title: string; body?: string; fast?: boolean } }>("/api/work", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const title = req.body?.title?.trim();
    if (!title) return reply.code(400).send({ error: "say what you want done" });
    const repo = (await db.select().from(repos).where(and(eq(repos.id, req.body.repoId ?? ""), inArray(repos.orgId, ctx.orgIds))).limit(1))[0];
    if (!repo) return reply.code(404).send({ error: "repository not found" });
    const issue = await openWorkIssue(deps, ctx, reply, repo, { title, body: (req.body.body ?? "").trim(), fast: Boolean(req.body.fast) });
    if (!issue) return;
    return { ok: true, number: issue.number, htmlUrl: issue.html_url, repo: repo.fullName };
  });

  /** The project a repo belongs to, for the Add work form's default. */
  app.get("/api/work/targets", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const rows = await db
      .select({ id: repos.id, fullName: repos.fullName, projectId: repos.projectId, projectName: projects.name, factoryEnabled: repos.factoryEnabled })
      .from(repos)
      .leftJoin(projects, eq(projects.id, repos.projectId))
      .where(inArray(repos.orgId, ctx.orgIds))
      .orderBy(repos.fullName);
    return { targets: rows };
  });
}

/**
 * Open a requirement issue as the acting user, with `factory:intake` (and
 * `factory:expedite` on the fast lane), and record it. Shared by Add work and
 * Shape's "Open as work": one path into the factory, one error wording. On a
 * failure the reply is already sent and null comes back.
 */
export async function openWorkIssue(
  deps: AppDeps,
  ctx: RequestCtx,
  reply: FastifyReply,
  repo: { id: string; orgId: string; fullName: string },
  opts: { title: string; body: string; fast: boolean },
): Promise<GhIssue | null> {
  const [owner, name] = repo.fullName.split("/") as [string, string];
  const labels = ["factory:intake", ...(opts.fast ? ["factory:expedite"] : [])];
  const gh = userClient(deps, ctx);
  try {
    const issue = await gh.createIssue(owner, name, { title: opts.title, body: opts.body, labels });
    await deps.dbh.db.insert(auditLog).values({
      orgId: repo.orgId,
      actorUserId: ctx.userId,
      action: "work.add",
      target: `${repo.fullName}#${issue.number}`,
      payload: { htmlUrl: issue.html_url, fast: opts.fast },
    });
    return issue;
  } catch (err) {
    if (err instanceof SignInRequiredError) {
      void reply.code(401).send({ error: err.message, reauth: true });
      return null;
    }
    if (err instanceof GitHubHttpError) {
      const detail = githubMessage(err);
      if (err.status === 401) void reply.code(401).send({ error: `GitHub rejected your sign-in (${detail}) — sign in again`, reauth: true });
      else if (err.status === 403 || err.status === 404)
        void reply.code(403).send({ error: `GitHub declined to open an issue in ${repo.fullName}: ${detail}. Opening one needs write access to the repository.` });
      else void reply.code(502).send({ error: `GitHub declined to open the issue: ${detail}` });
      return null;
    }
    void reply.code(502).send({ error: `could not reach GitHub to open the issue: ${(err as Error).message}` });
    return null;
  }
}
