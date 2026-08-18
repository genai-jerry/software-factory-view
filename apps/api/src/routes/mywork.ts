import { gateOfState, phaseOfState, NEXT_MOVER, stateSentence } from "@console/core";
import { gateAssignments, issues, issueStateHistory, pullRequests, repos } from "@console/db";
import { and, desc, eq, inArray, isNotNull, or, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildAttention, loadBlockedMeta } from "../attention.js";
import { requireAuth, type AppDeps } from "../context.js";
import { loadDependencies, loadIssue, resolveRepoFilter, taskRollup, type RepoFilterQuery } from "./read.js";

/**
 * The individual view (plan 07 §4): one round trip answering, in order,
 * "what is stuck on me", "where are my issues", "what am I waiting on".
 * Everything is a query over projections — assignees ∪ author is the
 * responsibility predicate, phases compress the label machine for display,
 * and the label itself stays the state.
 */

const DAY_MS = 86_400_000;

export function registerMyWorkRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get<{ Querystring: RepoFilterQuery }>("/api/my-work", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repoFilter = await resolveRepoFilter(deps, ctx, req.query);
    if (repoFilter && repoFilter.length === 0) return { needsYou: [], mine: [], waitingOn: [] };

    const needsYou = await buildAttention(deps, ctx, repoFilter ?? undefined);

    // §4.2 Yours, in flight — everything open you are assignee or author of.
    const mineRows = await db
      .select({ issue: issues, repoFullName: repos.fullName })
      .from(issues)
      .innerJoin(repos, eq(repos.id, issues.repoId))
      .where(
        and(
          inArray(issues.orgId, ctx.orgIds),
          eq(issues.state, "open"),
          isNotNull(issues.factoryState),
          or(dsql`${issues.assignees} @> ${JSON.stringify([ctx.login])}::jsonb`, eq(issues.author, ctx.login)),
          ...(repoFilter ? [inArray(issues.repoId, repoFilter)] : []),
        ),
      );

    // Freshness = the last state transition, not ghUpdatedAt (comments reset that).
    const mineIds = mineRows.map((r) => r.issue.id);
    const lastMoved = new Map<string, Date>();
    if (mineIds.length > 0) {
      const history = await db
        .select({ issueId: issueStateHistory.issueId, at: issueStateHistory.occurredAt })
        .from(issueStateHistory)
        .where(inArray(issueStateHistory.issueId, mineIds))
        .orderBy(desc(issueStateHistory.occurredAt));
      for (const h of history) if (!lastMoved.has(h.issueId)) lastMoved.set(h.issueId, h.at);
    }

    const now = Date.now();
    const mine = [];
    for (const r of mineRows) {
      const i = r.issue;
      const movedAt = lastMoved.get(i.id) ?? i.ghCreatedAt ?? i.ghUpdatedAt;
      mine.push({
        issueId: i.id,
        epicId: i.parentIssueId ?? i.id,
        number: i.number,
        title: i.title,
        repo: r.repoFullName,
        kind: i.kind,
        state: i.factoryState,
        phase: phaseOfState(i.factoryState),
        whyMine: i.assignees.includes(ctx.login) ? ("assigned" as const) : ("author" as const),
        freshness: { lastMovedAt: movedAt, quietDays: Math.floor((now - movedAt.getTime()) / DAY_MS) },
        blocked: i.factoryState === "factory:blocked",
        rollup: i.kind === "epic" ? await taskRollup(deps, i.id) : undefined,
      });
    }
    const phaseOrder = { held: 0, specifying: 1, planning: 2, building: 3, shipping: 4 };
    mine.sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase] || b.freshness.quietDays - a.freshness.quietDays);

    // §4.3 Waiting on others — my issues (and tasks under my epics) with open blockers.
    const myEpicIds = mineRows.filter((r) => r.issue.kind === "epic").map((r) => r.issue.id);
    const candidates = new Map(mineRows.map((r) => [r.issue.id, { issue: r.issue, repo: r.repoFullName }]));
    if (myEpicIds.length > 0) {
      const epicTasks = await db
        .select({ issue: issues, repoFullName: repos.fullName })
        .from(issues)
        .innerJoin(repos, eq(repos.id, issues.repoId))
        .where(
          and(
            inArray(issues.parentIssueId, myEpicIds),
            eq(issues.state, "open"),
            ...(repoFilter ? [inArray(issues.repoId, repoFilter)] : []),
          ),
        );
      for (const r of epicTasks) if (!candidates.has(r.issue.id)) candidates.set(r.issue.id, { issue: r.issue, repo: r.repoFullName });
    }
    const depMap = await loadDependencies(deps, [...candidates.keys()]);
    // Blockers are usually other people's issues — fetch their full rows
    // (org-scoped) so the row can say who to chase and how long it has sat.
    const blockerIds = [...new Set([...depMap.values()].flatMap((d) => d.blockedBy.map((b) => b.id)))];
    const blockerRows = blockerIds.length
      ? await db
          .select({ issue: issues })
          .from(issues)
          .where(and(inArray(issues.id, blockerIds), inArray(issues.orgId, ctx.orgIds)))
      : [];
    const blockerById = new Map(blockerRows.map((r) => [r.issue.id, r.issue]));
    const waitingOn = [];
    for (const [id, c] of candidates) {
      for (const blocker of depMap.get(id)?.blockedBy ?? []) {
        if (!blocker.open) continue;
        const full = blockerById.get(blocker.id);
        waitingOn.push({
          issueId: id,
          number: c.issue.number,
          title: c.issue.title,
          repo: c.repo,
          epicId: c.issue.parentIssueId ?? c.issue.id,
          blocker: {
            issueId: blocker.id,
            number: blocker.number,
            title: blocker.title,
            state: blocker.state,
            phase: phaseOfState(blocker.state),
            htmlUrl: blocker.htmlUrl,
            assignees: full?.assignees ?? [],
            ageDays: full ? Math.floor((now - full.ghUpdatedAt.getTime()) / DAY_MS) : null,
          },
        });
      }
    }
    waitingOn.sort((a, b) => (b.blocker.ageDays ?? 0) - (a.blocker.ageDays ?? 0));

    return { needsYou, mine, waitingOn };
  });

  /** The peek panel (plan 07 §4.4): row → peek → workspace, level two. */
  app.get<{ Params: { id: string } }>("/api/issues/:id/peek", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadIssue(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "issue not found" });
    const { issue, repo } = found;

    const gateInfo = gateOfState(issue.factoryState);
    let approvers: string[] = [];
    if (gateInfo) {
      const rows = await db
        .select({ login: gateAssignments.login })
        .from(gateAssignments)
        .where(and(eq(gateAssignments.estateId, repo.estateId), eq(gateAssignments.gate, gateInfo.gate)));
      approvers = [...new Set(rows.map((r) => r.login))];
    }

    const depMap = await loadDependencies(deps, [issue.id]);
    const lastEventRow = (
      await db
        .select()
        .from(issueStateHistory)
        .where(eq(issueStateHistory.issueId, issue.id))
        .orderBy(desc(issueStateHistory.occurredAt))
        .limit(1)
    )[0];

    let blocked: { since: Date | null; question: string | null } | null = null;
    if (issue.factoryState === "factory:blocked") {
      const meta = (await loadBlockedMeta(deps, [issue.id])).get(issue.id);
      blocked = { since: meta?.since ?? null, question: meta?.question ?? null };
    }

    // Open PRs tied to this issue by the factory's branch naming — for a
    // fast-track issue this is the deliverable a human still has to merge.
    const prRows = await db
      .select({
        number: pullRequests.number,
        title: pullRequests.title,
        kind: pullRequests.kind,
        draft: pullRequests.draft,
        ciStatus: pullRequests.ciStatus,
        htmlUrl: pullRequests.htmlUrl,
      })
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.issueNumber, issue.number), eq(pullRequests.state, "open")));

    return {
      issue: {
        id: issue.id,
        number: issue.number,
        title: issue.title,
        repo: repo.fullName,
        kind: issue.kind,
        state: issue.factoryState,
        phase: phaseOfState(issue.factoryState),
        open: issue.state === "open",
        htmlUrl: issue.htmlUrl,
        assignees: issue.assignees,
        author: issue.author,
      },
      sentence: stateSentence(issue.factoryState, approvers),
      nextMover: issue.factoryState ? (NEXT_MOVER[issue.factoryState] ?? null) : null,
      gate: gateInfo ? { ...gateInfo, approvers } : null,
      deps: depMap.get(issue.id) ?? { blockedBy: [], blocks: [] },
      lastEvent: lastEventRow
        ? {
            at: lastEventRow.occurredAt,
            detail: lastEventRow.toState ? `→ ${lastEventRow.toState}` : `− ${lastEventRow.fromState}`,
            actor: lastEventRow.actor,
          }
        : null,
      blocked,
      prs: prRows,
      epicId: issue.parentIssueId ?? issue.id,
    };
  });
}

