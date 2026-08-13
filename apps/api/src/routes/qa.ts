import { decryptSecret } from "@console/core";
import { askInsight, type InsightSource } from "@console/insight";
import {
  artifactCache,
  changeArtifacts,
  changes,
  comments,
  issues,
  orgs,
  pullRequests,
  qaConversations,
  qaMessages,
  repos,
  runs,
} from "@console/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, type AppDeps, type RequestCtx } from "../context.js";
import { loadDependencies, loadEpic, loadIssue } from "./read.js";

/**
 * Ask the Factory (spec 06 §5): grounded, cited, budgeted, private by
 * default. Two scopes share one ask flow: the epic (workspace context rail)
 * and a single issue plus its one-hop dependency neighbourhood (peek drawer,
 * plan 07 §5) — the corpus differs, the guarantees do not. The insight
 * service receives an assembled context and holds no credentials.
 */
export function registerQaRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Params: { id: string } }>("/api/epics/:id/qa", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    return listConversations(deps, ctx, and(eq(qaConversations.epicIssueId, found.epic.id), isNull(qaConversations.scopeIssueId)));
  });

  app.get<{ Params: { id: string } }>("/api/issues/:id/qa", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadIssue(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "issue not found" });
    return listConversations(deps, ctx, eq(qaConversations.scopeIssueId, found.issue.id));
  });

  app.post<{ Params: { id: string }; Body: { question: string; conversationId?: string } }>(
    "/api/epics/:id/qa",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadEpic(deps, ctx, req.params.id);
      if (!found) return reply.code(404).send({ error: "epic not found" });
      const sources = await assembleEpicContext(deps, ctx, found.epic.id);
      return runAsk(deps, ctx, reply, {
        orgId: found.epic.orgId,
        epicIssueId: found.epic.id,
        scopeIssueId: null,
        sources,
        question: req.body?.question,
        conversationId: req.body?.conversationId,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { question: string; conversationId?: string } }>(
    "/api/issues/:id/qa",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadIssue(deps, ctx, req.params.id);
      if (!found) return reply.code(404).send({ error: "issue not found" });
      const { issue } = found;
      const sources = await assembleIssueContext(deps, ctx, issue);
      return runAsk(deps, ctx, reply, {
        orgId: issue.orgId,
        epicIssueId: issue.parentIssueId ?? issue.id,
        scopeIssueId: issue.id,
        sources,
        question: req.body?.question,
        conversationId: req.body?.conversationId,
      });
    },
  );
}

async function listConversations(deps: AppDeps, ctx: RequestCtx, where: ReturnType<typeof eq> | ReturnType<typeof and>) {
  const { db } = deps.dbh;
  const convs = await db
    .select()
    .from(qaConversations)
    .where(and(where, eq(qaConversations.userId, ctx.userId)))
    .orderBy(desc(qaConversations.createdAt));
  const out = [];
  for (const c of convs) {
    const msgs = await db.select().from(qaMessages).where(eq(qaMessages.conversationId, c.id)).orderBy(qaMessages.createdAt);
    out.push({
      id: c.id,
      visibility: c.visibility,
      messages: msgs.map((m) => ({ role: m.role, body: m.body, citations: m.citations, createdAt: m.createdAt })),
    });
  }
  const org = (await db.select().from(orgs).where(inArray(orgs.id, ctx.orgIds)).limit(1))[0];
  return {
    conversations: out,
    enabled: Boolean(deps.cfg.ANTHROPIC_API_KEY),
    budget: org ? { used: org.insightUsedTokens, total: org.insightBudgetTokens } : null,
  };
}

/** The one ask flow: budget gate, history replay, model call, persist, spend. */
async function runAsk(
  deps: AppDeps,
  ctx: RequestCtx,
  reply: FastifyReply,
  opts: {
    orgId: string;
    epicIssueId: string;
    scopeIssueId: string | null;
    sources: InsightSource[];
    question: string | undefined;
    conversationId: string | undefined;
  },
) {
  const { db } = deps.dbh;
  if (!deps.cfg.ANTHROPIC_API_KEY) {
    return reply.code(503).send({ error: "insight service is not configured (ANTHROPIC_API_KEY missing)" });
  }
  const question = opts.question?.trim();
  if (!question) return reply.code(400).send({ error: "question required" });

  // Per-org budget: a paid product shows its costs (spec 01 §5).
  const org = (await db.select().from(orgs).where(eq(orgs.id, opts.orgId)).limit(1))[0]!;
  if (org.insightUsedTokens >= org.insightBudgetTokens) {
    return reply
      .code(429)
      .send({ error: "org insight budget exhausted", budget: { used: org.insightUsedTokens, total: org.insightBudgetTokens } });
  }

  let conversationId = opts.conversationId ?? null;
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (conversationId) {
    const conv = (
      await db
        .select()
        .from(qaConversations)
        .where(and(eq(qaConversations.id, conversationId), eq(qaConversations.userId, ctx.userId)))
        .limit(1)
    )[0];
    if (!conv) return reply.code(404).send({ error: "conversation not found" });
    const msgs = await db.select().from(qaMessages).where(eq(qaMessages.conversationId, conv.id)).orderBy(qaMessages.createdAt);
    for (const m of msgs.slice(-10)) history.push({ role: m.role as "user" | "assistant", content: m.body });
  } else {
    conversationId = (
      await db
        .insert(qaConversations)
        .values({
          orgId: opts.orgId,
          epicIssueId: opts.epicIssueId,
          scopeIssueId: opts.scopeIssueId,
          userId: ctx.userId,
          visibility: "private",
        })
        .returning()
    )[0]!.id;
  }

  const result = await askInsight(
    { apiKey: deps.cfg.ANTHROPIC_API_KEY, model: deps.cfg.INSIGHT_DEEP_MODEL },
    opts.sources,
    history,
    question,
  );

  await db.insert(qaMessages).values({ orgId: opts.orgId, conversationId, role: "user", body: question });
  await db.insert(qaMessages).values({
    orgId: opts.orgId,
    conversationId,
    role: "assistant",
    body: result.answer,
    citations: result.citations,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });
  const spent = result.inputTokens + result.outputTokens;
  await db
    .update(orgs)
    .set({ insightUsedTokens: org.insightUsedTokens + spent })
    .where(eq(orgs.id, org.id));

  return {
    conversationId,
    answer: result.answer,
    citations: result.citations,
    cost: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, model: result.model },
    budget: { used: org.insightUsedTokens + spent, total: org.insightBudgetTokens },
  };
}

/** Context bounded to the epic's own surfaces — nothing cross-epic, nothing cross-tenant. */
export async function assembleEpicContext(deps: AppDeps, ctx: RequestCtx, epicId: string): Promise<InsightSource[]> {
  const { db } = deps.dbh;
  const sources: InsightSource[] = [];

  const epic = (await db.select().from(issues).where(and(eq(issues.id, epicId), inArray(issues.orgId, ctx.orgIds))).limit(1))[0];
  if (!epic) return sources;
  const repo = (await db.select().from(repos).where(eq(repos.id, epic.repoId)).limit(1))[0]!;

  sources.push({
    ref: `issue/${epic.number}`,
    kind: "comment",
    title: `Epic #${epic.number}: ${epic.title}`,
    content: epic.body ?? "(no body)",
  });

  sources.push(...(await artifactSources(deps, epic.id)));

  // Epic + task threads (recent comments).
  const taskIds = (await db.select({ id: issues.id, number: issues.number }).from(issues).where(eq(issues.parentIssueId, epic.id))).map(
    (t) => t.id,
  );
  const commentRows = await db
    .select()
    .from(comments)
    .where(inArray(comments.issueId, [epic.id, ...taskIds]))
    .orderBy(desc(comments.ghCreatedAt))
    .limit(60);
  if (commentRows.length > 0) {
    sources.push({
      ref: `thread/${epic.number}`,
      kind: "comment",
      title: "Recent thread comments (newest first)",
      content: commentRows
        .map((c) => `@${c.author ?? "?"}${c.isAgent ? " [agent]" : ""} (${c.ghCreatedAt.toISOString()}):\n${c.body}`)
        .join("\n\n---\n\n"),
    });
  }

  // PRs and runs, summarised.
  const prRows = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.issueNumber, epic.number)));
  const taskNumbers = (await db.select({ n: issues.number }).from(issues).where(eq(issues.parentIssueId, epic.id))).map((r) => r.n);
  const taskPrs = taskNumbers.length
    ? await db
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.repoId, repo.id), inArray(pullRequests.issueNumber, taskNumbers)))
    : [];
  const allPrs = [...prRows, ...taskPrs];
  if (allPrs.length > 0) sources.push(prSource(`prs/${epic.number}`, "Pull requests for this epic", allPrs));
  sources.push(...(await runSources(deps, repo.id, repo.fullName)));
  return sources;
}

const NEIGHBOUR_CAP = 8;

/**
 * Context for one issue plus its one-hop dependency neighbourhood (plan 07
 * §5): the focus issue's body and comments; each blocker's and dependent's
 * body, state and latest comments plus its PRs; the parent epic's cached
 * design/tasks artifacts; the repo's recent runs. Bounded: neighbours cap at
 * NEIGHBOUR_CAP newest-first with the omission stated in a final source, and
 * the insight service truncates every source besides.
 */
export async function assembleIssueContext(
  deps: AppDeps,
  ctx: RequestCtx,
  issue: typeof issues.$inferSelect,
): Promise<InsightSource[]> {
  const { db } = deps.dbh;
  const sources: InsightSource[] = [];
  const repo = (await db.select().from(repos).where(eq(repos.id, issue.repoId)).limit(1))[0]!;

  sources.push({
    ref: `issue/${issue.number}`,
    kind: "comment",
    title: `Issue #${issue.number}: ${issue.title} [${issue.factoryState ?? "no state"}]`,
    content: issue.body ?? "(no body)",
  });
  const focusComments = await db
    .select()
    .from(comments)
    .where(eq(comments.issueId, issue.id))
    .orderBy(desc(comments.ghCreatedAt))
    .limit(30);
  if (focusComments.length > 0) {
    sources.push({
      ref: `thread/${issue.number}`,
      kind: "comment",
      title: `Comments on #${issue.number} (newest first)`,
      content: focusComments
        .map((c) => `@${c.author ?? "?"}${c.isAgent ? " [agent]" : ""} (${c.ghCreatedAt.toISOString()}):\n${c.body}`)
        .join("\n\n---\n\n"),
    });
  }

  // One-hop neighbours, both directions, newest movement first.
  const depMap = await loadDependencies(deps, [issue.id]);
  const around = depMap.get(issue.id) ?? { blockedBy: [], blocks: [] };
  const neighbourIds = [
    ...around.blockedBy.map((n) => ({ id: n.id, relation: "blocks this issue" })),
    ...around.blocks.map((n) => ({ id: n.id, relation: "is blocked by this issue" })),
  ];
  const neighbourRows = neighbourIds.length
    ? await db
        .select()
        .from(issues)
        .where(and(inArray(issues.id, neighbourIds.map((n) => n.id)), inArray(issues.orgId, ctx.orgIds)))
        .orderBy(desc(issues.ghUpdatedAt))
    : [];
  const relationOf = new Map(neighbourIds.map((n) => [n.id, n.relation]));
  const included = neighbourRows.slice(0, NEIGHBOUR_CAP);
  for (const n of included) {
    const nComments = await db.select().from(comments).where(eq(comments.issueId, n.id)).orderBy(desc(comments.ghCreatedAt)).limit(10);
    const nPrs = await db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, n.repoId), eq(pullRequests.issueNumber, n.number)));
    const parts = [
      `State: ${n.factoryState ?? "none"} (${n.state}) — this issue ${relationOf.get(n.id)}.`,
      n.assignees.length > 0 ? `Assignees: ${n.assignees.map((a) => `@${a}`).join(", ")}` : null,
      n.body ? `Body:\n${n.body}` : null,
      nPrs.length > 0 ? nPrs.map((p) => `PR #${p.number} "${p.title}" — ${p.state}, CI: ${p.ciStatus ?? "unknown"}`).join("\n") : null,
      nComments.length > 0
        ? `Latest comments (newest first):\n${nComments.map((c) => `@${c.author ?? "?"}${c.isAgent ? " [agent]" : ""}: ${c.body}`).join("\n---\n")}`
        : null,
    ].filter(Boolean);
    sources.push({
      ref: `issue/${n.number}`,
      kind: "comment",
      title: `Dependency #${n.number}: ${n.title}`,
      content: parts.join("\n\n"),
    });
  }
  if (neighbourRows.length > included.length) {
    sources.push({
      ref: "deps/omitted",
      kind: "comment",
      title: "Coverage note",
      content: `${neighbourRows.length - included.length} more dependencies were omitted from this context (only the ${NEIGHBOUR_CAP} most recently updated are included).`,
    });
  }

  // The parent epic's plan artifacts ground "what has to happen" questions.
  if (issue.parentIssueId) sources.push(...(await artifactSources(deps, issue.parentIssueId, ["design", "tasks"])));

  const focusPrs = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.issueNumber, issue.number)));
  if (focusPrs.length > 0) sources.push(prSource(`prs/${issue.number}`, `Pull requests for #${issue.number}`, focusPrs));
  sources.push(...(await runSources(deps, repo.id, repo.fullName)));
  return sources;
}

/** Cached change-folder artifacts for an epic, optionally filtered by kind. */
async function artifactSources(deps: AppDeps, epicIssueId: string, kinds?: string[]): Promise<InsightSource[]> {
  const { db } = deps.dbh;
  const out: InsightSource[] = [];
  const change = (await db.select().from(changes).where(eq(changes.epicIssueId, epicIssueId)).limit(1))[0];
  if (!change) return out;
  const artifacts = await db.select().from(changeArtifacts).where(eq(changeArtifacts.changeId, change.id));
  for (const a of artifacts) {
    if (kinds && !kinds.includes(a.kind)) continue;
    const sha = a.latestSha ?? a.mergedSha;
    if (!sha) continue;
    const cached = (
      await db
        .select()
        .from(artifactCache)
        .where(and(eq(artifactCache.repoId, a.repoId), eq(artifactCache.path, a.path), eq(artifactCache.commitSha, sha)))
        .limit(1)
    )[0];
    if (cached) {
      out.push({
        ref: `${a.path}@${sha.slice(0, 7)}`,
        kind: "artifact",
        title: `${a.kind}: ${a.path}`,
        content: decryptSecret(cached.encryptedContent, deps.cfg.CONSOLE_MASTER_KEY),
      });
    }
  }
  return out;
}

function prSource(ref: string, title: string, prs: Array<typeof pullRequests.$inferSelect>): InsightSource {
  return {
    ref,
    kind: "pr",
    title,
    content: prs
      .map(
        (p) =>
          `PR #${p.number} [${p.kind}] "${p.title}" — ${p.state}${p.draft ? " (draft)" : ""}, CI: ${p.ciStatus ?? "unknown"}, ${p.headRef} -> ${p.baseRef}`,
      )
      .join("\n"),
  };
}

async function runSources(deps: AppDeps, repoId: string, repoFullName: string): Promise<InsightSource[]> {
  const { db } = deps.dbh;
  const runRows = await db.select().from(runs).where(eq(runs.repoId, repoId)).orderBy(desc(runs.startedAt)).limit(20);
  if (runRows.length === 0) return [];
  return [
    {
      ref: `runs/${repoFullName}`,
      kind: "run",
      title: "Recent factory workflow runs",
      content: runRows
        .map((r) => `${r.startedAt?.toISOString() ?? "?"} ${r.role ?? r.workflowName ?? "run"}: ${r.conclusion ?? r.status ?? "running"}`)
        .join("\n"),
    },
  ];
}
