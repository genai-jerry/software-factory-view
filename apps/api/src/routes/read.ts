import { decryptSecret, GATE_STATES, PIPELINE_ORDER } from "@console/core";
import {
  artifactCache,
  changeArtifacts,
  changes,
  comments,
  decisions,
  estates,
  gateAssignments,
  gateViews,
  issues,
  issueStateHistory,
  memberships,
  orgs,
  pullRequests,
  repos,
  runs,
  threadEntries,
  threads,
  users,
} from "@console/db";
import { and, desc, eq, ilike, inArray, isNotNull, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps, type RequestCtx } from "../context.js";
import { renderMarkdown } from "../render.js";

/** Read surface. Every query is scoped to the caller's orgs at the data layer. */
export function registerReadRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get("/api/me", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const user = (await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1))[0]!;
    const orgRows = await db
      .select({ id: orgs.id, name: orgs.name, role: memberships.role })
      .from(memberships)
      .innerJoin(orgs, eq(orgs.id, memberships.orgId))
      .where(eq(memberships.userId, ctx.userId));
    return { login: user.login, name: user.name, avatarUrl: user.avatarUrl, orgs: orgRows };
  });

  app.get("/api/estates", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const estateRows = await db.select().from(estates).where(inArray(estates.orgId, ctx.orgIds));
    const out = [];
    const staleMs = deps.cfg.STALENESS_THRESHOLD_MINUTES * 60_000;
    for (const e of estateRows) {
      const repoRows = await db.select().from(repos).where(eq(repos.estateId, e.id));
      out.push({
        id: e.id,
        name: e.name,
        lastSyncedAt: e.lastSyncedAt,
        stale: !e.lastSyncedAt || Date.now() - e.lastSyncedAt.getTime() > staleMs,
        repos: repoRows.map((r) => ({
          id: r.id,
          fullName: r.fullName,
          defaultBranch: r.defaultBranch,
          stagingBranch: r.stagingBranch,
          factoryEnabled: r.factoryEnabled,
          lastSyncedAt: r.lastSyncedAt,
        })),
      });
    }
    return { estates: out };
  });

  /**
   * The attention queue — a query, not a table (spec 02 §3). Four sources,
   * each with a one-line "why you", ordered by age. This is the home page.
   */
  app.get("/api/attention", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const entries: Array<{
      kind: "gate" | "blocked" | "task-start" | "merge";
      whyYou: string;
      epicId: string;
      title: string;
      repo: string;
      state: string | null;
      ageDays: number;
      link: string;
    }> = [];

    const myAssignments = await db.select().from(gateAssignments).where(eq(gateAssignments.login, ctx.login));
    const assignedGates = new Map<string, Set<string>>(); // `${estateId}:${repoId}` -> gates
    for (const a of myAssignments) {
      const key = `${a.estateId}:${a.repoId ?? "*"}`;
      if (!assignedGates.has(key)) assignedGates.set(key, new Set());
      assignedGates.get(key)!.add(a.gate);
    }

    const openFactoryIssues = await db
      .select({
        issue: issues,
        repoFullName: repos.fullName,
        estateId: repos.estateId,
        repoId: repos.id,
      })
      .from(issues)
      .innerJoin(repos, eq(repos.id, issues.repoId))
      .where(and(inArray(issues.orgId, ctx.orgIds), eq(issues.state, "open"), isNotNull(issues.factoryState)));

    const now = Date.now();
    for (const row of openFactoryIssues) {
      const { issue } = row;
      const state = issue.factoryState!;
      const ageDays = Math.floor((now - issue.ghUpdatedAt.getTime()) / 86_400_000);
      const gateInfo = GATE_STATES[state];

      if (state === "factory:blocked") {
        entries.push({
          kind: "blocked",
          whyYou: "blocked issue in your estate — any member may reply to resume it",
          epicId: issue.parentIssueId ?? issue.id,
          title: `#${issue.number} ${issue.title}`,
          repo: row.repoFullName,
          state,
          ageDays,
          link: `/epics/${issue.parentIssueId ?? issue.id}`,
        });
        continue;
      }
      if (!gateInfo) continue;

      const perRepo = assignedGates.get(`${row.estateId}:${row.repoId}`);
      const estateWide = assignedGates.get(`${row.estateId}:*`);
      const allForRepo = await db
        .select()
        .from(gateAssignments)
        .where(and(eq(gateAssignments.estateId, row.estateId), eq(gateAssignments.gate, gateInfo.gate)));
      const listEmpty = allForRepo.length === 0;
      const mine = perRepo?.has(gateInfo.gate) || estateWide?.has(gateInfo.gate) || listEmpty;
      if (!mine) continue;

      const whyBase = listEmpty ? "approver list is empty — any collaborator may act" : `you are on the ${gateInfo.gate} approver list`;
      if (issue.kind === "epic" && (state === "factory:spec-ready" || state === "factory:design-ready")) {
        entries.push({
          kind: "gate",
          whyYou: `${gateInfo.label} awaits approval — ${whyBase}`,
          epicId: issue.id,
          title: `#${issue.number} ${issue.title}`,
          repo: row.repoFullName,
          state,
          ageDays,
          link: `/epics/${issue.id}?tab=gate`,
        });
      } else if (issue.kind === "task" && state === "factory:ready") {
        entries.push({
          kind: "task-start",
          whyYou: `task awaits an implementation start — ${whyBase}`,
          epicId: issue.parentIssueId ?? issue.id,
          title: `#${issue.number} ${issue.title}`,
          repo: row.repoFullName,
          state,
          ageDays,
          link: `/epics/${issue.parentIssueId ?? issue.id}?tab=tasks`,
        });
      } else if (issue.kind === "epic" && state === "factory:ready-to-ship") {
        entries.push({
          kind: "merge",
          whyYou: `release train awaits merges — ${whyBase}`,
          epicId: issue.id,
          title: `#${issue.number} ${issue.title}`,
          repo: row.repoFullName,
          state,
          ageDays,
          link: `/epics/${issue.id}?tab=gate`,
        });
      }
    }

    entries.sort((a, b) => b.ageDays - a.ageDays);
    return { entries };
  });

  /** Pipeline board: epics as cards in state-machine columns, one lane per estate. */
  app.get("/api/board", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const epicRows = await db
      .select({ issue: issues, repoFullName: repos.fullName, estateId: repos.estateId })
      .from(issues)
      .innerJoin(repos, eq(repos.id, issues.repoId))
      .where(and(inArray(issues.orgId, ctx.orgIds), eq(issues.kind, "epic")));

    const cards = [];
    for (const row of epicRows) {
      const rollup = await taskRollup(deps, row.issue.id);
      const lastTransition = (
        await db
          .select({ at: issueStateHistory.occurredAt })
          .from(issueStateHistory)
          .where(eq(issueStateHistory.issueId, row.issue.id))
          .orderBy(desc(issueStateHistory.occurredAt))
          .limit(1)
      )[0];
      const sinceMs = Date.now() - (lastTransition?.at ?? row.issue.ghCreatedAt ?? row.issue.ghUpdatedAt).getTime();
      cards.push({
        epicId: row.issue.id,
        number: row.issue.number,
        title: row.issue.title,
        repo: row.repoFullName,
        estateId: row.estateId,
        state: row.issue.factoryState,
        open: row.issue.state === "open",
        daysInState: Math.floor(sinceMs / 86_400_000),
        blocked: rollup.blocked > 0 || row.issue.factoryState === "factory:blocked",
        tasks: rollup,
      });
    }
    return { columns: PIPELINE_ORDER, cards };
  });

  /** The epic workspace payload: everything the shell needs in one round trip. */
  app.get<{ Params: { id: string } }>("/api/epics/:id", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const { epic, repo } = found;

    const rollup = await taskRollup(deps, epic.id);
    const taskRows = await db
      .select()
      .from(issues)
      .where(eq(issues.parentIssueId, epic.id))
      .orderBy(issues.number);

    const change = (await db.select().from(changes).where(eq(changes.epicIssueId, epic.id)).limit(1))[0];
    const artifacts = change
      ? await db.select().from(changeArtifacts).where(eq(changeArtifacts.changeId, change.id))
      : [];

    const threadRows = await db
      .select({
        id: threads.id,
        topicKind: threads.topicKind,
        topicRef: threads.topicRef,
        title: threads.title,
        status: threads.status,
        entryCount: dsql<number>`(select count(*) from ${threadEntries} where ${threadEntries.threadId} = ${threads.id})`,
      })
      .from(threads)
      .where(eq(threads.epicIssueId, epic.id));

    const gateInfo = epic.factoryState ? GATE_STATES[epic.factoryState] : undefined;
    let myGate: { gate: string; label: string; amApprover: boolean; approvers: string[] } | null = null;
    if (gateInfo && epic.state === "open") {
      const approverRows = await db
        .select()
        .from(gateAssignments)
        .where(and(eq(gateAssignments.estateId, repo.estateId), eq(gateAssignments.gate, gateInfo.gate)));
      const approvers = [...new Set(approverRows.map((a) => a.login))];
      myGate = {
        gate: gateInfo.gate,
        label: gateInfo.label,
        amApprover: approvers.length === 0 || approvers.includes(ctx.login),
        approvers,
      };
    }

    const blockedSubs = taskRows.filter((t) => t.factoryState === "factory:blocked");
    const estate = (await db.select().from(estates).where(eq(estates.id, repo.estateId)).limit(1))[0];
    const staleMs = deps.cfg.STALENESS_THRESHOLD_MINUTES * 60_000;

    return {
      epic: {
        id: epic.id,
        number: epic.number,
        title: epic.title,
        bodyHtml: epic.body ? renderMarkdown(epic.body) : "",
        state: epic.factoryState,
        open: epic.state === "open",
        author: epic.author,
        htmlUrl: epic.htmlUrl,
        labels: epic.labels,
      },
      repo: { id: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch },
      pipeline: PIPELINE_ORDER,
      gate: myGate,
      tasks: taskRows.map((t) => ({
        id: t.id,
        number: t.number,
        title: t.title,
        state: t.factoryState,
        open: t.state === "open",
        htmlUrl: t.htmlUrl,
      })),
      rollup,
      blockedSubIssues: blockedSubs.map((t) => ({ id: t.id, number: t.number, title: t.title, htmlUrl: t.htmlUrl })),
      change: change ? { id: change.id, slug: change.slug, status: change.status } : null,
      artifacts: artifacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        path: a.path,
        latestSha: a.latestSha,
        mergedSha: a.mergedSha,
        diverged: Boolean(a.latestSha && a.mergedSha && a.latestSha !== a.mergedSha),
      })),
      threads: threadRows,
      freshness: {
        lastSyncedAt: estate?.lastSyncedAt ?? null,
        stale: !estate?.lastSyncedAt || Date.now() - estate.lastSyncedAt.getTime() > staleMs,
      },
    };
  });

  /** Timeline: state history + workflow runs, interleaved. */
  app.get<{ Params: { id: string } }>("/api/epics/:id/timeline", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const { epic, repo } = found;

    const taskIds = (await db.select({ id: issues.id }).from(issues).where(eq(issues.parentIssueId, epic.id))).map((r) => r.id);
    const history = await db
      .select()
      .from(issueStateHistory)
      .where(inArray(issueStateHistory.issueId, [epic.id, ...taskIds]))
      .orderBy(desc(issueStateHistory.occurredAt))
      .limit(200);
    const runRows = await db
      .select()
      .from(runs)
      .where(eq(runs.repoId, repo.id))
      .orderBy(desc(runs.startedAt))
      .limit(100);

    const events = [
      ...history.map((h) => ({
        type: "state" as const,
        at: h.occurredAt,
        detail: h.toState ? `→ ${h.toState}` : `− ${h.fromState}`,
        actor: h.actor,
        issueId: h.issueId,
      })),
      ...runRows.map((r) => ({
        type: "run" as const,
        at: r.startedAt ?? r.ghUpdatedAt,
        detail: `${r.role ?? r.workflowName ?? "run"} — ${r.conclusion ?? r.status ?? "running"}`,
        actor: null,
        link: r.htmlUrl,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    return { events };
  });

  /** Artifact reader: decrypt from the immutable cache and render, at either ref. */
  app.get<{ Params: { id: string }; Querystring: { path: string; ref?: "proposed" | "approved" } }>(
    "/api/epics/:id/artifact",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadEpic(deps, ctx, req.params.id);
      if (!found) return reply.code(404).send({ error: "epic not found" });
      const { epic } = found;

      const change = (await db.select().from(changes).where(eq(changes.epicIssueId, epic.id)).limit(1))[0];
      if (!change) return reply.code(404).send({ error: "no change folder discovered for this epic" });
      const artifact = (
        await db
          .select()
          .from(changeArtifacts)
          .where(and(eq(changeArtifacts.changeId, change.id), eq(changeArtifacts.path, req.query.path)))
          .limit(1)
      )[0];
      if (!artifact) return reply.code(404).send({ error: "unknown artifact path" });

      const wantRef = req.query.ref ?? "proposed";
      const sha = wantRef === "approved" ? artifact.mergedSha : artifact.latestSha;
      if (!sha) return reply.code(404).send({ error: `no ${wantRef} version cached` });
      const cached = (
        await db
          .select()
          .from(artifactCache)
          .where(and(eq(artifactCache.repoId, artifact.repoId), eq(artifactCache.path, artifact.path), eq(artifactCache.commitSha, sha)))
          .limit(1)
      )[0];
      if (!cached) return reply.code(404).send({ error: "content not in cache yet — reconcile pending" });

      const content = decryptSecret(cached.encryptedContent, deps.cfg.CONSOLE_MASTER_KEY);
      return {
        path: artifact.path,
        ref: wantRef,
        sha,
        markdown: content,
        html: renderMarkdown(content),
        otherSha: wantRef === "approved" ? artifact.latestSha : artifact.mergedSha,
      };
    },
  );

  /** Thread detail with rendered entries. */
  app.get<{ Params: { id: string } }>("/api/threads/:id", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const thread = (
      await db.select().from(threads).where(and(eq(threads.id, req.params.id), inArray(threads.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!thread) return reply.code(404).send({ error: "thread not found" });

    const entries = await db
      .select({ entry: threadEntries, comment: comments })
      .from(threadEntries)
      .leftJoin(comments, eq(comments.id, threadEntries.commentId))
      .where(eq(threadEntries.threadId, thread.id))
      .orderBy(threadEntries.createdAt);

    return {
      id: thread.id,
      title: thread.title,
      topicKind: thread.topicKind,
      topicRef: thread.topicRef,
      status: thread.status,
      entries: entries.map(({ entry, comment }) => ({
        id: entry.id,
        source: entry.source,
        author: entry.author ?? comment?.author ?? null,
        bodyHtml: renderMarkdown(comment?.body ?? entry.body ?? ""),
        isAgent: comment?.isAgent ?? false,
        isApproval: comment?.isApproval ?? false,
        htmlUrl: comment?.htmlUrl ?? null,
        createdAt: entry.createdAt,
      })),
    };
  });

  /** Decisions: per-epic list and org-wide search. */
  app.get<{ Params: { id: string } }>("/api/epics/:id/decisions", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const rows = await db
      .select()
      .from(decisions)
      .where(eq(decisions.epicIssueId, found.epic.id))
      .orderBy(desc(decisions.createdAt));
    return { decisions: rows.map(decisionDto) };
  });

  app.get<{ Querystring: { q?: string } }>("/api/decisions", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const q = req.query.q?.trim();
    const rows = await db
      .select()
      .from(decisions)
      .where(
        q
          ? and(inArray(decisions.orgId, ctx.orgIds), ilike(decisions.title, `%${q}%`))
          : inArray(decisions.orgId, ctx.orgIds),
      )
      .orderBy(desc(decisions.createdAt))
      .limit(100);
    return { decisions: rows.map(decisionDto) };
  });

  /** Blocked inbox. */
  app.get("/api/blocked", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const rows = await db
      .select({ issue: issues, repoFullName: repos.fullName })
      .from(issues)
      .innerJoin(repos, eq(repos.id, issues.repoId))
      .where(and(inArray(issues.orgId, ctx.orgIds), eq(issues.factoryState, "factory:blocked"), eq(issues.state, "open")));
    return {
      issues: rows.map((r) => ({
        id: r.issue.id,
        number: r.issue.number,
        title: r.issue.title,
        repo: r.repoFullName,
        epicId: r.issue.parentIssueId ?? r.issue.id,
        htmlUrl: r.issue.htmlUrl,
        ageDays: Math.floor((Date.now() - r.issue.ghUpdatedAt.getTime()) / 86_400_000),
      })),
    };
  });

  /** Record "I looked at this gate at this sha" for the what-changed diff. */
  app.post<{ Params: { id: string }; Body: { gate: string; sha: string } }>("/api/epics/:id/gate-view", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    await db
      .insert(gateViews)
      .values({
        orgId: found.epic.orgId,
        userId: ctx.userId,
        epicIssueId: found.epic.id,
        gate: req.body.gate,
        lastViewedSha: req.body.sha,
        lastViewedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [gateViews.userId, gateViews.epicIssueId, gateViews.gate],
        set: { lastViewedSha: req.body.sha, lastViewedAt: new Date() },
      });
    return { ok: true };
  });
}

/* ------------------------------- shared helpers ------------------------------- */

export async function loadEpic(
  deps: AppDeps,
  ctx: RequestCtx,
  epicId: string,
): Promise<{ epic: typeof issues.$inferSelect; repo: typeof repos.$inferSelect } | null> {
  const { db } = deps.dbh;
  const rows = await db
    .select({ epic: issues, repo: repos })
    .from(issues)
    .innerJoin(repos, eq(repos.id, issues.repoId))
    .where(and(eq(issues.id, epicId), inArray(issues.orgId, ctx.orgIds)))
    .limit(1);
  return rows[0] ?? null;
}

export async function taskRollup(
  deps: AppDeps,
  epicIssueId: string,
): Promise<{ total: number; ready: number; inReview: number; inTest: number; done: number; blocked: number }> {
  const { db } = deps.dbh;
  const tasks = await db
    .select({ factoryState: issues.factoryState, state: issues.state })
    .from(issues)
    .where(eq(issues.parentIssueId, epicIssueId));
  const rollup = { total: tasks.length, ready: 0, inReview: 0, inTest: 0, done: 0, blocked: 0 };
  for (const t of tasks) {
    if (t.state === "closed" || t.factoryState === "factory:deployed") rollup.done++;
    else if (t.factoryState === "factory:ready") rollup.ready++;
    else if (t.factoryState === "factory:in-review") rollup.inReview++;
    else if (t.factoryState === "factory:in-test") rollup.inTest++;
    else if (t.factoryState === "factory:blocked") rollup.blocked++;
  }
  return rollup;
}

function decisionDto(d: typeof decisions.$inferSelect) {
  return {
    id: d.id,
    title: d.title,
    context: d.context,
    options: d.options,
    chosen: d.chosen,
    consequences: d.consequences,
    decidedBy: d.decidedBy,
    status: d.status,
    supersedesId: d.supersedesId,
    createdAt: d.createdAt,
  };
}
