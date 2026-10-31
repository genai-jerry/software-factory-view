import { decisionMarker, threadMarker } from "@console/core";
import { auditLog, comments, decisions, issues, repos, threadEntries, threads } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps } from "../context.js";
import {
  EXPEDITE_LABEL,
  EXPEDITE_OFF_ACTION,
  EXPEDITE_ON_ACTION,
  expediteAvailability,
} from "../expedite.js";
import { postComment, writeLabel } from "../gh-write.js";
import { THREAD_INSTRUCTIONS } from "@console/insight";
import { askOrchestrator } from "../orchestrator-dispatch.js";
import { readRetainedAgentSecrets } from "../orchestrator-secrets.js";
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
        const number = Number(taskMatch[1]);
        // By the parent link, not by the epic's repo: a cross-repo epic
        // (FACTORY.md §7) keeps its sub-issues in the repos that implement
        // them, so #<number> is very often not in the epic's repo at all —
        // and when a repo does happen to have an issue with that number it is
        // an unrelated one. The projector sets `parentIssueId` for every task
        // it files, and only a task with that link ever gets a `task/N`
        // thread, so this is the same link the thread was created from.
        // Every other reader of an epic's tasks already resolves them this
        // way; this route was the one that did not.
        const candidates = await db
          .select()
          .from(issues)
          .where(and(eq(issues.parentIssueId, epic.id), eq(issues.number, number)));
        if (candidates.length > 1) {
          // One `task/N` thread, two repos holding a task numbered N under
          // this epic. The thread cannot say which is meant (its topicRef
          // carries no repo), so neither can this route — and picking one
          // would post a human's approval on the wrong issue.
          return reply.code(409).send({
            error: `#${number} is ambiguous — more than one repo in this epic has a task with that number. Reply on the task issue in GitHub instead.`,
          });
        }
        const task = candidates[0];
        // Never fall back to the epic. Posting a task reply onto the epic is
        // silently wrong twice over: the reply shows up in this thread (its
        // marker puts it there) while the task issue never sees it, and an
        // `Approved` meant for one task reads as a gate approval on the epic.
        if (!task) {
          return reply.code(404).send({
            error: `task #${number} of this epic is not in the Console yet — nothing to post to. Reply on the task issue in GitHub instead.`,
          });
        }
        targetIssue = task;
      }
      const repo = (await db.select().from(repos).where(eq(repos.id, targetIssue.repoId)).limit(1))[0]!;
      const [owner, name] = repo.fullName.split("/") as [string, string];

      const marked = `${body}\n\n${threadMarker(thread.topicRef)}`;
      const comment = await postComment(deps, ctx, reply, owner, name, targetIssue.number, marked);
      if (!comment) return;

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

  /**
   * Ask the factory a question about this thread. The orchestrator answers
   * with its Claude CLI (the subscription token cannot call the API) from a
   * read-only checkout; the question and the answer are saved in the thread as
   * Console-only entries — nothing is posted to GitHub.
   */
  app.post<{ Params: { id: string }; Body: { question?: string } }>("/api/threads/:id/ask", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const question = req.body?.question?.trim() ?? "";
    if (!question) return reply.code(400).send({ error: "question required" });
    if (question.length > 2000) return reply.code(400).send({ error: "the question is over 2000 characters" });

    const thread = (
      await db.select().from(threads).where(and(eq(threads.id, req.params.id), inArray(threads.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!thread) return reply.code(404).send({ error: "thread not found" });
    const epic = (await db.select().from(issues).where(eq(issues.id, thread.epicIssueId)).limit(1))[0];
    if (!epic) return reply.code(404).send({ error: "epic gone" });

    // The repo the question is about: a task thread's own task, which for a
    // cross-repo epic is not the epic's repo (same lookup as posting a reply).
    let target = epic;
    const taskMatch = thread.topicRef.match(/^task\/(\d+)$/);
    if (taskMatch) {
      const found = await db
        .select()
        .from(issues)
        .where(and(eq(issues.parentIssueId, epic.id), eq(issues.number, Number(taskMatch[1]))));
      if (found.length === 1) target = found[0]!;
    }
    const repo = (await db.select().from(repos).where(eq(repos.id, target.repoId)).limit(1))[0]!;
    const [owner, name] = repo.fullName.split("/") as [string, string];

    // The conversation so far, oldest first, newest kept when it is long.
    const rows = await db
      .select({ entry: threadEntries, comment: comments })
      .from(threadEntries)
      .leftJoin(comments, eq(comments.id, threadEntries.commentId))
      .where(eq(threadEntries.threadId, thread.id))
      .orderBy(threadEntries.createdAt);
    const context = rows
      .map(({ entry, comment }) => {
        const who = comment?.isAgent ? "[agent]" : `@${entry.author ?? comment?.author ?? "?"}`;
        return `${who} ${(comment?.body ?? entry.body ?? "").trim()}`;
      })
      .join("\n\n---\n\n")
      .slice(-24_000);

    const secrets = await readRetainedAgentSecrets(deps, thread.orgId);
    const got = await askOrchestrator(deps.cfg, {
      owner,
      repo: name,
      question,
      context,
      instructions: THREAD_INSTRUCTIONS,
      branch: `factory/epic-${epic.number}`,
      anthropicApiKey: secrets.anthropicApiKey,
      claudeCodeOauthToken: secrets.claudeCodeOauthToken,
    });
    if ("error" in got) return reply.code(got.status === 429 ? 429 : 502).send({ error: got.error });

    await db.insert(threadEntries).values([
      { orgId: thread.orgId, threadId: thread.id, source: "ask_question", body: question, author: ctx.login },
      { orgId: thread.orgId, threadId: thread.id, source: "ask_answer", body: got.answer, author: "factory" },
    ]);
    await db.insert(auditLog).values({
      orgId: thread.orgId,
      actorUserId: ctx.userId,
      action: "thread.ask",
      target: `${repo.fullName}#${target.number}`,
      payload: { threadId: thread.id, model: got.model },
    });
    return { ok: true };
  });

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
    const comment = await postComment(deps, ctx, reply, owner, name, issue.number, body);
    if (!comment) return;
    await db.insert(auditLog).values({
      orgId: issue.orgId,
      actorUserId: ctx.userId,
      action: "blocked.reply",
      target: `${repo.fullName}#${issue.number}`,
      payload: { commentNodeId: comment.node_id, commentUrl: comment.html_url },
    });
    return { ok: true, commentUrl: comment.html_url };
  });

  /**
   * The expedite toggle: apply or remove `factory:expedite` on an epic.
   *
   * A label write, not a comment — but the same discipline as every other
   * authoritative act here: it goes out on the acting user's OAuth token, so
   * GitHub records the human who asked for it and the factory can check them
   * against its own list (it reverts an application it does not accept, and
   * says why on the epic). The Console never applies this as the App.
   *
   * The state is the label; nothing is stored locally. The audit row is what
   * lets the workspace say who flipped it and when — including the case where
   * the factory has since taken the marker back off.
   */
  app.post<{ Params: { id: string }; Body: { on?: boolean } }>("/api/epics/:id/expedite", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const { epic, repo } = found;
    const on = req.body?.on !== false;

    const availability = expediteAvailability(epic);
    if (!availability.available) return reply.code(409).send({ error: availability.reason ?? "expedite is not available here" });
    // Turning on what is already on would post a no-op label write; turning off
    // what is already off is the same. Answer with the state rather than
    // pretending something happened.
    if (availability.on === on) return { ok: true, on, changed: false };

    const [owner, name] = repo.fullName.split("/") as [string, string];
    if (!(await writeLabel(deps, ctx, reply, owner, name, epic.number, EXPEDITE_LABEL, on ? "add" : "remove"))) return;

    await db.insert(auditLog).values({
      orgId: epic.orgId,
      actorUserId: ctx.userId,
      action: on ? EXPEDITE_ON_ACTION : EXPEDITE_OFF_ACTION,
      target: `${repo.fullName}#${epic.number}`,
      payload: { actor: ctx.login, label: EXPEDITE_LABEL, dormant: availability.dormant },
    });
    // The labels column is refreshed by the webhook projection like any other
    // GitHub fact; write it here too so the workspace refetch that follows this
    // response does not draw the toggle back in its old position for the length
    // of the round trip. Same row, written earlier.
    await db
      .update(issues)
      .set({ labels: on ? [...new Set([...epic.labels, EXPEDITE_LABEL])] : epic.labels.filter((l) => l !== EXPEDITE_LABEL) })
      .where(eq(issues.id, epic.id));

    return { ok: true, on, changed: true };
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
      `Decided by @${ctx.login} via Compass.`,
      ...(req.body.supersedesId ? [`Supersedes decision \`${req.body.supersedesId}\`.`] : []),
      "",
      decisionMarker(row.id),
    ];
    const [owner, name] = repo.fullName.split("/") as [string, string];
    const comment = await postComment(deps, ctx, reply, owner, name, epic.number, lines.join("\n"));
    if (!comment) return;

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
