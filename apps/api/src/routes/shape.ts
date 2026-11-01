import { issues, repos, shapeAttachments, shapeConversations, shapeMessages } from "@console/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, type AppDeps, type RequestCtx } from "../context.js";
import { askOrchestrator } from "../orchestrator-dispatch.js";
import { renderMarkdown } from "../render.js";
import { SHAPE_INSTRUCTIONS, SPEC_INSTRUCTIONS } from "../shape-prompts.js";
import { openWorkIssue } from "./activity.js";
import { claudeTokenFor } from "./qa.js";

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
 */

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 50_000;
const MAX_MOCK_CHARS = 200_000;
const NO_CLAUDE = "Shape needs the factory's Claude sign-in. Store it in Settings.";

type Conversation = typeof shapeConversations.$inferSelect;
type Message = typeof shapeMessages.$inferSelect;

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
    createdAt: m.createdAt,
  };
}

/** The conversation as "Person:/You:" turns, oldest trimmed to fit the budget. */
function transcript(messages: Message[]): string {
  const turns = messages.map((m) => `${m.role === "user" ? "Person" : "You"}: ${m.body}`);
  let out = turns.join("\n\n");
  while (out.length > MAX_CONTEXT_CHARS && turns.length > 1) {
    turns.shift();
    out = `(earlier turns trimmed)\n\n${turns.join("\n\n")}`;
  }
  return out;
}

export function registerShapeRoutes(app: FastifyInstance, deps: AppDeps): void {
  const db = deps.dbh.db;

  async function own(ctx: RequestCtx, id: string, reply: FastifyReply): Promise<(Conversation & { repoFullName: string }) | null> {
    const row = (
      await db
        .select({ conv: shapeConversations, repoFullName: repos.fullName })
        .from(shapeConversations)
        .innerJoin(repos, eq(repos.id, shapeConversations.repoId))
        .where(and(eq(shapeConversations.id, id), eq(shapeConversations.userId, ctx.userId), inArray(shapeConversations.orgId, ctx.orgIds)))
        .limit(1)
    )[0];
    if (!row) {
      void reply.code(404).send({ error: "conversation not found" });
      return null;
    }
    return { ...row.conv, repoFullName: row.repoFullName };
  }

  async function messagesOf(conversationId: string): Promise<Message[]> {
    return db.select().from(shapeMessages).where(eq(shapeMessages.conversationId, conversationId)).orderBy(asc(shapeMessages.createdAt));
  }

  app.get<{ Querystring: { repoId?: string } }>("/api/shape", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const rows = await db
      .select({ conv: shapeConversations, repo: repos.fullName })
      .from(shapeConversations)
      .innerJoin(repos, eq(repos.id, shapeConversations.repoId))
      .where(
        and(
          eq(shapeConversations.userId, ctx.userId),
          inArray(shapeConversations.orgId, ctx.orgIds),
          ...(req.query.repoId ? [eq(shapeConversations.repoId, req.query.repoId)] : []),
        ),
      )
      .orderBy(desc(shapeConversations.updatedAt));
    return {
      conversations: rows.map(({ conv, repo }) => ({
        id: conv.id,
        title: conv.title,
        repo,
        repoId: conv.repoId,
        updatedAt: conv.updatedAt,
        hasSpec: Boolean(conv.spec),
        issueUrl: conv.issueUrl,
      })),
    };
  });

  app.post<{ Body: { repoId: string; title?: string } }>("/api/shape", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repo = (await db.select().from(repos).where(and(eq(repos.id, req.body?.repoId ?? ""), inArray(repos.orgId, ctx.orgIds))).limit(1))[0];
    if (!repo) return reply.code(404).send({ error: "repository not found" });
    const title = req.body.title?.trim() || "New idea";
    const row = (await db.insert(shapeConversations).values({ orgId: repo.orgId, userId: ctx.userId, repoId: repo.id, title }).returning())[0]!;
    return { id: row.id };
  });

  app.get<{ Params: { id: string } }>("/api/shape/:id", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    const messages = await messagesOf(conv.id);
    return {
      conversation: {
        id: conv.id,
        title: conv.title,
        repoId: conv.repoId,
        repo: conv.repoFullName,
        spec: conv.spec,
        specUpdatedAt: conv.specUpdatedAt,
        issueUrl: conv.issueUrl,
        issueId: conv.issueId,
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

  app.post<{ Params: { id: string }; Body: { text?: string; attachmentIds?: string[] } }>("/api/shape/:id/messages", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    const text = (req.body?.text ?? "").trim();
    const attachmentIds = Array.isArray(req.body?.attachmentIds) ? req.body!.attachmentIds!.filter((x) => typeof x === "string") : [];
    if (!text && attachmentIds.length === 0) return reply.code(400).send({ error: "say something, or attach an image" });
    const attachments = attachmentIds.length
      ? await db
          .select()
          .from(shapeAttachments)
          .where(and(inArray(shapeAttachments.id, attachmentIds), eq(shapeAttachments.conversationId, conv.id)))
      : [];
    const claudeToken = await claudeTokenFor(deps, conv.orgId);
    if (!claudeToken) return reply.code(503).send({ error: NO_CLAUDE });

    const earlier = await messagesOf(conv.id);
    const userMessage = (
      await db
        .insert(shapeMessages)
        .values({
          orgId: conv.orgId,
          conversationId: conv.id,
          role: "user",
          body: text || "(an image)",
          attachments: attachments.map((a) => ({ id: a.id, name: a.name, mime: a.mime })),
        })
        .returning()
    )[0]!;
    const [owner, name] = conv.repoFullName.split("/") as [string, string];
    const header = `Repository: ${conv.repoFullName}. This is a Shape conversation: the person is shaping an idea for this product.`;
    const got = await askOrchestrator(deps.cfg, {
      owner,
      repo: name,
      question: text || "Look at the attached image and say what you see.",
      context: `${header}\n\n${earlier.length ? `Earlier in this conversation:\n\n${transcript(earlier)}` : "(the conversation starts here)"}`,
      instructions: SHAPE_INSTRUCTIONS,
      claudeCodeOauthToken: claudeToken,
      mode: "shape",
      images: attachments.map((a) => ({ name: a.name, mime: a.mime, dataB64: a.bytesB64 })),
    });
    if (!("ok" in got)) {
      // The question stays in the thread; the person can send it again.
      return reply.code(got.status === 429 ? 429 : got.status === 502 ? 502 : 502).send({ error: got.error });
    }
    const assistant = (
      await db
        .insert(shapeMessages)
        .values({
          orgId: conv.orgId,
          conversationId: conv.id,
          role: "assistant",
          body: got.answer,
          inputTokens: got.inputTokens,
          outputTokens: got.outputTokens,
          model: got.model || null,
        })
        .returning()
    )[0]!;
    const title = earlier.length === 0 && conv.title === "New idea" && text ? firstLine(text) : conv.title;
    await db.update(shapeConversations).set({ title, updatedAt: new Date() }).where(eq(shapeConversations.id, conv.id));
    void userMessage;
    return { message: messageDto(assistant), conversation: { title } };
  });

  app.post<{ Params: { id: string } }>("/api/shape/:id/spec", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    const messages = await messagesOf(conv.id);
    if (messages.length === 0) return reply.code(400).send({ error: "talk about the idea first; there is nothing to write up yet" });
    const claudeToken = await claudeTokenFor(deps, conv.orgId);
    if (!claudeToken) return reply.code(503).send({ error: NO_CLAUDE });
    const recentMocks = messages
      .filter((m) => m.role === "assistant")
      .slice(-3)
      .flatMap((m) => splitMocks(m.body).mocks)
      .map((m, i) => `Mock ${i + 1}:\n${m.html.slice(0, 6_000)}`)
      .join("\n\n");
    const [owner, name] = conv.repoFullName.split("/") as [string, string];
    const got = await askOrchestrator(deps.cfg, {
      owner,
      repo: name,
      question: "Write the requirement from this conversation.",
      context: `Repository: ${conv.repoFullName}.\n\nThe conversation:\n\n${transcript(messages)}${recentMocks ? `\n\nMocks the conversation produced:\n\n${recentMocks}` : ""}`,
      instructions: SPEC_INSTRUCTIONS,
      claudeCodeOauthToken: claudeToken,
      mode: "shape",
    });
    if (!("ok" in got)) return reply.code(got.status === 429 ? 429 : 502).send({ error: got.error });
    const spec = got.answer.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, "$1").trim();
    await db.update(shapeConversations).set({ spec, specUpdatedAt: new Date(), updatedAt: new Date() }).where(eq(shapeConversations.id, conv.id));
    return { spec };
  });

  app.put<{ Params: { id: string }; Body: { spec?: string } }>("/api/shape/:id/spec", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    const spec = (req.body?.spec ?? "").trim();
    if (!spec) return reply.code(400).send({ error: "the requirement is empty" });
    await db.update(shapeConversations).set({ spec, specUpdatedAt: new Date(), updatedAt: new Date() }).where(eq(shapeConversations.id, conv.id));
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
    const mocks = messages.filter((m) => m.role === "assistant").flatMap((m) => splitMocks(m.body).mocks);
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
      .set({ title, issueUrl: issue.html_url, issueId: existing?.id ?? null, updatedAt: new Date() })
      .where(eq(shapeConversations.id, conv.id));
    return { number: issue.number, htmlUrl: issue.html_url, epicId: existing?.id ?? null };
  });
}
