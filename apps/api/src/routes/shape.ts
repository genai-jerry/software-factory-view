import { createHash, randomUUID } from "node:crypto";
import { mcpPayloadFor } from "../mcp-servers.js";
import { sourcesBlock } from "@console/insight";
import { issues, projects, repos, shapeAttachments, shapeConversations, shapeMessages } from "@console/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, notInArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@console/db";
import { requireAuth, type AppDeps, type RequestCtx } from "../context.js";
import { ASK_GONE, askOrchestrator, fetchAsk, isAskState, submitAsk, type AskAnswer, type AskBody, type OrchestratorProxyError } from "../orchestrator-dispatch.js";
import { renderMarkdown } from "../render.js";
import { requirementBody } from "../openspec-draft.js";
import { INVESTIGATE_INSTRUCTIONS, INVESTIGATE_SPEC_INSTRUCTIONS, SHAPE_INSTRUCTIONS, SPEC_INSTRUCTIONS } from "../shape-prompts.js";
import { openWorkIssue } from "./activity.js";
import { artifactSources, claudeTokenFor } from "./qa.js";

/**
 * Shape — a conversation that turns an idea into work. A person picks the
 * repository the chat may read, talks in text and screenshots, asks for a
 * page or a change to be visualised (the answer carries a self-contained
 * HTML mock), then has the conversation written up as a factory requirement
 * with a draft OpenSpec change (proposal and specs) and opened as a GitHub
 * issue with `factory:intake` — the same door as Add work.
 *
 * The answers come from the orchestrator's read-only Claude session in a
 * checkout of the repo (POST /ask), as Ask does; images ride along for its
 * Read tool. Conversations are private to their author.
 *
 * A fresh idea runs against the latest default branch of its repository,
 * with the project's other repositories checked out beside it. An idea that
 * spans the project (scope `project`) is the same checkout told so: one home
 * repository is the working directory, the rest sit beside it, and the person
 * picks which repository holds the epic when they open it as work — the
 * factory's cross-repo epics live in one coordination repo. An idea about
 * an epic runs on the epic's branch, with its documents (proposal, specs,
 * design, tasks, test plan) in front of the session — the Ask panel's
 * grounding, in a conversation that can also draw and write the requirement.
 *
 * An idea for a new product (scope `new`) has no repository: the session
 * runs in an empty folder and is told so, so it shapes the idea from scratch
 * instead of pulling it toward the org's existing code. When it is opened as
 * work the person picks the repository it goes in.
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
const MAX_DIAGRAM_CHARS = 50_000;
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

/**
 * The assistant rows this process is still answering. A retry keeps its row,
 * and with it the first send's createdAt, so age alone would call a fresh
 * retry lost; a row named here is not lost, however old it is.
 */
const answering = new Set<string>();

function track(work: Promise<void>, messageId?: string): void {
  if (messageId) answering.add(messageId);
  const p = work
    .catch(() => undefined)
    .finally(() => {
      pendingAnswers.delete(p);
      if (messageId) answering.delete(messageId);
    });
  pendingAnswers.add(p);
}

/**
 * Collect finished background asks into their messages; how many are still
 * running. Set when the routes are registered (it needs their database and
 * config), run every few seconds by startAnswerCollector.
 */
let collect: (() => Promise<number>) | null = null;

/** Wait for every answer in flight, submitted and collected — for tests. */
export async function settlePendingAnswers(): Promise<void> {
  for (let round = 0; round < 100; round++) {
    while (pendingAnswers.size > 0) await Promise.all([...pendingAnswers]);
    if (!collect || (await collect()) === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Check the orchestrator for finished answers every few seconds. The answer
 * is written there in the background, so a pending message survives this
 * process restarting: the next process picks its ask up by id.
 */
export function startAnswerCollector(app: FastifyInstance, everyMs = 3_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running || !collect) return;
    running = true;
    collect()
      .catch((err: unknown) => app.log.warn({ err }, "could not collect Shape answers"))
      .finally(() => {
        running = false;
      });
  }, everyMs);
  return () => clearInterval(timer);
}

/**
 * Mark work the process lost as failed: a pending answer or requirement
 * older than 15 minutes, that this process is not answering and that has no
 * background ask on the orchestrator, was started by a process that is gone.
 * An answer with an ask is settled by what the orchestrator says (collect). Run at start
 * and before a conversation is read, so a reader is never shown a spinner
 * that nothing will ever stop.
 */
export async function settleStale(db: Db, conversationId?: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  await db
    .update(shapeMessages)
    .set({ status: "failed", error: LOST })
    .where(
      and(
        eq(shapeMessages.status, "pending"),
        isNull(shapeMessages.askId),
        lt(shapeMessages.createdAt, cutoff),
        ...(answering.size > 0 ? [notInArray(shapeMessages.id, [...answering])] : []),
        ...(conversationId ? [eq(shapeMessages.conversationId, conversationId)] : []),
      ),
    );
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

/**
 * Split an answer into its prose, the ```html mocks and the ```mermaid
 * diagrams it carried. Both are drawn below the prose by the page; leaving a
 * diagram in the markdown would send it through the factory-comment renderer,
 * which flattens a flowchart into a list of chains for phone readers.
 */
export interface RepoProposal {
  name: string;
  description: string;
  private: boolean;
  /** "new", or the name of an existing project. */
  project: string;
}

/**
 * A resumed Claude session is sent the question alone: the instructions it
 * started with stay in force. So a session is resumed only when it started
 * on today's SHAPE_INSTRUCTIONS; after a change, the next message starts
 * cold with the full conversation and the new instructions. The version
 * rides in the stored session id ("<version>:<id>").
 */
export const SHAPE_INSTRUCTIONS_VERSION = createHash("sha256").update(SHAPE_INSTRUCTIONS).digest("hex").slice(0, 10);
export const INVESTIGATE_INSTRUCTIONS_VERSION = createHash("sha256").update(INVESTIGATE_INSTRUCTIONS).digest("hex").slice(0, 10);

type Kind = "shape" | "investigate";
const versionOf = (kind: Kind) => (kind === "investigate" ? INVESTIGATE_INSTRUCTIONS_VERSION : SHAPE_INSTRUCTIONS_VERSION);

export function storedSession(session: string, kind: Kind = "shape"): string {
  return `${versionOf(kind)}:${session}`;
}

/** The session id to resume, or null when it started on other instructions (or before versions were kept). */
export function resumableSession(stored: string | null, kind: Kind = "shape"): string | null {
  if (!stored) return null;
  const at = stored.indexOf(":");
  if (at < 0 || stored.slice(0, at) !== versionOf(kind)) return null;
  return stored.slice(at + 1) || null;
}

/** A ```create-repository block (SHAPE_INSTRUCTIONS): JSON, checked; anything else is no proposal. */
export function readRepoProposal(raw: string): RepoProposal | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const name = typeof j.name === "string" ? j.name.trim() : "";
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return null;
    return {
      name,
      description: typeof j.description === "string" ? j.description.trim().slice(0, 300) : "",
      private: j.private !== false,
      project: typeof j.project === "string" && j.project.trim() ? j.project.trim().slice(0, 80) : "new",
    };
  } catch {
    return null;
  }
}

/** Held in issueUrl while the issue is being filed. */
const OPENING = "opening";

export interface WorkProposal {
  title: string;
  fast: boolean;
}

/** A ```open-as-work block: the title the work is opened under, and the fast lane only when asked. */
export function readWorkProposal(raw: string): WorkProposal | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const title = typeof j.title === "string" ? j.title.trim().slice(0, 120) : "";
    return title ? { title, fast: j.fast === true } : null;
  } catch {
    return null;
  }
}

export function splitMocks(body: string): {
  text: string;
  mocks: Array<{ html: string }>;
  diagrams: Array<{ code: string }>;
  repoProposal: RepoProposal | null;
  workProposal: WorkProposal | null;
} {
  const mocks: Array<{ html: string }> = [];
  const diagrams: Array<{ code: string }> = [];
  let repoProposal: RepoProposal | null = null;
  let workProposal: WorkProposal | null = null;
  const text = body
    .replace(/```open-as-work[ \t]*\n([\s\S]*?)```/g, (_m, inner: string) => {
      workProposal = readWorkProposal(inner) ?? workProposal;
      return "*(Ready to open as work — confirm it below.)*";
    })
    .replace(/```create-repository[ \t]*\n([\s\S]*?)```/g, (_m, inner: string) => {
      repoProposal = readRepoProposal(inner) ?? repoProposal;
      return "*(The proposed repository is below — check it, then Create it.)*";
    })
    .replace(/```html[ \t]*\n([\s\S]*?)```/g, (_m, inner: string) => {
      mocks.push({ html: inner.slice(0, MAX_MOCK_CHARS) });
      return `*(Mock ${mocks.length} — shown below.)*`;
    })
    .replace(/```mermaid[ \t]*\n([\s\S]*?)```/g, (_m, inner: string) => {
      diagrams.push({ code: inner.trim().slice(0, MAX_DIAGRAM_CHARS) });
      return `*(Diagram ${diagrams.length} — shown below.)*`;
    });
  return { text: text.trim(), mocks, diagrams, repoProposal, workProposal };
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "New idea";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

function messageDto(m: Message) {
  const { text, mocks, diagrams, repoProposal, workProposal } =
    m.role === "assistant" ? splitMocks(m.body) : { text: m.body, mocks: [], diagrams: [], repoProposal: null, workProposal: null };
  return {
    id: m.id,
    role: m.role,
    body: m.body,
    bodyHtml: renderMarkdown(text),
    mocks,
    diagrams,
    repoProposal,
    workProposal,
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
type Owned = Conversation & { repoFullName: string | null; projectId: string | null; projectName: string | null };

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

  /** The project's factory-enabled repositories, by name. */
  async function projectRepos(projectId: string | null): Promise<Array<{ id: string; fullName: string }>> {
    if (!projectId) return [];
    return db
      .select({ id: repos.id, fullName: repos.fullName })
      .from(repos)
      .where(and(eq(repos.projectId, projectId), eq(repos.factoryEnabled, true), isNotNull(repos.projectId)))
      .orderBy(repos.fullName);
  }

  /** Every factory-enabled repository of the org: where a new product's work may open. */
  async function orgRepos(orgId: string): Promise<Array<{ id: string; fullName: string }>> {
    return db
      .select({ id: repos.id, fullName: repos.fullName })
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.factoryEnabled, true)))
      .orderBy(repos.fullName);
  }

  /** The project's other factory-enabled repositories, checked out beside the primary one. */
  async function siblings(repoId: string | null, projectId: string | null, branch: string | null) {
    const rows = (await projectRepos(projectId)).filter((r) => r.id !== repoId).slice(0, MAX_SIBLINGS);
    return rows.map((r) => {
      const [owner, repo] = r.fullName.split("/") as [string, string];
      return { owner, repo, branch };
    });
  }

  /**
   * The first line of what the session is told: which repository it sits in,
   * and — for an idea that spans the project — that the others are beside it
   * and the idea may land in any of them.
   */
  async function whereItRuns(conv: Owned): Promise<string> {
    if (conv.scope === "new" || !conv.repoFullName) {
      return "A new product: there is no repository and no code yet. Shape the idea from scratch; do not relate it to the organisation's other products unless the person asks.";
    }
    if (conv.scope !== "project" || !conv.projectId) return `Repository: ${conv.repoFullName}.`;
    const names = (await projectRepos(conv.projectId)).map((r) => r.fullName);
    const others = names.filter((n) => n !== conv.repoFullName);
    return (
      `Project: ${conv.projectName ?? "the project"}, repositories ${names.join(", ")}. ` +
      `The idea may span any of them. Your working directory is the checkout of ${conv.repoFullName}` +
      (others.length ? `; ${others.join(", ")} are checked out beside it (../<repo name>), read them too.` : ".")
    );
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

  async function own(ctx: RequestCtx, id: string, reply: FastifyReply): Promise<Owned | null> {
    const row = (
      await db
        .select({ conv: shapeConversations, repoFullName: repos.fullName, projectId: repos.projectId, projectName: projects.name })
        .from(shapeConversations)
        .leftJoin(repos, eq(repos.id, shapeConversations.repoId))
        .leftJoin(projects, eq(projects.id, repos.projectId))
        .where(and(eq(shapeConversations.id, id), eq(shapeConversations.userId, ctx.userId), inArray(shapeConversations.orgId, ctx.orgIds)))
        .limit(1)
    )[0];
    if (!row) {
      void reply.code(404).send({ error: "conversation not found" });
      return null;
    }
    return { ...row.conv, repoFullName: row.repoFullName, projectId: row.projectId, projectName: row.projectName };
  }

  /** What the page shows about where an idea runs: its project, and the repositories it may land in. */
  async function projectDto(conv: Owned) {
    if (!conv.projectId) return null;
    return { id: conv.projectId, name: conv.projectName ?? "", repos: await projectRepos(conv.projectId) };
  }

  async function messagesOf(conversationId: string): Promise<Message[]> {
    return db.select().from(shapeMessages).where(eq(shapeMessages.conversationId, conversationId)).orderBy(asc(shapeMessages.createdAt));
  }

  app.get<{ Querystring: { repoId?: string; epicId?: string; kind?: string } }>("/api/shape", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const rows = await db
      .select({
        conv: shapeConversations,
        repo: repos.fullName,
        projectName: projects.name,
        epicNumber: issues.number,
        epicTitle: issues.title,
        epicState: issues.factoryState,
      })
      .from(shapeConversations)
      .leftJoin(repos, eq(repos.id, shapeConversations.repoId))
      .leftJoin(projects, eq(projects.id, repos.projectId))
      .leftJoin(issues, eq(issues.id, shapeConversations.epicIssueId))
      .where(
        and(
          eq(shapeConversations.userId, ctx.userId),
          inArray(shapeConversations.orgId, ctx.orgIds),
          // Ideas and investigations are separate lists.
          eq(shapeConversations.kind, req.query.kind === "investigate" ? "investigate" : "shape"),
          ...(req.query.repoId ? [eq(shapeConversations.repoId, req.query.repoId)] : []),
          ...(req.query.epicId ? [eq(shapeConversations.epicIssueId, req.query.epicId)] : []),
        ),
      )
      .orderBy(desc(shapeConversations.updatedAt));
    return {
      conversations: rows.map(({ conv, repo, projectName, epicNumber, epicTitle, epicState }) => ({
        id: conv.id,
        title: conv.title,
        kind: conv.kind,
        repo,
        repoId: conv.repoId,
        scope: conv.scope,
        projectName,
        updatedAt: conv.updatedAt,
        hasSpec: Boolean(conv.spec),
        issueUrl: conv.issueUrl,
        epic: conv.epicIssueId && epicNumber !== null ? { id: conv.epicIssueId, number: epicNumber, title: epicTitle ?? "", state: epicState } : null,
      })),
    };
  });

  app.post<{ Body: { repoId?: string; projectId?: string; epicId?: string; title?: string; newProduct?: boolean; orgId?: string; kind?: string } }>("/api/shape", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const kind: Kind = req.body?.kind === "investigate" ? "investigate" : "shape";
    if (kind === "investigate" && (req.body?.newProduct || req.body?.epicId)) {
      return reply.code(400).send({ error: "an investigation is about a running product: pick its project or repository" });
    }
    if (req.body?.newProduct) {
      // A new product: no repository, no code to read.
      const orgId = req.body.orgId && ctx.orgIds.includes(req.body.orgId) ? req.body.orgId : ctx.orgIds[0];
      if (!orgId) return reply.code(404).send({ error: "no organisation" });
      const row = (
        await db
          .insert(shapeConversations)
          .values({ orgId, userId: ctx.userId, repoId: null, scope: "new", title: req.body.title?.trim() || "New idea" })
          .returning()
      )[0]!;
      return { id: row.id };
    }
    // About an epic: the repository is the epic's own, and the title starts as the epic's.
    let epic: EpicRef | null = null;
    let repoId = req.body?.repoId ?? "";
    let scope: "repo" | "project" = "repo";
    if (req.body?.projectId && !req.body.epicId) {
      // Across the project: the first factory-enabled repository is home;
      // the person picks where the work opens later.
      const project = (await db.select().from(projects).where(and(eq(projects.id, req.body.projectId), inArray(projects.orgId, ctx.orgIds))).limit(1))[0];
      if (!project) return reply.code(404).send({ error: "project not found" });
      const first = (await projectRepos(project.id))[0];
      if (!first) return reply.code(400).send({ error: "no repository in this project is set up for the factory yet" });
      repoId = first.id;
      scope = "project";
    }
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
    const title = req.body?.title?.trim() || (epic ? `About: ${epic.title}` : kind === "investigate" ? "New investigation" : "New idea");
    const row = (
      await db
        .insert(shapeConversations)
        .values({ orgId: repo.orgId, userId: ctx.userId, repoId: repo.id, scope, kind, title, epicIssueId: epic?.id ?? null })
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
    if (conv.issueUrl && !conv.epicIssueId && conv.repoId) {
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
        orgId: conv.orgId,
        kind: conv.kind,
        title: conv.title,
        repoId: conv.repoId,
        repo: conv.repoFullName,
        scope: conv.scope,
        project: await projectDto(conv),
        // A new product opens as work in a repository the person picks: every factory repository of the org.
        ...(conv.scope === "new" ? { homes: await orgRepos(conv.orgId) } : {}),
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

  /**
   * Answer one user message into its pending assistant row. Runs after the
   * 202 has gone back: a success fills the row and keeps the session to
   * resume; a failure marks the row failed with the plain reason, and the
   * person's question stays in the thread for a retry.
   */
  async function answer(conv: Owned, assistantId: string, text: string, attachments: Attachment[], earlier: Message[], claudeToken: string): Promise<void> {
    try {
      const [owner, name] = conv.repoFullName ? (conv.repoFullName.split("/") as [string, string]) : [undefined, undefined];
      const epic = await epicRef(conv.epicIssueId);
      const where = await whereItRuns(conv);
      const investigating = conv.kind === "investigate";
      const header = investigating
        ? `${where} This is an investigation: the person noticed a problem in production. Your checkout is the latest default branch; the production logs, when a log tool is connected, are in your tools.`
        : !owner
        ? `${where} This is a Shape conversation: the person is shaping an idea for a new product.`
        : epic
        ? `${where} This is a Shape conversation about epic #${epic.number}, "${epic.title}" (${epic.state ?? "no state"}): the person is discussing work the factory has in progress. Your checkout is the epic's branch where it exists.`
        : `${where} This is a Shape conversation: the person is shaping an idea for this product. Your checkout is the latest default branch.`;
      const branch = branchOf(epic);
      // A session less than a day old is resumed: the model keeps what it
      // already read and the transcript is not sent again. Older than that,
      // or never opened, the message starts cold with the full grounding.
      const session = conv.askSessionAt && Date.now() - conv.askSessionAt.getTime() < SESSION_TTL_MS ? resumableSession(conv.askSession, conv.kind) : null;
      const request: AskBody = {
        ...(owner && name ? { owner, repo: name } : {}),
        question: text || "Look at the attached image and say what you see.",
        mcpServers: await mcpPayloadFor(deps, conv.orgId, conv.projectId),
        context: session ? header : await grounding(conv, epic, earlier, header),
        instructions: investigating ? INVESTIGATE_INSTRUCTIONS : SHAPE_INSTRUCTIONS,
        claudeCodeOauthToken: claudeToken,
        // Reading a product's repos and logs takes more steps than shaping an idea.
        mode: investigating ? "investigate" : "shape",
        images: attachments.map((a) => ({ name: a.name, mime: a.mime, dataB64: a.bytesB64 })),
        ...(branch ? { branch } : {}),
        repos: await siblings(conv.repoId, conv.projectId, branch),
        conversation: conv.id,
        ...(session ? { session } : {}),
      };
      // The answer is written on the orchestrator in the background, under
      // an id kept on the message; collect() fetches it when it is done, in
      // this process or the next.
      const askId = randomUUID();
      await db.update(shapeMessages).set({ askId }).where(eq(shapeMessages.id, assistantId));
      const sent = await submitAsk(deps.cfg, askId, request);
      if ("ok" in sent) return;
      if ("error" in sent) {
        await db.update(shapeMessages).set({ status: "failed", error: sent.error, askId: null }).where(eq(shapeMessages.id, assistantId));
        return;
      }
      // An orchestrator that predates /asks: answer while this process waits.
      await db.update(shapeMessages).set({ askId: null }).where(eq(shapeMessages.id, assistantId));
      await finish(conv.id, assistantId, null, await askOrchestrator(deps.cfg, request));
    } catch (err) {
      await db
        .update(shapeMessages)
        .set({ status: "failed", error: (err as Error).message || "The answer failed." })
        .where(eq(shapeMessages.id, assistantId))
        .catch(() => undefined);
    }
  }

  /**
   * Write a finished answer into its pending message, and keep the session to
   * resume. `askId` guards against a retry that has since handed the message
   * a new ask: only the ask the message still names may finish it.
   */
  async function finish(conversationId: string, assistantId: string, askId: string | null, got: AskAnswer | OrchestratorProxyError): Promise<void> {
    const mine = and(eq(shapeMessages.id, assistantId), eq(shapeMessages.status, "pending"), askId ? eq(shapeMessages.askId, askId) : isNull(shapeMessages.askId));
    if (!("ok" in got)) {
      await db.update(shapeMessages).set({ status: "failed", error: got.error }).where(mine);
      return;
    }
    const done = await db
      .update(shapeMessages)
      .set({ body: got.answer, inputTokens: got.inputTokens, outputTokens: got.outputTokens, model: got.model || null, status: "done", error: null })
      .where(mine)
      .returning({ id: shapeMessages.id });
    if (done.length === 0) return;
    // The session to resume next time: the one the orchestrator reports (new
    // on a cold start, the same when it resumed). One that resumed without
    // naming it keeps the stored one. An orchestrator that reports none — or
    // could not resume and opened no new session — leaves the next message to
    // start cold with the full grounding.
    const [conv] = await db.select().from(shapeConversations).where(eq(shapeConversations.id, conversationId)).limit(1);
    if (!conv) return;
    const next = got.session
      ? { askSession: storedSession(got.session, conv.kind), askSessionAt: new Date() }
      : got.resumed === true && conv.askSession
      ? { askSessionAt: new Date() }
      : { askSession: null, askSessionAt: null };
    await db.update(shapeConversations).set({ ...next, updatedAt: new Date() }).where(eq(shapeConversations.id, conversationId));
  }

  collect = async () => {
    const waiting = await db
      .select({ id: shapeMessages.id, conversationId: shapeMessages.conversationId, askId: shapeMessages.askId })
      .from(shapeMessages)
      .where(and(eq(shapeMessages.status, "pending"), isNotNull(shapeMessages.askId)));
    let running = 0;
    for (const m of waiting) {
      const got = await fetchAsk(deps.cfg, m.askId!);
      // Unreachable for now, or still writing: look again next round.
      if (!isAskState(got) || got.status === "running") {
        running++;
        continue;
      }
      await finish(
        m.conversationId,
        m.id,
        m.askId,
        got.status === "done" ? got.answer : got.status === "failed" ? got.error : { error: ASK_GONE, status: 502 },
      );
    }
    return running;
  };

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
    track(answer(conv, assistant.id, text, attachments, earlier, claudeToken), assistant.id);
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
    await db.update(shapeMessages).set({ status: "pending", error: null, body: "", askId: null }).where(eq(shapeMessages.id, failed.id));
    const text = question.body === "(an image)" ? "" : question.body;
    track(answer(conv, failed.id, text, attachments, earlier, claudeToken), failed.id);
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
      const recentDiagrams = messages
        .filter((m) => m.role === "assistant")
        .slice(-3)
        .flatMap((m) => splitMocks(m.body).diagrams)
        .map((d, i) => `Diagram ${i + 1} (Mermaid):\n${d.code.slice(0, 4_000)}`)
        .join("\n\n");
      const [owner, name] = conv.repoFullName ? (conv.repoFullName.split("/") as [string, string]) : [undefined, undefined];
      const epic = await epicRef(conv.epicIssueId);
      const branch = branchOf(epic);
      const where = await whereItRuns(conv);
      const header = !owner
        ? `${where} Write the requirement for building it from scratch. In Affected repositories, say that a new repository is needed and what it holds.`
        : epic
        ? `${where} The conversation is about epic #${epic.number}, "${epic.title}"; the requirement is for a change to it.`
        : conv.scope === "project"
          ? `${where} In Affected repositories, say which repositories change and what each one takes on.`
          : where;
      const got = await askOrchestrator(deps.cfg, {
        ...(owner && name ? { owner, repo: name } : {}),
        question: "Write the requirement from this conversation.",
        mcpServers: await mcpPayloadFor(deps, conv.orgId, conv.projectId),
        context: `${await grounding(conv, epic, messages, header)}${recentMocks ? `\n\nMocks the conversation produced:\n\n${recentMocks}` : ""}${recentDiagrams ? `\n\nDiagrams the conversation produced:\n\n${recentDiagrams}` : ""}`,
        instructions: conv.kind === "investigate" ? INVESTIGATE_SPEC_INSTRUCTIONS : SPEC_INSTRUCTIONS,
        claudeCodeOauthToken: claudeToken,
        mode: conv.kind === "investigate" ? "investigate" : "shape",
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

  /**
   * "This is not about <product>": an idea started under a product becomes a
   * new product. The Claude session is dropped so the next message starts
   * cold, without the code it read; the conversation so far is kept.
   */
  /**
   * The repository a new product now lives in (made from Claude's proposal
   * card): the idea moves into it. The Claude session is dropped so the next
   * answer starts in a checkout of the new repository.
   */
  app.post<{ Params: { id: string }; Body: { repoId?: string } }>("/api/shape/:id/repo", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    // Any idea that is not work yet: one started under Beacon can become a product of its own here.
    if (conv.epicIssueId || conv.issueUrl) return reply.code(409).send({ error: "this idea is already work in a repository" });
    const pick = (await orgRepos(conv.orgId)).find((r) => r.id === req.body?.repoId);
    if (!pick) return reply.code(400).send({ error: "that repository is not set up for the factory" });
    await db
      .update(shapeConversations)
      .set({ scope: "repo", repoId: pick.id, askSession: null, askSessionAt: null, updatedAt: new Date() })
      .where(eq(shapeConversations.id, conv.id));
    return { repoId: pick.id, repo: pick.fullName };
  });

  app.post<{ Params: { id: string } }>("/api/shape/:id/new-product", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    if (conv.epicIssueId || conv.issueUrl) return reply.code(409).send({ error: "this idea is already work in a repository" });
    await db
      .update(shapeConversations)
      .set({ scope: "new", repoId: null, askSession: null, askSessionAt: null, updatedAt: new Date() })
      .where(eq(shapeConversations.id, conv.id));
    return { scope: "new" };
  });

  app.post<{ Params: { id: string }; Body: { title?: string; fast?: boolean; repoId?: string } }>("/api/shape/:id/work", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const conv = await own(ctx, req.params.id, reply);
    if (!conv) return;
    const title = (req.body?.title ?? conv.title).trim();
    if (!title) return reply.code(400).send({ error: "give the work a title" });
    if (!conv.spec) return reply.code(400).send({ error: "write the requirement first" });
    // An idea that spans the project opens in the repository the person
    // picks, which becomes its home: the epic lives there and the next
    // message runs on that repo's branch of it.
    if (conv.scope === "new" && !req.body?.repoId) return reply.code(400).send({ error: "pick the repository the work opens in" });
    if (conv.scope === "new" && req.body?.repoId) {
      const pick = (await orgRepos(conv.orgId)).find((r) => r.id === req.body?.repoId);
      if (!pick) return reply.code(400).send({ error: "that repository is not set up for the factory" });
      conv.repoId = pick.id;
      conv.repoFullName = pick.fullName;
    } else if (req.body?.repoId && req.body.repoId !== conv.repoId) {
      if (conv.scope !== "project") return reply.code(400).send({ error: "this idea is about one repository" });
      const pick = (await projectRepos(conv.projectId)).find((r) => r.id === req.body?.repoId);
      if (!pick) return reply.code(400).send({ error: "that repository is not in this project, or is not set up for the factory" });
      conv.repoId = pick.id;
      conv.repoFullName = pick.fullName;
    }
    const messages = await messagesOf(conv.id);
    const answered = messages.filter((m) => m.role === "assistant" && m.status === "done").map((m) => splitMocks(m.body));
    const mocks = answered.flatMap((a) => a.mocks);
    const diagrams = answered.flatMap((a) => a.diagrams);
    const attachments = messages.flatMap((m) => m.attachments ?? []);
    const origin = deps.cfg.PUBLIC_ORIGIN.replace(/\/+$/, "");
    // The form first, then the OpenSpec draft one file per fold.
    const parts = [requirementBody(conv.spec)];
    if (mocks.length > 0) {
      parts.push(
        "## Mockups\n\n" +
          mocks.map((m, i) => `<details><summary>Mock ${i + 1}</summary>\n\n\`\`\`html\n${m.html.trim()}\n\`\`\`\n</details>`).join("\n\n"),
      );
    }
    // GitHub draws a ```mermaid fence in an issue body, so the diagrams travel
    // as diagrams rather than as code.
    if (diagrams.length > 0) {
      parts.push("## Diagrams\n\n" + diagrams.map((d, i) => `**Diagram ${i + 1}**\n\n\`\`\`mermaid\n${d.code}\n\`\`\``).join("\n\n"));
    }
    if (attachments.length > 0) {
      parts.push(
        "## Attachments\n\nThese need a Compass sign-in to open.\n\n" +
          attachments.map((a) => `- [${a.name}](${origin}/api/shape/attachments/${a.id})`).join("\n"),
      );
    }
    parts.push(`<!-- ${conv.kind === "investigate" ? "investigated" : "shaped"} in Compass: ${origin}/${conv.kind === "investigate" ? "investigate" : "shape"}/${conv.id} -->`);
    if (!conv.repoId || !conv.repoFullName) return reply.code(400).send({ error: "pick the repository the work opens in" });
    const homeId = conv.repoId;
    const repo = { id: homeId, orgId: conv.orgId, fullName: conv.repoFullName };
    // One idea opens one piece of work. Claim the conversation before filing, so two
    // clicks (the chat card and the sheet, or a double click) cannot each file an issue
    // (beacon-api#388 and #389 were the same investigation, opened twice).
    const claimed = await db
      .update(shapeConversations)
      .set({ issueUrl: OPENING })
      .where(and(eq(shapeConversations.id, conv.id), isNull(shapeConversations.issueUrl)))
      .returning({ id: shapeConversations.id });
    if (claimed.length === 0) {
      const now = (await db.select({ url: shapeConversations.issueUrl }).from(shapeConversations).where(eq(shapeConversations.id, conv.id)).limit(1))[0];
      return reply.code(409).send({
        error: now?.url && now.url !== OPENING ? `This idea is already open as work: ${now.url}` : "This idea is being opened as work. Give it a moment.",
      });
    }
    const issue = await openWorkIssue(deps, ctx, reply, repo, { title, body: parts.join("\n\n"), fast: Boolean(req.body?.fast) });
    if (!issue) {
      await db.update(shapeConversations).set({ issueUrl: null }).where(and(eq(shapeConversations.id, conv.id), eq(shapeConversations.issueUrl, OPENING)));
      return;
    }
    const existing = (
      await db.select({ id: issues.id }).from(issues).where(and(eq(issues.repoId, homeId), eq(issues.number, issue.number))).limit(1)
    )[0];
    await db
      .update(shapeConversations)
      .set({
        title,
        repoId: homeId,
        // A new product now has a home; from here it is about that repository.
        ...(conv.scope === "new" ? { scope: "repo" } : {}),
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
