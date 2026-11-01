import { sourcesBlock } from "@console/insight";
import { issues, repos, shapeAttachments, shapeConversations, shapeMessages } from "@console/db";
import { and, asc, desc, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@console/db";
import { requireAuth, type AppDeps, type RequestCtx } from "../context.js";
import { askOrchestrator } from "../orchestrator-dispatch.js";
import { renderMarkdown } from "../render.js";
import { SHAPE_INSTRUCTIONS, SPEC_INSTRUCTIONS } from "../shape-prompts.js";
import { openWorkIssue } from "./activity.js";
import { artifactSources, claudeTokenFor } from "./qa.js";

/**
 * Shape — a conversation that turns an idea into work. A person picks the
 * repository the chat may read, talks in text and screenshots, asks for a
 * page or a change to be visualised (the answer carries a self-contained
 * HTML mock), then has the conversation written up as a requirement and
 * opened as a GitHub issue with `factory:intake` — the same door as Add work.
 *
 * The answers come from the orchestrator's read-only Claude session in a
 * checkout of the repo (POST /ask), as Ask does; images ride along for its
 * Read tool. Conversations are private to their author.
 *
 * A fresh idea runs against the latest default branch of its repository,
 * with the project's other repositories checked out beside it. An idea about
 * an epic runs on the epic's branch, with its documents (proposal, specs,
 * design, tasks, test plan) in front of the session — the Ask panel's
 * grounding, in a conversation that can also draw and write the requirement.
 */

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 50_000;
/** The whole context the orchestrator receives: documents first, then the transcript. */
const MAX_TOTAL_CONTEXT = 60_000;
/** How long a Claude session is resumed before the next message starts cold again. */
const SESSION_TTL_MS = 24 * 60 * 60_000;
const MAX_DOC_CHARS = 6_000;
const MAX_SIBLINGS = 8;
const MAX_MOCK_CHARS = 200_000;
const NO_CLAUDE = "Shape needs the factory's Claude sign-in. Store it in Settings.";
/** A pending answer older than this is one the process lost (a restart mid-call). */
const STALE_AFTER_MS = 15 * 60_000;
const LOST = "The answer was lost, probably in a restart. Send it again.";
const LOST_SPEC = "Writing the requirement was interrupted, probably by a restart. Try again.";

type Conversation = typeof shapeConversations.$inferSelect;
type Message = typeof shapeMessages.$inferSelect;

/**
 * The answers being written right now. An answer runs after the 202 has gone
 * back, so nothing holds the HTTP request open while Claude reads the repo
 * (nginx cut those off at 60 s); tests await this set to see the outcome.
 */
export const pendingAnswers = new Set<Promise<void>>();

function track(work: Promise<void>): void {
  const p = work.catch(() => undefined).finally(() => pendingAnswers.delete(p));
  pendingAnswers.add(p);
}

/** Wait for every answer in flight — for tests, and for a graceful stop. */
export async function settlePendingAnswers(): Promise<void> {
  while (pendingAnswers.size > 0) await Promise.all([...pendingAnswers]);
}

/**
 * Mark work the process lost as failed: a pending answer or requirement
 * older than 15 minutes was started by a process that is gone. Run at start
 * and before a conversation is read, so a reader is never shown a spinner
 * that nothing will ever stop.
 */
export async function settleStale(db: Db, conversationId?: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  await db
    .update(shapeMessages)
    .set({ status: "failed", error: LOST })
    .where(and(eq(shapeMessages.status, "pending"), lt(shapeMessages.createdAt, cutoff), ...(conversationId ? [eq(shapeMessages.conversationId, conversationId)] : [])));
  await db
    .update(shapeConversations)
    .set({ specStatus: "failed", specError: LOST_SPEC })
    .where(
      and(
        eq(shapeConversations.specStatus, "pending"),
        lt(shapeConversations.updatedAt, cutoff),
        ...(conversationId ? [eq(shapeConversations.id, conversationId)] : []),
      ),
    );
}

/** Split an answer into its prose and the ```html mocks it carried. */
export function splitMocks(body: string): { text: string; mocks: Array<{ html: string }> } {
  const mocks: Array<{ html: string }> = [];
  const text = body.replace(/```html[ \t]*\n([\s\S]*?)```/g, (_m, inner: string) => {
    mocks.push({ html: inner.slice(0, MAX_MOCK_CHARS) });
    return `*(Mock ${mocks.length} — shown below.)*`;
  });
  return { text: text.trim(), mocks };
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "New idea";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

function messageDto(m: Message) {
  const { text, mocks } = m.role === "assistant" ? splitMocks(m.body) : { text: m.body, mocks: [] };
  return {
    id: m.id,
    role: m.role,
    body: m.body,
    bodyHtml: renderMarkdown(text),
    mocks,
    attachments: (m.attachments ?? []).map((a) => ({ ...a, url: `/api/shape/attachments/${a.id}` })),
    status: m.status,
    error: m.error,
    createdAt: m.createdAt,
  };
}

/** The conversation as "Person:/You:" turns, oldest trimmed to fit the budget. */
function transcript(messages: Message[], budget = MAX_CONTEXT_CHARS): string {
  const turns = messages.filter((m) => m.role === "user" || m.status === "done").map((m) => `${m.role === "user" ? "Person" : "You"}: ${m.body}`);
  let out = turns.join("\n\n");
  while (out.length > budget && turns.length > 1) {
    turns.shift();
    out = `(earlier turns trimmed)\n\n${turns.join("\n\n")}`;
  }
  return out;
}

type EpicRef = { id: string; number: number; title: string; state: string | null; repoId: string };

export function registerShapeRoutes(app: FastifyInstance, deps: AppDeps): void {
  const db = deps.dbh.db;
  // Work a previous process left pending is lost; say so rather than spin.
  settleStale(db).catch((err: unknown) => app.log.warn({ err }, "could not settle stale Shape work"));

  async function epicRef(epicIssueId: string | null): Promise<EpicRef | null> {
    if (!epicIssueId) return null;
    const row = (
      await db
        .select({ id: issues.id, number: issues.number, title: issues.title, state: issues.factoryState, repoId: issues.repoId })
        .from(issues)
        .where(eq(issues.id, epicIssueId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  function epicDto(e: EpicRef | null) {
    return e ? { id: e.id, number: e.number, title: e.title, state: e.state } : null;
  }

  /** The project's other factory-enabled repositories, checked out beside the primary one. */
  async function siblings(repoId: string, projectId: string | null, branch: string | null) {
    if (!projectId) return [];
    const rows = await db
      .select({ fullName: repos.fullName })
      .from(repos)
      .where(and(eq(repos.projectId, projectId), eq(repos.factoryEnabled, true), ne(repos.id, repoId), isNotNull(repos.projectId)))
      .orderBy(repos.fullName)
      .limit(MAX_SIBLINGS);
    return rows.map((r) => {
      const [owner, repo] = r.fullName.split("/") as [string, string];
      return { owner, repo, branch };
    });
  }

  /**
   * What the session sees besides the question: the epic's documents when
   * the idea is about one (each trimmed), then the transcript in what budget
   * is left. The documents are what Ask grounds in; the transcript is what
   * Shape adds.
   */
  async function grounding(conv: Conversation, epic: EpicRef | null, messages: Message[], header: string): Promise<string> {
    let docs = "";
    if (epic) {
      const sources = (await artifactSources(deps, epic.id)).map((s) => ({ ...s, content: s.content.slice(0, MAX_DOC_CHARS) }));
      if (sources.length > 0) docs = `The epic's documents:\n\n${sourcesBlock(sources)}`;
    }
    const budget = Math.max(8_000, MAX_TOTAL_CONTEXT - header.length - docs.length - 200);
    const turns = messages.length ? `Earlier in this conversation:\n\n${transcript(messages, budget)}` : "(the conversation starts here)";
    return [header, docs, turns].filter(Boolean).join("\n\n");
  }

  function branchOf(epic: EpicRef | null): string | null {
    return epic ? `factory/epic-${epic.number}` : null;
  }

  async function own(
    ctx: RequestCtx,
    id: string,
    reply: FastifyReply,
  ): Promise<(Conversation & { repoFullName: string; projectId: string | null }) | null> {
    const row = (
      await db
        .select({ conv: shapeConversations, repoFullName: repos.fullName, projectId: repos.projectId })
        .from(shapeConversations)
        .innerJoin(repos, eq(repos.id, shapeConversations.repoId))
        .where(and(eq(shapeConversations.id, id), eq(shapeConversations.userId, ctx.userId), inArray(shapeConversations.orgId, ctx.orgIds)))
        .limit(1)
    )[0];
    if (!row) {
      void reply.code(404).send({ error: "conversation not found" });
      return null;
    }
    return { ...row.conv, repoFullName: row.repoFullName, projectId: row.projectId };
  }

  async function messagesOf(conversationId: string): Promise<Message[]> {
    return db.select().from(shapeMessages).where(eq(shapeMessages.conversationId, conversationId)).orderBy(asc(shapeMessages.createdAt));
  }

  app.get<{ Querystring: { repoId?: string; epicId?: string } }>("/api/shape", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const rows = await db
      .select({ conv: shapeConversations, repo: repos.fullName, epicNumber: issues.number, epicTitle: issues.title, epicState: issues.factoryState })
      .from(shapeConversations)
      .innerJoin(repos, eq(repos.id, shapeConversations.repoId))
      .leftJoin(issues, eq(issues.id, shapeConversations.epicIssueId))
      .where(
        and(
          eq(shapeConversations.userId, ctx.userId),
          inArray(shapeConversations.orgId, ctx.orgIds),
          ...(req.query.repoId ? [eq(shapeConversations.repoId, req.query.repoId)] : []),
          ...(req.query.epicId ? [eq(shapeConversations.epicIssueId, req.query.epicId)] : []),
        ),
      )
      .orderBy(desc(shapeConversations.updatedAt));
    return {
      conversations: rows.map(({ conv, repo, epicNumber, epicTitle, epicState }) => ({
        id: conv.id,
        title: conv.title,
        repo,
        repoId: conv.repoId,
        updatedAt: conv.updatedAt,
        hasSpec: Boolean(conv.spec),
        issueUrl: conv.issueUrl,
        epic: conv.epicIssueId && epicNumber !== null ? { id: conv.epicIssueId, number: epicNumber, title: epicTitle ?? "", state: epicState } : null,
      })),
    };
  });

  app.post<{ Body: { repoId?: string; epicId?: string; title?: string } }>("/api/shape", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    // About an epic: the repository is the epic's own, and the title starts as the epic's.
    let epic: EpicRef | null = null;
    let repoId = req.body?.repoId ?? "";
    if (req.body?.epicId) {
      const e = (
        await db
          .select({ id: issues.id, number: issues.number, title: issues.title, state: issues.factoryState, repoId: issues.repoId })
          .from(issues)
          .where(and(eq(issues.id, req.body.epicId), inArray(issues.orgId, ctx.orgIds)))
          .limit(1)
      )[0];
      if (!e) return reply.code(404).send({ error: "epic not found" });
      epic = e;
      repoId = e.repoId;
    }
    const repo = (await db.select().from(repos).where(and(eq(repos.id, repoId), inArray(repos.orgId, ctx.orgIds))).limit(1))[0];
    if (!repo) return reply.code(404).send({ error: "repository not found" });
    const title = req.body?.title?.trim() || (epic ? `About: ${epic.title}` : "New idea");
    const row = (
      await db
        .insert(shapeConversations)
        .values({ orgId: repo.orgId, userId: ctx.userId, repoId: repo.id, title, epicIssueId: epic?.id ?? null })
        .returning()
    )[0]!;
    return { id: row.id };
  });

  app.get<{ Params: { id: string } }>("/api/shape/:id", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    await settleStale(db, conv.id);
    // An idea opened as work becomes about that epic once the webhook has
    // projected the issue — a little after the issue was created.
    if (conv.issueUrl && !conv.epicIssueId) {
      const number = Number(/\/issues\/(\d+)\s*$/.exec(conv.issueUrl)?.[1]);
      const found = number
        ? (await db.select({ id: issues.id }).from(issues).where(and(eq(issues.repoId, conv.repoId), eq(issues.number, number))).limit(1))[0]
        : undefined;
      if (found) {
        await db.update(shapeConversations).set({ epicIssueId: found.id, issueId: found.id }).where(eq(shapeConversations.id, conv.id));
        conv.epicIssueId = found.id;
        conv.issueId = found.id;
      }
    }
    const epic = await epicRef(conv.epicIssueId);
    const messages = await messagesOf(conv.id);
    return {
      conversation: {
        id: conv.id,
        title: conv.title,
        repoId: conv.repoId,
        repo: conv.repoFullName,
        spec: conv.spec,
        specUpdatedAt: conv.specUpdatedAt,
        specStatus: conv.specStatus,
        specError: conv.specError,
        issueUrl: conv.issueUrl,
        issueId: conv.issueId,
        epic: epicDto(epic),
      },
      messages: messages.map(messageDto),
    };
  });

  app.delete<{ Params: { id: string } }>("/api/shape/:id", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    await db.delete(shapeConversations).where(eq(shapeConversations.id, conv.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { name?: string; mime?: string; dataB64?: string } }>(
    "/api/shape/:id/attachments",
    { bodyLimit: 8 * 1024 * 1024 },
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const conv = await own(ctx, req.params.id, reply);
      if (!conv) return;
      const mime = (req.body?.mime ?? "").toLowerCase();
      if (!IMAGE_MIMES.has(mime)) return reply.code(400).send({ error: "only PNG, JPEG, GIF and WebP images can be attached" });
      const dataB64 = (req.body?.dataB64 ?? "").replace(/^data:[^,]*,/, "").trim();
      if (!dataB64) return reply.code(400).send({ error: "the image is empty" });
      const size = Buffer.from(dataB64, "base64").length;
      if (size === 0) return reply.code(400).send({ error: "the image is empty" });
      if (size > MAX_ATTACHMENT_BYTES) return reply.code(413).send({ error: "an image can be at most 5 MB" });
      const name = (req.body?.name ?? "image").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "image";
      const row = (
        await db.insert(shapeAttachments).values({ orgId: conv.orgId, conversationId: conv.id, name, mime, bytesB64: dataB64, size }).returning()
      )[0]!;
      return { id: row.id, name: row.name, mime: row.mime, url: `/api/shape/attachments/${row.id}` };
    },
  );

  app.get<{ Params: { id: string } }>("/api/shape/attachments/:id", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const row = (
      await db
        .select({ att: shapeAttachments })
        .from(shapeAttachments)
        .innerJoin(shapeConversations, eq(shapeConversations.id, shapeAttachments.conversationId))
        .where(and(eq(shapeAttachments.id, req.params.id), eq(shapeConversations.userId, ctx.userId)))
        .limit(1)
    )[0];
    if (!row) return reply.code(404).send({ error: "attachment not found" });
    reply.header("content-type", row.att.mime);
    reply.header("cache-control", "private, max-age=86400");
    return reply.send(Buffer.from(row.att.bytesB64, "base64"));
  });

  type Attachment = typeof shapeAttachments.$inferSelect;
  type Owned = Conversation & { repoFullName: string; projectId: string | null };

  /**
   * Answer one user message into its pending assistant row. Runs after the
   * 202 has gone back: a success fills the row and keeps the session to
   * resume; a failure marks the row failed with the plain reason, and the
   * person's question stays in the thread for a retry.
   */
  async function answer(conv: Owned, assistantId: string, text: string, attachments: Attachment[], earlier: Message[], claudeToken: string): Promise<void> {
    try {
      const [owner, name] = conv.repoFullName.split("/") as [string, string];
      const epic = await epicRef(conv.epicIssueId);
      const header = epic
        ? `Repository: ${conv.repoFullName}. This is a Shape conversation about epic #${epic.number}, "${epic.title}" (${epic.state ?? "no state"}): the person is discussing work the factory has in progress. Your checkout is the epic's branch where it exists.`
        : `Repository: ${conv.repoFullName}. This is a Shape conversation: the person is shaping an idea for this product. Your checkout is the latest default branch.`;
      const branch = branchOf(epic);
      // A session less than a day old is resumed: the model keeps what it
      // already read and the transcript is not sent again. Older than that,
      // or never opened, the message starts cold with the full grounding.
      const session = conv.askSession && conv.askSessionAt && Date.now() - conv.askSessionAt.getTime() < SESSION_TTL_MS ? conv.askSession : null;
      const got = await askOrchestrator(deps.cfg, {
        owner,
        repo: name,
        question: text || "Look at the attached image and say what you see.",
        context: session ? header : await grounding(conv, epic, earlier, header),
        instructions: SHAPE_INSTRUCTIONS,
        claudeCodeOauthToken: claudeToken,
        mode: "shape",
        images: attachments.map((a) => ({ name: a.name, mime: a.mime, dataB64: a.bytesB64 })),
        ...(branch ? { branch } : {}),
        repos: await siblings(conv.repoId, conv.projectId, branch),
        conversation: conv.id,
        ...(session ? { session } : {}),
      });
      if (!("ok" in got)) {
        await db.update(shapeMessages).set({ status: "failed", error: got.error }).where(eq(shapeMessages.id, assistantId));
        return;
      }
      // The session to resume next time: the one the orchestrator reports
      // (new on a cold start, the same when it resumed). An orchestrator that
      // reports none — or one that could not resume and opened no new session
      // — leaves the next message to start cold with the full grounding.
      const nextSession = got.session ?? (got.resumed === true ? session : null);
      await db
        .update(shapeConversations)
        .set({ ...(nextSession ? { askSession: nextSession, askSessionAt: new Date() } : { askSession: null, askSessionAt: null }), updatedAt: new Date() })
        .where(eq(shapeConversations.id, conv.id));
      await db
        .update(shapeMessages)
        .set({ body: got.answer, inputTokens: got.inputTokens, outputTokens: got.outputTokens, model: got.model || null, status: "done", error: null })
        .where(eq(shapeMessages.id, assistantId));
    } catch (err) {
      await db
        .update(shapeMessages)
        .set({ status: "failed", error: (err as Error).message || "The answer failed." })
        .where(eq(shapeMessages.id, assistantId))
        .catch(() => undefined);
    }
  }

  /** The 202 body: the pending assistant message, and the conversation's title. */
  async function accepted(reply: FastifyReply, assistantId: string, title: string) {
    const row = (await db.select().from(shapeMessages).where(eq(shapeMessages.id, assistantId)).limit(1))[0]!;
    return reply.code(202).send({ message: messageDto(row), conversation: { title } });
  }

  async function pendingOn(conversationId: string): Promise<boolean> {
    const rows = await db
      .select({ id: shapeMessages.id })
      .from(shapeMessages)
      .where(and(eq(shapeMessages.conversationId, conversationId), eq(shapeMessages.status, "pending")))
      .limit(1);
    return rows.length > 0;
  }

  app.post<{ Params: { id: string }; Body: { text?: string; attachmentIds?: string[] } }>("/api/shape/:id/messages", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    const text = (req.body?.text ?? "").trim();
    const attachmentIds = Array.isArray(req.body?.attachmentIds) ? req.body!.attachmentIds!.filter((x) => typeof x === "string") : [];
    if (!text && attachmentIds.length === 0) return reply.code(400).send({ error: "say something, or attach an image" });
    await settleStale(db, conv.id);
    if (await pendingOn(conv.id)) return reply.code(409).send({ error: "Wait for the current answer." });
    const attachments = attachmentIds.length
      ? await db
          .select()
          .from(shapeAttachments)
          .where(and(inArray(shapeAttachments.id, attachmentIds), eq(shapeAttachments.conversationId, conv.id)))
      : [];
    const claudeToken = await claudeTokenFor(deps, conv.orgId);
    if (!claudeToken) return reply.code(503).send({ error: NO_CLAUDE });

    const earlier = await messagesOf(conv.id);
    await db.insert(shapeMessages).values({
      orgId: conv.orgId,
      conversationId: conv.id,
      role: "user",
      body: text || "(an image)",
      attachments: attachments.map((a) => ({ id: a.id, name: a.name, mime: a.mime })),
    });
    const assistant = (
      await db.insert(shapeMessages).values({ orgId: conv.orgId, conversationId: conv.id, role: "assistant", body: "", status: "pending" }).returning()
    )[0]!;
    const epic = await epicRef(conv.epicIssueId);
    const title = earlier.length === 0 && conv.title === "New idea" && !epic && text ? firstLine(text) : conv.title;
    await db.update(shapeConversations).set({ title, updatedAt: new Date() }).where(eq(shapeConversations.id, conv.id));
    track(answer(conv, assistant.id, text, attachments, earlier, claudeToken));
    return accepted(reply, assistant.id, title);
  });

  /** Run a failed answer again: the same question, a fresh pending row in its place. */
  app.post<{ Params: { id: string; messageId: string } }>("/api/shape/:id/messages/:messageId/retry", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    await settleStale(db, conv.id);
    if (await pendingOn(conv.id)) return reply.code(409).send({ error: "Wait for the current answer." });
    const all = await messagesOf(conv.id);
    const at = all.findIndex((m) => m.id === req.params.messageId);
    const failed = at >= 0 ? all[at] : undefined;
    if (!failed || failed.role !== "assistant" || failed.status !== "failed") return reply.code(404).send({ error: "nothing to retry" });
    const question = [...all.slice(0, at)].reverse().find((m) => m.role === "user");
    if (!question) return reply.code(404).send({ error: "nothing to retry" });
    const claudeToken = await claudeTokenFor(deps, conv.orgId);
    if (!claudeToken) return reply.code(503).send({ error: NO_CLAUDE });
    const ids = (question.attachments ?? []).map((a) => a.id);
    const attachments = ids.length ? await db.select().from(shapeAttachments).where(and(inArray(shapeAttachments.id, ids), eq(shapeAttachments.conversationId, conv.id))) : [];
    const earlier = all.slice(0, at).filter((m) => m.id !== question.id);
    await db.update(shapeMessages).set({ status: "pending", error: null, body: "" }).where(eq(shapeMessages.id, failed.id));
    const text = question.body === "(an image)" ? "" : question.body;
    track(answer(conv, failed.id, text, attachments, earlier, claudeToken));
    return accepted(reply, failed.id, conv.title);
  });

  /** Write the requirement in the background; the conversation's specStatus says how it went. */
  async function writeSpec(conv: Owned, messages: Message[], claudeToken: string): Promise<void> {
    try {
      const recentMocks = messages
        .filter((m) => m.role === "assistant")
        .slice(-3)
        .flatMap((m) => splitMocks(m.body).mocks)
        .map((m, i) => `Mock ${i + 1}:\n${m.html.slice(0, 6_000)}`)
        .join("\n\n");
      const [owner, name] = conv.repoFullName.split("/") as [string, string];
      const epic = await epicRef(conv.epicIssueId);
      const branch = branchOf(epic);
      const header = epic
        ? `Repository: ${conv.repoFullName}. The conversation is about epic #${epic.number}, "${epic.title}"; the requirement is for a change to it.`
        : `Repository: ${conv.repoFullName}.`;
      const got = await askOrchestrator(deps.cfg, {
        owner,
        repo: name,
        question: "Write the requirement from this conversation.",
        context: `${await grounding(conv, epic, messages, header)}${recentMocks ? `\n\nMocks the conversation produced:\n\n${recentMocks}` : ""}`,
        instructions: SPEC_INSTRUCTIONS,
        claudeCodeOauthToken: claudeToken,
        mode: "shape",
        ...(branch ? { branch } : {}),
        repos: await siblings(conv.repoId, conv.projectId, branch),
        // The same workspace, so the checkout is reused; a fresh session,
        // because the spec is a different instruction with the full context.
        conversation: conv.id,
      });
      if (!("ok" in got)) {
        await db.update(shapeConversations).set({ specStatus: "failed", specError: got.error }).where(eq(shapeConversations.id, conv.id));
        return;
      }
      const spec = got.answer.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, "$1").trim();
      await db
        .update(shapeConversations)
        .set({ spec, specUpdatedAt: new Date(), specStatus: "done", specError: null, updatedAt: new Date() })
        .where(eq(shapeConversations.id, conv.id));
    } catch (err) {
      await db
        .update(shapeConversations)
        .set({ specStatus: "failed", specError: (err as Error).message || "Writing the requirement failed." })
        .where(eq(shapeConversations.id, conv.id))
        .catch(() => undefined);
    }
  }

  app.post<{ Params: { id: string } }>("/api/shape/:id/spec", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    await settleStale(db, conv.id);
    if (conv.specStatus === "pending") return reply.code(409).send({ error: "The requirement is being written." });
    const messages = (await messagesOf(conv.id)).filter((m) => m.status !== "pending" && m.status !== "failed");
    if (messages.length === 0) return reply.code(400).send({ error: "talk about the idea first; there is nothing to write up yet" });
    const claudeToken = await claudeTokenFor(deps, conv.orgId);
    if (!claudeToken) return reply.code(503).send({ error: NO_CLAUDE });
    await db.update(shapeConversations).set({ specStatus: "pending", specError: null, updatedAt: new Date() }).where(eq(shapeConversations.id, conv.id));
    track(writeSpec(conv, messages, claudeToken));
    return reply.code(202).send({ specStatus: "pending" });
  });

  app.put<{ Params: { id: string }; Body: { spec?: string } }>("/api/shape/:id/spec", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    const spec = (req.body?.spec ?? "").trim();
    if (!spec) return reply.code(400).send({ error: "the requirement is empty" });
    await db.update(shapeConversations).set({ spec, specUpdatedAt: new Date(), specStatus: "done", specError: null, updatedAt: new Date() }).where(eq(shapeConversations.id, conv.id));
    return { spec };
  });

  app.post<{ Params: { id: string }; Body: { title?: string; fast?: boolean } }>("/api/shape/:id/work", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    const title = (req.body?.title ?? conv.title).trim();
    if (!title) return reply.code(400).send({ error: "give the work a title" });
    if (!conv.spec) return reply.code(400).send({ error: "write the requirement first" });
    const messages = await messagesOf(conv.id);
    const mocks = messages.filter((m) => m.role === "assistant" && m.status === "done").flatMap((m) => splitMocks(m.body).mocks);
    const attachments = messages.flatMap((m) => m.attachments ?? []);
    const origin = deps.cfg.PUBLIC_ORIGIN.replace(/\/+$/, "");
    const parts = [conv.spec.trim()];
    if (mocks.length > 0) {
      parts.push(
        "## Mockups\n\n" +
          mocks.map((m, i) => `<details><summary>Mock ${i + 1}</summary>\n\n\`\`\`html\n${m.html.trim()}\n\`\`\`\n</details>`).join("\n\n"),
      );
    }
    if (attachments.length > 0) {
      parts.push(
        "## Attachments\n\nThese need a Compass sign-in to open.\n\n" +
          attachments.map((a) => `- [${a.name}](${origin}/api/shape/attachments/${a.id})`).join("\n"),
      );
    }
    parts.push(`<!-- shaped in Compass: ${origin}/shape/${conv.id} -->`);
    const repo = { id: conv.repoId, orgId: conv.orgId, fullName: conv.repoFullName };
    const issue = await openWorkIssue(deps, ctx, reply, repo, { title, body: parts.join("\n\n"), fast: Boolean(req.body?.fast) });
    if (!issue) return;
    const existing = (
      await db.select({ id: issues.id }).from(issues).where(and(eq(issues.repoId, conv.repoId), eq(issues.number, issue.number))).limit(1)
    )[0];
    await db
      .update(shapeConversations)
      .set({
        title,
        issueUrl: issue.html_url,
        issueId: existing?.id ?? null,
        // From here the idea is about the epic it became; the next message runs on its branch.
        ...(existing ? { epicIssueId: existing.id } : {}),
        updatedAt: new Date(),
      })
      .where(eq(shapeConversations.id, conv.id));
    return { number: issue.number, htmlUrl: issue.html_url, epicId: existing?.id ?? null };
  });
}
