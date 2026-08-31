import {
  decryptSecret,
  factoryRunIsPending,
  GATE_STATES,
  githubActionsEnabled,
  PIPELINE_ORDER,
  READY_STATE,
  startStatusTakesApproval,
} from "@console/core";
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
  taskDependencies,
  threadEntries,
  threads,
  users,
  webhookDeliveries,
} from "@console/db";
import { and, desc, eq, ilike, inArray, isNotNull, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildAttention } from "../attention.js";
import { loadTaskStartFacts, startStatusOf } from "../start-gate.js";
import { requireAuth, resolveSession, userClient, type AppDeps, type RequestCtx } from "../context.js";
import { fetchGitHubMedia, isGitHubMediaUrl } from "../media.js";
import { renderMarkdown } from "../render.js";
import { countThreadEntries } from "../threads.js";

/** Read surface. Every query is scoped to the caller's orgs at the data layer. */
export function registerReadRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  /**
   * Who the caller is. Deliberately not behind requireAuth's membership check:
   * "signed in, member of nothing" is a true answer, and it is the state every
   * first user of a Console is in — membership is granted by connecting an
   * estate, which is a screen the shell can only offer once it knows who it is
   * talking to. Answering 403 here made that a dead end. The org scope still
   * guards every route that returns estate data.
   */
  app.get("/api/me", async (req, reply) => {
    const ctx = await resolveSession(db, deps.cfg, req);
    if (!ctx) return reply.code(401).send({ error: "not signed in" });
    const user = (await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1))[0]!;
    const orgRows = await db
      .select({ id: orgs.id, name: orgs.name, role: memberships.role })
      .from(memberships)
      .innerJoin(orgs, eq(orgs.id, memberships.orgId))
      .where(eq(memberships.userId, ctx.userId));
    return { login: user.login, name: user.name, avatarUrl: user.avatarUrl, orgs: orgRows };
  });

  /** Proxy GitHub-hosted issue/comment images with installation or user auth. */
  app.get<{ Params: { repoId: string }; Querystring: { url?: string } }>("/api/media/:repoId", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const url = req.query.url?.trim();
    if (!url || !isGitHubMediaUrl(url)) return reply.code(400).send({ error: "unsupported or missing media url" });

    const row = (
      await db
        .select({ repo: repos, estate: estates })
        .from(repos)
        .innerJoin(estates, eq(estates.id, repos.estateId))
        .where(and(eq(repos.id, req.params.repoId), inArray(repos.orgId, ctx.orgIds)))
        .limit(1)
    )[0];
    if (!row) return reply.code(404).send({ error: "repo not found" });

    let token: string;
    try {
      const auth = await deps.credentials.auth();
      if (auth) {
        token = await auth.installationToken(row.estate.installationId);
      } else {
        token = ctx.userToken();
      }
    } catch {
      try {
        token = ctx.userToken();
      } catch {
        return reply.code(503).send({ error: "no GitHub credentials available to fetch media" });
      }
    }

    try {
      const { body, contentType } = await fetchGitHubMedia(url, token);
      reply.header("content-type", contentType);
      reply.header("cache-control", "private, max-age=3600");
      return reply.send(body);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get("/api/estates", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const estateRows = await db.select().from(estates).where(inArray(estates.orgId, ctx.orgIds));

    // Ingestion health: when the projections look empty, the difference
    // between "no webhook ever arrived" (App webhook URL/secret broken) and
    // "webhooks arrive but sit unprocessed" (worker or Redis down) is the
    // whole diagnosis — surface it instead of leaving the operator to guess.
    const ingestion = (
      await db
        .select({
          lastReceivedAt: dsql<Date | null>`max(${webhookDeliveries.receivedAt})`,
          lastProcessedAt: dsql<Date | null>`max(${webhookDeliveries.processedAt})`,
          pending: dsql<number>`count(*) filter (where ${webhookDeliveries.processedAt} is null)`,
        })
        .from(webhookDeliveries)
    )[0]!;

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
    return {
      estates: out,
      ingestion: {
        lastReceivedAt: ingestion.lastReceivedAt,
        lastProcessedAt: ingestion.lastProcessedAt,
        pending: Number(ingestion.pending),
      },
    };
  });

  /**
   * The attention queue — a query, not a table (spec 02 §3), with ownership
   * routing and ranks so an agent halted on *you* outranks broadcast noise.
   * The full derivation lives in ../attention.ts, shared with /api/my-work.
   */
  app.get<{ Querystring: RepoFilterQuery }>("/api/attention", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repoFilter = await resolveRepoFilter(deps, ctx, req.query);
    if (repoFilter && repoFilter.length === 0) return { entries: [] };
    return { entries: await buildAttention(deps, ctx, repoFilter ?? undefined) };
  });

  /** Pipeline board: epics as cards in state-machine columns, one lane per estate. */
  app.get<{ Querystring: RepoFilterQuery }>("/api/board", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repoFilter = await resolveRepoFilter(deps, ctx, req.query);
    if (repoFilter && repoFilter.length === 0) return { columns: PIPELINE_ORDER, cards: [] };
    const epicRows = await db
      .select({ issue: issues, repoFullName: repos.fullName, estateId: repos.estateId })
      .from(issues)
      .innerJoin(repos, eq(repos.id, issues.repoId))
      .where(
        and(
          inArray(issues.orgId, ctx.orgIds),
          eq(issues.kind, "epic"),
          ...(repoFilter ? [inArray(issues.repoId, repoFilter)] : []),
        ),
      );

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
    const deps_ = await loadDependencies(
      deps,
      taskRows.map((t) => t.id),
    );

    const change = (await db.select().from(changes).where(eq(changes.epicIssueId, epic.id)).limit(1))[0];
    const artifacts = change
      ? await db.select().from(changeArtifacts).where(eq(changeArtifacts.changeId, change.id))
      : [];

    const threadBase = await db
      .select({
        id: threads.id,
        topicKind: threads.topicKind,
        topicRef: threads.topicRef,
        title: threads.title,
        status: threads.status,
      })
      .from(threads)
      .where(eq(threads.epicIssueId, epic.id));
    const threadCounts = await countThreadEntries(db, threadBase.map((t) => t.id));
    const threadRows = threadBase.map((t) => ({ ...t, entryCount: threadCounts.get(t.id) ?? 0 }));

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

    // The task start gate (the `implementation` gate): who may put `Approved`
    // on a `factory:ready` task. Same shape the tree tab reads, so every tab
    // renders the one Approve button under the same rule. Empty list = any
    // collaborator, matching the router.
    const startApproverRows = await db
      .select()
      .from(gateAssignments)
      .where(and(eq(gateAssignments.estateId, repo.estateId), eq(gateAssignments.gate, "implementation")));
    const startApprovers = [...new Set(startApproverRows.map((a) => a.login))];
    const startGate = {
      approvers: startApprovers,
      amApprover: startApprovers.length === 0 || startApprovers.includes(ctx.login),
    };

    // Where each ready task actually stands at the start gate: untouched,
    // approved and waiting for the run, or with an implementer already on it.
    // The state label alone cannot tell those apart (see core/start-gate.ts).
    const startFacts = await loadTaskStartFacts(
      deps,
      taskRows.filter((t) => t.state === "open" && t.factoryState === READY_STATE).map((t) => t.id),
    );

    const blockedSubs = taskRows.filter((t) => t.factoryState === "factory:blocked");
    const estate = (await db.select().from(estates).where(eq(estates.id, repo.estateId)).limit(1))[0];
    const org = (await db.select().from(orgs).where(eq(orgs.id, repo.orgId)).limit(1))[0];
    const staleMs = deps.cfg.STALENESS_THRESHOLD_MINUTES * 60_000;
    const actions = githubActionsEnabled(org?.orchestrator);
    const pending = factoryRunIsPending({ open: epic.state === "open", labels: epic.labels });

    return {
      epic: {
        id: epic.id,
        number: epic.number,
        title: epic.title,
        bodyHtml: epic.body ? renderMarkdown(epic.body, { repoId: repo.id }) : "",
        state: epic.factoryState,
        open: epic.state === "open",
        author: epic.author,
        htmlUrl: epic.htmlUrl,
        labels: epic.labels,
      },
      repo: { id: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch },
      pipeline: PIPELINE_ORDER,
      gate: myGate,
      startGate,
      tasks: taskRows.map((t) => {
        const startStatus = startStatusOf(t, startFacts.get(t.id));
        return {
          id: t.id,
          number: t.number,
          title: t.title,
          state: t.factoryState,
          open: t.state === "open",
          htmlUrl: t.htmlUrl,
          blockedBy: deps_.get(t.id)?.blockedBy ?? [],
          blocks: deps_.get(t.id)?.blocks ?? [],
          startStatus,
          approvable: startStatusTakesApproval(startStatus),
        };
      }),
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
      orchestrator: {
        engine: actions ? "github-actions" : "software-factory",
        githubActionsEnabled: actions,
        canStart: !actions && pending,
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
      const { epic, repo } = found;

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
        html: renderMarkdown(content, { repoId: repo.id }),
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

    const epicRow = (
      await db
        .select({ repoId: issues.repoId })
        .from(issues)
        .where(and(eq(issues.id, thread.epicIssueId), inArray(issues.orgId, ctx.orgIds)))
        .limit(1)
    )[0];
    const repoId = epicRow?.repoId;

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
        bodyHtml: renderMarkdown(comment?.body ?? entry.body ?? "", repoId ? { repoId } : undefined),
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
  app.get<{ Querystring: RepoFilterQuery }>("/api/blocked", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repoFilter = await resolveRepoFilter(deps, ctx, req.query);
    if (repoFilter && repoFilter.length === 0) return { issues: [] };
    const rows = await db
      .select({ issue: issues, repoFullName: repos.fullName })
      .from(issues)
      .innerJoin(repos, eq(repos.id, issues.repoId))
      .where(
        and(
          inArray(issues.orgId, ctx.orgIds),
          eq(issues.factoryState, "factory:blocked"),
          eq(issues.state, "open"),
          ...(repoFilter ? [inArray(issues.repoId, repoFilter)] : []),
        ),
      );
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

export interface RepoFilterQuery {
  repo?: string;
  project?: string;
}

/**
 * Resolve the ?repo= / ?project= focus filter to a set of repo ids.
 * Returns null for "no filter" (show everything); an array otherwise —
 * possibly empty, which callers must treat as "match nothing" rather than
 * passing an empty inArray() to SQL. A repo filter wins over a project one.
 */
export async function resolveRepoFilter(deps: AppDeps, ctx: RequestCtx, query: RepoFilterQuery): Promise<string[] | null> {
  const { db } = deps.dbh;
  if (query.repo) {
    const rows = await db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.id, query.repo), inArray(repos.orgId, ctx.orgIds)));
    return rows.map((r) => r.id);
  }
  if (query.project) {
    const rows = await db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.projectId, query.project), inArray(repos.orgId, ctx.orgIds)));
    return rows.map((r) => r.id);
  }
  return null;
}

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

/** Any issue in the caller's orgs, with its repo — loadEpic without the epic assumption. */
export async function loadIssue(
  deps: AppDeps,
  ctx: RequestCtx,
  issueId: string,
): Promise<{ issue: typeof issues.$inferSelect; repo: typeof repos.$inferSelect } | null> {
  const { db } = deps.dbh;
  const rows = await db
    .select({ issue: issues, repo: repos })
    .from(issues)
    .innerJoin(repos, eq(repos.id, issues.repoId))
    .where(and(eq(issues.id, issueId), inArray(issues.orgId, ctx.orgIds)))
    .limit(1);
  return rows[0] ?? null;
}

export interface DepNode {
  id: string;
  number: number;
  title: string;
  state: string | null;
  open: boolean;
  htmlUrl: string;
}

/** Both directions of the dependency graph for a set of issues, two batched queries. */
export async function loadDependencies(
  deps: AppDeps,
  issueIds: string[],
): Promise<Map<string, { blockedBy: DepNode[]; blocks: DepNode[] }>> {
  const { db } = deps.dbh;
  const out = new Map<string, { blockedBy: DepNode[]; blocks: DepNode[] }>();
  if (issueIds.length === 0) return out;
  const entry = (id: string) => {
    if (!out.has(id)) out.set(id, { blockedBy: [], blocks: [] });
    return out.get(id)!;
  };
  const node = (i: typeof issues.$inferSelect): DepNode => ({
    id: i.id,
    number: i.number,
    title: i.title,
    state: i.factoryState,
    open: i.state === "open",
    htmlUrl: i.htmlUrl,
  });
  const blockedByRows = await db
    .select({ dep: taskDependencies, other: issues })
    .from(taskDependencies)
    .innerJoin(issues, eq(issues.id, taskDependencies.blockerIssueId))
    .where(inArray(taskDependencies.blockedIssueId, issueIds));
  for (const r of blockedByRows) entry(r.dep.blockedIssueId).blockedBy.push(node(r.other));
  const blocksRows = await db
    .select({ dep: taskDependencies, other: issues })
    .from(taskDependencies)
    .innerJoin(issues, eq(issues.id, taskDependencies.blockedIssueId))
    .where(inArray(taskDependencies.blockerIssueId, issueIds));
  for (const r of blocksRows) entry(r.dep.blockerIssueId).blocks.push(node(r.other));
  for (const v of out.values()) {
    v.blockedBy.sort((a, b) => a.number - b.number);
    v.blocks.sort((a, b) => a.number - b.number);
  }
  return out;
}

export async function taskRollup(
  deps: AppDeps,
  epicIssueId: string,
): Promise<{ total: number; ready: number; inReview: number; inTest: number; done: number; blocked: number; waiting: number }> {
  const { db } = deps.dbh;
  const tasks = await db
    .select({ id: issues.id, factoryState: issues.factoryState, state: issues.state })
    .from(issues)
    .where(eq(issues.parentIssueId, epicIssueId));
  const rollup = { total: tasks.length, ready: 0, inReview: 0, inTest: 0, done: 0, blocked: 0, waiting: 0 };
  const openIds: string[] = [];
  for (const t of tasks) {
    if (t.state === "open") openIds.push(t.id);
    if (t.state === "closed" || t.factoryState === "factory:deployed") rollup.done++;
    else if (t.factoryState === "factory:ready") rollup.ready++;
    else if (t.factoryState === "factory:in-review") rollup.inReview++;
    else if (t.factoryState === "factory:in-test") rollup.inTest++;
    else if (t.factoryState === "factory:blocked") rollup.blocked++;
  }
  if (openIds.length > 0) {
    const waiting = await db
      .selectDistinct({ blocked: taskDependencies.blockedIssueId })
      .from(taskDependencies)
      .innerJoin(issues, eq(issues.id, taskDependencies.blockerIssueId))
      .where(and(inArray(taskDependencies.blockedIssueId, openIds), eq(issues.state, "open")));
    rollup.waiting = waiting.length;
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
