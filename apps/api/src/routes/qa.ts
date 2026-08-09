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
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps, type RequestCtx } from "../context.js";
import { loadEpic } from "./read.js";

/**
 * Ask the Factory (spec 06 §5): grounded strictly in the epic's own material,
 * cited, budgeted, private by default. The insight service receives an
 * assembled context and holds no credentials — assembly happens here, inside
 * the tenant scope.
 */
export function registerQaRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get<{ Params: { id: string } }>("/api/epics/:id/qa", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const convs = await db
      .select()
      .from(qaConversations)
      .where(and(eq(qaConversations.epicIssueId, found.epic.id), eq(qaConversations.userId, ctx.userId)))
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
  });

  app.post<{ Params: { id: string }; Body: { question: string; conversationId?: string } }>(
    "/api/epics/:id/qa",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      if (!deps.cfg.ANTHROPIC_API_KEY) {
        return reply.code(503).send({ error: "insight service is not configured (ANTHROPIC_API_KEY missing)" });
      }
      const question = req.body?.question?.trim();
      if (!question) return reply.code(400).send({ error: "question required" });
      const found = await loadEpic(deps, ctx, req.params.id);
      if (!found) return reply.code(404).send({ error: "epic not found" });
      const { epic } = found;

      // Per-org budget: a paid product shows its costs (spec 01 §5).
      const org = (await db.select().from(orgs).where(eq(orgs.id, epic.orgId)).limit(1))[0]!;
      if (org.insightUsedTokens >= org.insightBudgetTokens) {
        return reply.code(429).send({ error: "org insight budget exhausted", budget: { used: org.insightUsedTokens, total: org.insightBudgetTokens } });
      }

      let conversationId = req.body.conversationId ?? null;
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
            .values({ orgId: epic.orgId, epicIssueId: epic.id, userId: ctx.userId, visibility: "private" })
            .returning()
        )[0]!.id;
      }

      const sources = await assembleContext(deps, ctx, epic.id);
      const result = await askInsight(
        { apiKey: deps.cfg.ANTHROPIC_API_KEY, model: deps.cfg.INSIGHT_DEEP_MODEL },
        sources,
        history,
        question,
      );

      await db.insert(qaMessages).values({
        orgId: epic.orgId,
        conversationId,
        role: "user",
        body: question,
      });
      await db.insert(qaMessages).values({
        orgId: epic.orgId,
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
    },
  );
}

/** Context bounded to the epic's own surfaces — nothing cross-epic, nothing cross-tenant. */
async function assembleContext(deps: AppDeps, ctx: RequestCtx, epicId: string): Promise<InsightSource[]> {
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

  // Change-folder artifacts at their freshest cached ref.
  const change = (await db.select().from(changes).where(eq(changes.epicIssueId, epic.id)).limit(1))[0];
  if (change) {
    const artifacts = await db.select().from(changeArtifacts).where(eq(changeArtifacts.changeId, change.id));
    for (const a of artifacts) {
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
        sources.push({
          ref: `${a.path}@${sha.slice(0, 7)}`,
          kind: "artifact",
          title: `${a.kind}: ${a.path}`,
          content: decryptSecret(cached.encryptedContent, deps.cfg.CONSOLE_MASTER_KEY),
        });
      }
    }
  }

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
  if (allPrs.length > 0) {
    sources.push({
      ref: `prs/${epic.number}`,
      kind: "pr",
      title: "Pull requests for this epic",
      content: allPrs
        .map((p) => `PR #${p.number} [${p.kind}] "${p.title}" — ${p.state}${p.draft ? " (draft)" : ""}, CI: ${p.ciStatus ?? "unknown"}, ${p.headRef} -> ${p.baseRef}`)
        .join("\n"),
    });
  }

  const runRows = await db.select().from(runs).where(eq(runs.repoId, repo.id)).orderBy(desc(runs.startedAt)).limit(20);
  if (runRows.length > 0) {
    sources.push({
      ref: `runs/${repo.fullName}`,
      kind: "run",
      title: "Recent factory workflow runs",
      content: runRows
        .map((r) => `${r.startedAt?.toISOString() ?? "?"} ${r.role ?? r.workflowName ?? "run"}: ${r.conclusion ?? r.status ?? "running"}`)
        .join("\n"),
    });
  }

  return sources;
}
