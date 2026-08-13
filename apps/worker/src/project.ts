import {
  blockerNumbersFromBody,
  deriveFactoryState,
  deriveIssueKind,
  derivePrKind,
  isAgentComment,
  isApprovedComment,
  isFactoryState,
  parseConsoleMarkers,
  type GhComment,
  type GhIssue,
  type GhPull,
  type GhWorkflowRun,
} from "@console/core";
import {
  comments,
  issues,
  issueStateHistory,
  pullRequests,
  repos,
  runs,
  taskDependencies,
  threads,
  threadEntries,
  decisions,
  estates,
  orgs,
  type Db,
} from "@console/db";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * Projection functions. Every write is an idempotent upsert keyed by the
 * GitHub node_id with a gh_updated_at last-writer-wins guard, so duplicate
 * and out-of-order deliveries converge on the same state (spec 01 §2.2).
 */

export interface RepoRef {
  id: string;
  orgId: string;
  estateId: string;
  fullName: string;
  defaultBranch: string;
}

/** Find or create the estate/org/repo rows for a webhook's repository. */
export async function ensureRepo(
  db: Db,
  installationId: number,
  repository: { node_id: string; full_name: string; default_branch?: string; private?: boolean },
): Promise<RepoRef> {
  const existing = await db.select().from(repos).where(eq(repos.ghNodeId, repository.node_id)).limit(1);
  if (existing[0]) {
    const r = existing[0];
    return { id: r.id, orgId: r.orgId, estateId: r.estateId, fullName: r.fullName, defaultBranch: r.defaultBranch };
  }

  let estate = (await db.select().from(estates).where(eq(estates.installationId, installationId)).limit(1))[0];
  if (!estate) {
    const accountName = repository.full_name.split("/")[0] ?? "unknown";
    const org = (await db.insert(orgs).values({ name: accountName }).returning())[0]!;
    estate = (
      await db
        .insert(estates)
        .values({ orgId: org.id, name: accountName, installationId })
        .returning()
    )[0]!;
  }

  const inserted = await db
    .insert(repos)
    .values({
      orgId: estate.orgId,
      estateId: estate.id,
      ghNodeId: repository.node_id,
      fullName: repository.full_name,
      defaultBranch: repository.default_branch ?? "main",
    })
    .onConflictDoNothing({ target: repos.ghNodeId })
    .returning();
  const row = inserted[0] ?? (await db.select().from(repos).where(eq(repos.ghNodeId, repository.node_id)).limit(1))[0]!;
  return { id: row.id, orgId: row.orgId, estateId: row.estateId, fullName: row.fullName, defaultBranch: row.defaultBranch };
}

function labelNames(labels: GhIssue["labels"]): string[] {
  return labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
}

/** Heuristic parent link for task sub-issues; the reconciler repairs via the sub-issues API. */
function parentNumberFromBody(body: string | null): number | null {
  if (!body) return null;
  const m =
    body.match(/(?:^|\n)\s*(?:parent|epic)\s*:?\s*#(\d+)/i) ?? body.match(/sub-issue of\s+#(\d+)/i) ?? body.match(/part of\s+#(\d+)/i);
  return m ? Number(m[1]) : null;
}

export async function projectIssue(db: Db, repo: RepoRef, gh: GhIssue): Promise<{ issueId: string; stateChanged: boolean }> {
  if (gh.pull_request) return { issueId: "", stateChanged: false }; // PRs come through projectPull

  const labels = labelNames(gh.labels);
  const factoryState = deriveFactoryState(labels);
  const parentNumber = parentNumberFromBody(gh.body);
  let parentIssueId: string | null = null;
  if (parentNumber) {
    const parent = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.repoId, repo.id), eq(issues.number, parentNumber)))
      .limit(1);
    parentIssueId = parent[0]?.id ?? null;
  }
  const kind = deriveIssueKind({ labels, title: gh.title, hasParent: parentIssueId !== null });
  const ghUpdatedAt = new Date(gh.updated_at);

  const prev = await db
    .select({ id: issues.id, factoryState: issues.factoryState, ghUpdatedAt: issues.ghUpdatedAt })
    .from(issues)
    .where(eq(issues.ghNodeId, gh.node_id))
    .limit(1);

  await db
    .insert(issues)
    .values({
      orgId: repo.orgId,
      repoId: repo.id,
      ghNodeId: gh.node_id,
      number: gh.number,
      title: gh.title,
      body: gh.body,
      state: gh.state,
      author: gh.user?.login ?? null,
      assignees: gh.assignees?.map((a) => a.login) ?? [],
      kind,
      parentIssueId,
      factoryState,
      labels,
      htmlUrl: gh.html_url,
      ghCreatedAt: new Date(gh.created_at),
      ghUpdatedAt,
      closedAt: gh.closed_at ? new Date(gh.closed_at) : null,
    })
    .onConflictDoUpdate({
      target: issues.ghNodeId,
      set: {
        title: gh.title,
        body: gh.body,
        state: gh.state,
        assignees: gh.assignees?.map((a) => a.login) ?? [],
        kind,
        ...(parentIssueId ? { parentIssueId } : {}),
        factoryState,
        labels,
        htmlUrl: gh.html_url,
        ghUpdatedAt,
        closedAt: gh.closed_at ? new Date(gh.closed_at) : null,
      },
      setWhere: sql`${issues.ghUpdatedAt} <= ${ghUpdatedAt}`,
    });

  const row = (await db.select({ id: issues.id, kind: issues.kind }).from(issues).where(eq(issues.ghNodeId, gh.node_id)).limit(1))[0]!;
  const stateChanged = (prev[0]?.factoryState ?? null) !== factoryState;

  // Body-sourced dependency edges, under the same LWW discipline as the row
  // itself: a stale delivery must not rewrite edges a fresher body produced.
  if (!prev[0] || prev[0].ghUpdatedAt <= ghUpdatedAt) {
    await refreshBodyDependencies(db, repo, row.id, gh.body);
  }

  if (row.kind === "epic") await ensureEpicThreads(db, repo.orgId, row.id);
  return { issueId: row.id, stateChanged };
}

/**
 * Refresh this issue's `source='body'` dependency edges from its markers
 * (delete-then-insert, the gate-assignments discipline). Numbers resolve
 * same-repo; a marker naming an issue not yet projected is skipped and
 * converges on the next delivery or reconcile. `onConflictDoNothing` on the
 * (blocked, blocker) pair keeps github-sourced rows authoritative.
 */
async function refreshBodyDependencies(db: Db, repo: RepoRef, issueId: string, body: string | null): Promise<void> {
  const numbers = blockerNumbersFromBody(body);
  await db
    .delete(taskDependencies)
    .where(and(eq(taskDependencies.blockedIssueId, issueId), eq(taskDependencies.source, "body")));
  if (numbers.length === 0) return;
  const blockers = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.repoId, repo.id), inArray(issues.number, numbers)));
  for (const blocker of blockers) {
    if (blocker.id === issueId) continue;
    await db
      .insert(taskDependencies)
      .values({ orgId: repo.orgId, blockedIssueId: issueId, blockerIssueId: blocker.id, source: "body" })
      .onConflictDoNothing({ target: [taskDependencies.blockedIssueId, taskDependencies.blockerIssueId] });
  }
}

/** Record a labeled/unlabeled event into the append-only state history. */
export async function projectLabelEvent(
  db: Db,
  repo: RepoRef,
  issueNodeId: string,
  ev: { action: "labeled" | "unlabeled"; label: string; actor: string | null; eventId: string; occurredAt: string },
): Promise<void> {
  if (!isFactoryState(ev.label)) return;
  const issue = (await db.select({ id: issues.id, factoryState: issues.factoryState }).from(issues).where(eq(issues.ghNodeId, issueNodeId)).limit(1))[0];
  if (!issue) return;
  await db
    .insert(issueStateHistory)
    .values({
      orgId: repo.orgId,
      issueId: issue.id,
      fromState: ev.action === "labeled" ? null : ev.label,
      toState: ev.action === "labeled" ? ev.label : null,
      actor: ev.actor,
      sourceEventId: ev.eventId,
      occurredAt: new Date(ev.occurredAt),
    })
    .onConflictDoNothing();
}

const GATE_THREAD_FOR_STATE: Record<string, string> = {
  "factory:spec-ready": "gate/spec",
  "factory:spec-approved": "gate/spec",
  "factory:design-ready": "gate/design",
  "factory:design-approved": "gate/design",
  "factory:ready-to-ship": "gate/release",
  "factory:deployed": "gate/release",
};

export async function projectComment(
  db: Db,
  repo: RepoRef,
  issueNodeId: string,
  gh: GhComment,
): Promise<void> {
  const issue = (
    await db
      .select({ id: issues.id, kind: issues.kind, parentIssueId: issues.parentIssueId, factoryState: issues.factoryState, number: issues.number })
      .from(issues)
      .where(eq(issues.ghNodeId, issueNodeId))
      .limit(1)
  )[0];
  if (!issue) return;

  const markers = parseConsoleMarkers(gh.body);
  const ghUpdatedAt = new Date(gh.updated_at);
  await db
    .insert(comments)
    .values({
      orgId: repo.orgId,
      issueId: issue.id,
      ghNodeId: gh.node_id,
      ghId: gh.id,
      author: gh.user?.login ?? null,
      body: gh.body,
      isAgent: isAgentComment(gh.body),
      isApproval: isApprovedComment(gh.body),
      consoleMarkers: markers,
      htmlUrl: gh.html_url,
      ghCreatedAt: new Date(gh.created_at),
      ghUpdatedAt,
    })
    .onConflictDoUpdate({
      target: comments.ghNodeId,
      set: { body: gh.body, consoleMarkers: markers, ghUpdatedAt },
      setWhere: sql`${comments.ghUpdatedAt} <= ${ghUpdatedAt}`,
    });

  const commentRow = (await db.select({ id: comments.id }).from(comments).where(eq(comments.ghNodeId, gh.node_id)).limit(1))[0]!;

  // Thread classification (spec 06 §3). The epic whose workspace this lands in:
  const epicIssueId = issue.kind === "epic" ? issue.id : issue.parentIssueId;
  if (!epicIssueId) return;

  let topicRef: string;
  if (markers.thread) {
    topicRef = markers.thread;
  } else if (issue.kind === "task") {
    topicRef = `task/${issue.number}`;
  } else if (isApprovedComment(gh.body) || isAgentComment(gh.body)) {
    topicRef = GATE_THREAD_FOR_STATE[issue.factoryState ?? ""] ?? "inbox";
  } else {
    topicRef = "inbox";
  }

  const thread = await ensureThread(db, repo.orgId, epicIssueId, topicRef);
  await db
    .insert(threadEntries)
    .values({
      orgId: repo.orgId,
      threadId: thread,
      source: "gh_comment",
      commentId: commentRow.id,
      author: gh.user?.login ?? null,
      createdAt: new Date(gh.created_at),
    })
    .onConflictDoNothing({ target: threadEntries.commentId });

  // Decision recovery on rebuild (spec 06 §8): a decision marker with no
  // indexed decision row reconstructs a skeleton entry from the comment.
  if (markers.decision) {
    const existing = await db.select({ id: decisions.id }).from(decisions).where(eq(decisions.ghCommentNodeId, gh.node_id)).limit(1);
    if (existing.length === 0) {
      const title = gh.body.match(/^#+\s*(?:Decision:\s*)?(.+)$/m)?.[1]?.trim() ?? "Recovered decision";
      await db.insert(decisions).values({
        orgId: repo.orgId,
        epicIssueId,
        title,
        context: gh.body.slice(0, 4000),
        decidedBy: gh.user?.login ?? null,
        ghCommentNodeId: gh.node_id,
        status: "decided",
      });
    }
  }
}

export async function projectPull(db: Db, repo: RepoRef, gh: GhPull): Promise<void> {
  const { kind, issueNumber } = derivePrKind(gh.head.ref, gh.base.ref);
  const ghUpdatedAt = new Date(gh.updated_at);
  await db
    .insert(pullRequests)
    .values({
      orgId: repo.orgId,
      repoId: repo.id,
      ghNodeId: gh.node_id,
      number: gh.number,
      title: gh.title,
      kind,
      issueNumber,
      headRef: gh.head.ref,
      headSha: gh.head.sha,
      baseRef: gh.base.ref,
      state: gh.merged_at ? "merged" : gh.state,
      draft: gh.draft,
      mergedAt: gh.merged_at ? new Date(gh.merged_at) : null,
      mergeCommitSha: gh.merge_commit_sha,
      author: gh.user?.login ?? null,
      htmlUrl: gh.html_url,
      ghUpdatedAt,
    })
    .onConflictDoUpdate({
      target: pullRequests.ghNodeId,
      set: {
        title: gh.title,
        state: gh.merged_at ? "merged" : gh.state,
        draft: gh.draft,
        headSha: gh.head.sha,
        mergedAt: gh.merged_at ? new Date(gh.merged_at) : null,
        mergeCommitSha: gh.merge_commit_sha,
        ghUpdatedAt,
      },
      setWhere: sql`${pullRequests.ghUpdatedAt} <= ${ghUpdatedAt}`,
    });
}

const ROLE_FROM_TITLE = /\b(intake|planner|architect|dispatch|implementer|reviewer|qa|release|ops)\b/i;

export async function projectRun(db: Db, repo: RepoRef, gh: GhWorkflowRun): Promise<void> {
  const ghUpdatedAt = new Date(gh.updated_at);
  const role = gh.name?.match(ROLE_FROM_TITLE)?.[1]?.toLowerCase() ?? null;
  await db
    .insert(runs)
    .values({
      orgId: repo.orgId,
      repoId: repo.id,
      ghNodeId: gh.node_id,
      ghRunId: gh.id,
      workflowName: gh.name,
      role,
      triggerEvent: gh.event,
      status: gh.status,
      conclusion: gh.conclusion,
      headBranch: gh.head_branch,
      htmlUrl: gh.html_url,
      startedAt: gh.run_started_at ? new Date(gh.run_started_at) : new Date(gh.created_at),
      ghUpdatedAt,
    })
    .onConflictDoUpdate({
      target: runs.ghNodeId,
      set: { status: gh.status, conclusion: gh.conclusion, ghUpdatedAt },
      setWhere: sql`${runs.ghUpdatedAt} <= ${ghUpdatedAt}`,
    });

  // CI rollup: a completed run on a PR head branch updates that PR's ci_status.
  if (gh.head_branch && gh.status === "completed") {
    await db
      .update(pullRequests)
      .set({ ciStatus: gh.conclusion })
      .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.headRef, gh.head_branch), eq(pullRequests.state, "open")));
  }
}

/* ------------------------------- threads ------------------------------- */

const DEFAULT_EPIC_THREADS: Array<{ topicKind: string; topicRef: string; title: string }> = [
  { topicKind: "artifact", topicRef: "artifact/proposal", title: "Proposal" },
  { topicKind: "artifact", topicRef: "artifact/design", title: "Design" },
  { topicKind: "artifact", topicRef: "artifact/tasks", title: "Tasks (plan)" },
  { topicKind: "gate", topicRef: "gate/spec", title: "Gate G1 — spec" },
  { topicKind: "gate", topicRef: "gate/design", title: "Gate G2 — design" },
  { topicKind: "gate", topicRef: "gate/release", title: "Gate G3 — release" },
  { topicKind: "inbox", topicRef: "inbox", title: "Inbox" },
];

export async function ensureEpicThreads(db: Db, orgId: string, epicIssueId: string): Promise<void> {
  for (const t of DEFAULT_EPIC_THREADS) {
    await db
      .insert(threads)
      .values({ orgId, epicIssueId, ...t })
      .onConflictDoNothing({ target: [threads.epicIssueId, threads.topicRef] });
  }
}

export async function ensureThread(db: Db, orgId: string, epicIssueId: string, topicRef: string): Promise<string> {
  const known = DEFAULT_EPIC_THREADS.find((t) => t.topicRef === topicRef);
  const topicKind = known?.topicKind ?? (topicRef.startsWith("task/") ? "task" : topicRef.startsWith("artifact/") ? "artifact" : topicRef.startsWith("gate/") ? "gate" : "free");
  const title = known?.title ?? (topicRef.startsWith("task/") ? `Task #${topicRef.slice(5)}` : topicRef);
  await db
    .insert(threads)
    .values({ orgId, epicIssueId, topicKind, topicRef, title })
    .onConflictDoNothing({ target: [threads.epicIssueId, threads.topicRef] });
  const row = (
    await db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.epicIssueId, epicIssueId), eq(threads.topicRef, topicRef)))
      .limit(1)
  )[0]!;
  return row.id;
}
