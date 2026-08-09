import { decisionMarker, threadMarker } from "@console/core";
import { auditLog, comments, decisions, issues, repos, threadEntries, threads } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, userClient, type AppDeps } from "../context.js";
import { loadEpic } from "./read.js";

/**
 * Thread, decision and blocked-reply writes. Everything that reaches GitHub
 * goes out under the acting user's token as an ordinary comment carrying a
 * hidden marker — non-Console users see a normal conversation (spec 06 §3).
 */
export function registerWriteRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  /** Post into a thread: a GitHub comment (round-tripped) or a private console note. */
  app.post<{ Params: { id: string }; Body: { body: string; privateNote?: boolean } }>(
    "/api/threads/:id/entries",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const body = req.body?.body?.trim();
      if (!body) return reply.code(400).send({ error: "body required" });

      const thread = (
        await db.select().from(threads).where(and(eq(threads.id, req.params.id), inArray(threads.orgId, ctx.orgIds))).limit(1)
      )[0];
      if (!thread) return reply.code(404).send({ error: "thread not found" });

      if (req.body.privateNote) {
        const entry = (
          await db
            .insert(threadEntries)
            .values({ orgId: thread.orgId, threadId: thread.id, source: "console_note", body, author: ctx.login })
            .returning()
        )[0]!;
        return { ok: true, entryId: entry.id, posted: false };
      }

      // Task threads post to the task issue (mirroring its own stream); others post to the epic.
      const epic = (await db.select().from(issues).where(eq(issues.id, thread.epicIssueId)).limit(1))[0];
      if (!epic) return reply.code(404).send({ error: "epic gone" });
      let targetIssue = epic;
      const taskMatch = thread.topicRef.match(/^task\/(\d+)$/);
      if (taskMatch) {
        const task = (
          await db
            .select()
            .from(issues)
            .where(and(eq(issues.repoId, epic.repoId), eq(issues.number, Number(taskMatch[1]))))
            .limit(1)
        )[0];
        if (task) targetIssue = task;
      }
      const repo = (await db.select().from(repos).where(eq(repos.id, targetIssue.repoId)).limit(1))[0]!;
      const [owner, name] = repo.fullName.split("/") as [string, string];

      const gh = userClient(deps, ctx);
      const marked = `${body}\n\n${threadMarker(thread.topicRef)}`;
      const comment = await gh.createComment(owner, name, targetIssue.number, marked);

      await db.insert(auditLog).values({
        orgId: thread.orgId,
        actorUserId: ctx.userId,
        action: "thread.post",
        target: `${repo.fullName}#${targetIssue.number}`,
        payload: { threadId: thread.id, commentNodeId: comment.node_id, commentUrl: comment.html_url },
      });
      // The webhook will project the comment and attach it via its marker; no
      // local write of the comment itself (projections mirror GitHub only).
      return { ok: true, posted: true, commentUrl: comment.html_url };
    },
  );

  app.post<{ Params: { id: string }; Body: { status: "open" | "resolved" } }>("/api/threads/:id/status", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const thread = (
      await db.select().from(threads).where(and(eq(threads.id, req.params.id), inArray(threads.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!thread) return reply.code(404).send({ error: "thread not found" });
    const status = req.body?.status === "resolved" ? "resolved" : "open";
    await db.update(threads).set({ status }).where(eq(threads.id, thread.id));
    return { ok: true, status };
  });

  /** File an inbox comment into a thread — thread metadata only, no comment editing. */
  app.post<{ Params: { id: string }; Body: { threadId: string } }>("/api/comments/:id/file", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const comment = (
      await db.select().from(comments).where(and(eq(comments.id, req.params.id), inArray(comments.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!comment) return reply.code(404).send({ error: "comment not found" });
    const target = (
      await db.select().from(threads).where(and(eq(threads.id, req.body.threadId), inArray(threads.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!target) return reply.code(404).send({ error: "target thread not found" });
    await db.update(threadEntries).set({ threadId: target.id }).where(eq(threadEntries.commentId, comment.id));
    return { ok: true };
  });

  /** Reply to a blocked issue — an ordinary human comment; the factory's own trigger clears the state. */
  app.post<{ Params: { id: string }; Body: { body: string } }>("/api/issues/:id/reply", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const body = req.body?.body?.trim();
    if (!body) return reply.code(400).send({ error: "body required" });
    const issue = (
      await db.select().from(issues).where(and(eq(issues.id, req.params.id), inArray(issues.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!issue) return reply.code(404).send({ error: "issue not found" });
    const repo = (await db.select().from(repos).where(eq(repos.id, issue.repoId)).limit(1))[0]!;
    const [owner, name] = repo.fullName.split("/") as [string, string];
    const gh = userClient(deps, ctx);
    const comment = await gh.createComment(owner, name, issue.number, body);
    await db.insert(auditLog).values({
      orgId: issue.orgId,
      actorUserId: ctx.userId,
      action: "blocked.reply",
      target: `${repo.fullName}#${issue.number}`,
      payload: { commentNodeId: comment.node_id, commentUrl: comment.html_url },
    });
    return { ok: true, commentUrl: comment.html_url };
  });

  /** Create a decision: structured comment on the epic + index row. */
  app.post<{
    Params: { id: string };
    Body: { title: string; context?: string; options?: string[]; chosen?: string; consequences?: string; supersedesId?: string };
  }>("/api/epics/:id/decisions", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const { epic, repo } = found;
    const title = req.body?.title?.trim();
    if (!title) return reply.code(400).send({ error: "title required" });

    const row = (
      await db
        .insert(decisions)
        .values({
          orgId: epic.orgId,
          epicIssueId: epic.id,
          title,
          context: req.body.context ?? null,
          options: req.body.options ?? [],
          chosen: req.body.chosen ?? null,
          consequences: req.body.consequences ?? null,
          decidedBy: ctx.login,
          supersedesId: req.body.supersedesId ?? null,
          status: "decided",
        })
        .returning()
    )[0]!;

    const lines = [
      `### Decision: ${title}`,
      "",
      ...(req.body.context ? ["**Context**", req.body.context, ""] : []),
      ...(req.body.options?.length ? ["**Options considered**", ...req.body.options.map((o) => `- ${o}`), ""] : []),
      ...(req.body.chosen ? ["**Chosen**", req.body.chosen, ""] : []),
      ...(req.body.consequences ? ["**Consequences**", req.body.consequences, ""] : []),
      `Decided by @${ctx.login} via Factory Console.`,
      ...(req.body.supersedesId ? [`Supersedes decision \`${req.body.supersedesId}\`.`] : []),
      "",
      decisionMarker(row.id),
    ];
    const [owner, name] = repo.fullName.split("/") as [string, string];
    const gh = userClient(deps, ctx);
    const comment = await gh.createComment(owner, name, epic.number, lines.join("\n"));

    await db.update(decisions).set({ ghCommentNodeId: comment.node_id }).where(eq(decisions.id, row.id));
    if (req.body.supersedesId) {
      await db
        .update(decisions)
        .set({ status: "superseded" })
        .where(and(eq(decisions.id, req.body.supersedesId), eq(decisions.orgId, epic.orgId)));
    }
    await db.insert(auditLog).values({
      orgId: epic.orgId,
      actorUserId: ctx.userId,
      action: "decision.create",
      target: `${repo.fullName}#${epic.number}`,
      payload: { decisionId: row.id, commentNodeId: comment.node_id, commentUrl: comment.html_url },
    });
    return { ok: true, decisionId: row.id, commentUrl: comment.html_url };
  });
}
