import { GATE_STATES, phaseOfState } from "@console/core";
import { estates, gateAssignments, issues, issueStateHistory, repos, taskDependencies } from "@console/db";
import { desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps } from "../context.js";

/**
 * The manager / scrum-master lens (plan 07 §7): the whole estate as a
 * collapsible tree, milestone → epic → task, every node rolling up its
 * children — the shape the factory itself has (release trackers over epics
 * over task sub-issues). Built from four batched queries; explicitly not the
 * board's per-epic N+1. Issues outside any milestone collapse under a final
 * "No release" node so the tree is total.
 */

const DAY_MS = 86_400_000;
const NO_RELEASE = "No release";

export function registerFlowRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get("/api/flow", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const now = Date.now();

    const estateRows = await db.select().from(estates).where(inArray(estates.orgId, ctx.orgIds));
    const estateIds = estateRows.map((e) => e.id);
    if (estateIds.length === 0) return { estates: [] };

    // Query 1: every issue in scope, with its repo. Closed tasks stay (they
    // are the "done" half of rollups); closed epics drop out of the tree.
    const issueRows = await db
      .select({ issue: issues, repoFullName: repos.fullName, estateId: repos.estateId })
      .from(issues)
      .innerJoin(repos, eq(repos.id, issues.repoId))
      .where(inArray(issues.orgId, ctx.orgIds));

    // Query 2: newest state transition per issue (freshness / days-in-state).
    const historyRows = await db
      .select({ issueId: issueStateHistory.issueId, at: issueStateHistory.occurredAt })
      .from(issueStateHistory)
      .where(inArray(issueStateHistory.issueId, issueRows.map((r) => r.issue.id)))
      .orderBy(desc(issueStateHistory.occurredAt));
    const lastMoved = new Map<string, Date>();
    for (const h of historyRows) if (!lastMoved.has(h.issueId)) lastMoved.set(h.issueId, h.at);

    // Query 3: dependency edges among these issues, for per-task blockedBy.
    const depRows = await db
      .select({ blocked: taskDependencies.blockedIssueId, blocker: taskDependencies.blockerIssueId })
      .from(taskDependencies)
      .where(inArray(taskDependencies.orgId, ctx.orgIds));
    const numberById = new Map(issueRows.map((r) => [r.issue.id, r.issue.number]));
    const openById = new Map(issueRows.map((r) => [r.issue.id, r.issue.state === "open"]));
    const blockedByOf = new Map<string, number[]>();
    const openBlockerOf = new Set<string>(); // issues with ≥1 open blocker
    for (const d of depRows) {
      const n = numberById.get(d.blocker);
      if (n === undefined) continue;
      if (!blockedByOf.has(d.blocked)) blockedByOf.set(d.blocked, []);
      blockedByOf.get(d.blocked)!.push(n);
      if (openById.get(d.blocker)) openBlockerOf.add(d.blocked);
    }

    // Query 4: gate approvers, keyed per estate+gate.
    const assignmentRows = await db.select().from(gateAssignments).where(inArray(gateAssignments.estateId, estateIds));
    const approversOf = new Map<string, string[]>();
    for (const a of assignmentRows) {
      const key = `${a.estateId}:${a.gate}`;
      if (!approversOf.has(key)) approversOf.set(key, []);
      if (!approversOf.get(key)!.includes(a.login)) approversOf.get(key)!.push(a.login);
    }

    const daysInState = (issueId: string, fallback: Date | null): number => {
      const at = lastMoved.get(issueId) ?? fallback;
      return at ? Math.floor((now - at.getTime()) / DAY_MS) : 0;
    };

    const out = [];
    for (const estate of estateRows) {
      const mine = issueRows.filter((r) => r.estateId === estate.id);
      const epics = mine.filter((r) => r.issue.kind === "epic" && r.issue.state === "open");
      const trackers = mine.filter((r) => r.issue.labels.includes("factory:release"));

      const milestones = new Map<string, { trackerState: string | null; epics: unknown[] }>();
      const milestone = (title: string) => {
        if (!milestones.has(title)) milestones.set(title, { trackerState: null, epics: [] });
        return milestones.get(title)!;
      };
      for (const t of trackers) {
        if (t.issue.milestoneTitle) milestone(t.issue.milestoneTitle).trackerState = t.issue.factoryState;
      }

      for (const e of epics) {
        const tasks = mine.filter((r) => r.issue.parentIssueId === e.issue.id);
        const rollup = { total: tasks.length, ready: 0, inReview: 0, inTest: 0, done: 0, blocked: 0, waiting: 0 };
        for (const t of tasks) {
          const s = t.issue.factoryState;
          if (t.issue.state === "closed" || s === "factory:deployed") rollup.done++;
          else if (s === "factory:ready") rollup.ready++;
          else if (s === "factory:in-review") rollup.inReview++;
          else if (s === "factory:in-test") rollup.inTest++;
          else if (s === "factory:blocked") rollup.blocked++;
          if (t.issue.state === "open" && openBlockerOf.has(t.issue.id)) rollup.waiting++;
        }
        const gateInfo = e.issue.factoryState ? GATE_STATES[e.issue.factoryState] : undefined;
        milestone(e.issue.milestoneTitle ?? NO_RELEASE).epics.push({
          epicId: e.issue.id,
          number: e.issue.number,
          title: e.issue.title,
          repo: e.repoFullName,
          state: e.issue.factoryState,
          phase: phaseOfState(e.issue.factoryState),
          daysInState: daysInState(e.issue.id, e.issue.ghCreatedAt ?? e.issue.ghUpdatedAt),
          rollup,
          blockedCount: rollup.blocked + (e.issue.factoryState === "factory:blocked" ? 1 : 0),
          gate: gateInfo ? { ...gateInfo, approvers: approversOf.get(`${estate.id}:${gateInfo.gate}`) ?? [] } : null,
          tasks: tasks
            .map((t) => ({
              issueId: t.issue.id,
              number: t.issue.number,
              title: t.issue.title,
              state: t.issue.factoryState,
              phase: phaseOfState(t.issue.factoryState),
              open: t.issue.state === "open",
              assignees: t.issue.assignees,
              ageDays: daysInState(t.issue.id, t.issue.ghUpdatedAt),
              blockedBy: (blockedByOf.get(t.issue.id) ?? []).sort((a, b) => a - b),
            }))
            .sort((a, b) => a.number - b.number),
        });
      }

      const milestoneList = [...milestones.entries()]
        .map(([title, m]) => ({ title, ...m, epics: (m.epics as Array<{ number: number }>).sort((a, b) => a.number - b.number) }))
        .filter((m) => m.epics.length > 0 || m.trackerState !== null)
        .sort((a, b) => (a.title === NO_RELEASE ? 1 : b.title === NO_RELEASE ? -1 : a.title.localeCompare(b.title)));

      out.push({ id: estate.id, name: estate.name, milestones: milestoneList });
    }
    return { estates: out };
  });
}
