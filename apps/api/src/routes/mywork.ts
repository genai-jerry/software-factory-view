import { IN_PROGRESS_LABEL, gateOfState, phaseOfState, NEXT_MOVER, stateSentence } from "@console/core";
import { issues, issueStateHistory, pullRequests, repos } from "@console/db";
import { and, desc, eq, inArray, isNotNull, or, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildAttention, loadBlockedMeta } from "../attention.js";
import { requireAuth, type AppDeps } from "../context.js";
import { loadApproversForGate } from "../start-gate.js";
import { agentRoleLabel, loadDependencies, loadIssue, resolveRepoFilter, runningRoleOf, taskRollup, type RepoFilterQuery } from "./read.js";
import { fetchActiveRuns } from "../orchestrator-dispatch.js";

/**
 * The individual view (plan 07 §4): one round trip answering, in order,
 * "what is stuck on me", "where are my issues", "what am I waiting on".
 * Everything is a query over projections — assignees ∪ author is the
 * responsibility predicate, phases compress the label machine for display,
 * and the label itself stays the state.
 */

const DAY_MS = 86_400_000;

/** What a live run on an epic itself is: the stage that hands it to a role. */
const EPIC_RUNNING_ROLE: Record<string, string> = {
  "factory:intake": "Intake Analyst",
  "factory:spec-approved": "Planner",
  "factory:planned": "Architect",
  "factory:design-approved": "Dispatcher",
};

const RUNNING_CAP = 50;

export function registerMyWorkRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  /**
   * Everything the factory is working on right now: each open task or epic
   * that carries the run marker, newest first. The home page shows them as
   * small cards, so nobody has to open an epic to see an agent is busy.
   */
  app.get<{ Querystring: RepoFilterQuery }>("/api/running", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repoFilter = await resolveRepoFilter(deps, ctx, req.query);
    if (repoFilter && repoFilter.length === 0) return { running: [] };

    const allRows = await db
      .select({ issue: issues, repoFullName: repos.fullName })
      .from(issues)
      .innerJoin(repos, eq(repos.id, issues.repoId))
      .where(
        and(
          inArray(issues.orgId, ctx.orgIds),
          eq(issues.state, "open"),
          inArray(issues.kind, ["task", "epic"]),
          dsql`${issues.labels} @> ${JSON.stringify([IN_PROGRESS_LABEL])}::jsonb`,
        ),
      )
      .orderBy(desc(issues.ghUpdatedAt));

    const parentIds = [...new Set(allRows.map((r) => r.issue.parentIssueId).filter((id): id is string => Boolean(id)))];
    const parents = parentIds.length
      ? await db
          .select({ id: issues.id, number: issues.number, title: issues.title, repoId: issues.repoId })
          .from(issues)
          .where(inArray(issues.id, parentIds))
      : [];
    const parentOf = new Map(parents.map((p) => [p.id, p]));

    // The focus is on repos, but a cross-repo epic keeps its tasks in sibling
    // repos: a task belongs to its epic's repo as much as to its own, so the
    // beacon-api view still shows the beacon-connectors task an epic is
    // waiting on.
    const rows = allRows
      .filter(
        ({ issue }) =>
          !repoFilter ||
          repoFilter.includes(issue.repoId) ||
          repoFilter.includes(parentOf.get(issue.parentIssueId ?? "")?.repoId ?? ""),
      )
      .slice(0, RUNNING_CAP);
    const activeRuns = rows.length ? await fetchActiveRuns(deps.cfg) : new Map();

    return {
      running: rows.map(({ issue, repoFullName }) => {
        const isEpic = issue.kind === "epic";
        const epic = isEpic ? issue : parentOf.get(issue.parentIssueId ?? "");
        const run = activeRuns.get(`${repoFullName}#${issue.number}`);
        return {
          issueId: issue.id,
          number: issue.number,
          title: issue.title.replace(/^task\([^)]*\):?\s*/i, ""),
          repo: repoFullName,
          kind: issue.kind,
          // The orchestrator's own word for the role when it is running, else
          // the one the stage implies. `runId` is the log the card opens.
          role: agentRoleLabel(run?.role) ?? (isEpic ? (EPIC_RUNNING_ROLE[issue.factoryState ?? ""] ?? "Factory") : runningRoleOf(issue.factoryState)),
          runId: run?.id ?? null,
          epicId: isEpic ? issue.id : (issue.parentIssueId ?? issue.id),
          epicNumber: epic?.number ?? issue.number,
          epicTitle: epic?.title ?? issue.title,
        };
      }),
    };
  });

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
    // Down the fallback chain, so gate GS names the `release` list where an
    // estate's approver file has no `staging` key yet rather than reading as
    // unassigned.
    const approvers = gateInfo ? (await loadApproversForGate(deps, repo.estateId, gateInfo.gate)).approvers : [];

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

