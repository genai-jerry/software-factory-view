import {
  APPROVED_BODY,
  BUG_VERIFIED_STATE,
  GATE_STATES,
  GitHubHttpError,
  MANUAL_TEST_STATE,
  TEST_FAILED_BODY,
  TEST_FAILED_STATE,
  TEST_PASSED_BODY,
  TEST_PASSED_STATE,
  decryptSecret,
} from "@console/core";
import {
  artifactCache,
  auditLog,
  changeArtifacts,
  changes,
  comments,
  decisions,
  gateViews,
  issues,
  pullRequests,
  repos,
  threads,
  type Db,
} from "@console/db";
import { and, desc, eq, inArray, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, userClient, type AppDeps } from "../context.js";
import { githubMessage, postComment } from "../gh-write.js";
import { loadApproversForGate } from "../start-gate.js";
import { countThreadEntries } from "../threads.js";
import { renderMarkdown } from "../render.js";
import { loadEpic } from "./read.js";

/**
 * The gate panel (spec 06 §4): what you are approving, what changed since you
 * last looked, open questions beside the approve control, and the act itself —
 * the literal `Approved` comment posted under the user's own identity so the
 * factory router does the merge + label flip untouched. The Console relocates
 * the button, not the authority.
 *
 * Four gates hold here, three of them comment-approvable: G1 (spec), G2
 * (design) and GS (staging release, at `factory:epic-ready`) all take the
 * literal `Approved`; G3 alone does not — its gate IS the merge, done by a
 * human in the GitHub UI, and the panel says so.
 */
export function registerGateRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get<{ Params: { id: string } }>("/api/epics/:id/gate", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const { epic, repo } = found;
    const gateInfo = epic.factoryState ? GATE_STATES[epic.factoryState] : undefined;
    if (!gateInfo || epic.state !== "open") return reply.code(409).send({ error: "no gate is open on this epic" });

    // Approver status (Console-side UX check; GitHub + router enforce for real).
    // Down the fallback chain: GS reads `staging`, then `release`, then any
    // collaborator — the same order the factory reads them in.
    const owning = await loadApproversForGate(deps, repo.estateId, gateInfo.gate);
    const approvers = owning.approvers;
    const amApprover = approvers.length === 0 || approvers.includes(ctx.login);

    // The exact document PRs the label refers to.
    const wantKind = gateInfo.gate === "spec" ? "spec" : gateInfo.gate === "design" ? "design" : null;
    const docPrs = wantKind
      ? await db
          .select()
          .from(pullRequests)
          .where(
            and(eq(pullRequests.repoId, repo.id), eq(pullRequests.issueNumber, epic.number), eq(pullRequests.kind, wantKind)),
          )
      : [];

    // G3: the release train — promotion PRs plus open task PRs for this epic's tasks.
    const releasePrs =
      gateInfo.gate === "release"
        ? await db
            .select()
            .from(pullRequests)
            .where(
              and(
                eq(pullRequests.orgId, epic.orgId),
                eq(pullRequests.state, "open"),
                inArray(pullRequests.kind, ["promotion", "task"]),
              ),
            )
        : [];

    // Artifacts under review, rendered at both refs.
    const change = (await db.select().from(changes).where(eq(changes.epicIssueId, epic.id)).limit(1))[0];
    const artifactRows = change
      ? await db.select().from(changeArtifacts).where(eq(changeArtifacts.changeId, change.id))
      : [];
    // What the panel renders is not the same question as what the guard
    // watches. At GS the decision is about the assembly, not about re-reading
    // the spec — so only tasks.md is rendered — while a question left open
    // anywhere on the change is still a reason not to release it, which is why
    // `artifactIsRelevant` (below, shared with the guard) stays inclusive.
    const relevant = artifactRows.filter((a) =>
      gateInfo.gate === "staging" ? a.kind === "tasks" : artifactIsRelevant(gateInfo.gate, a.kind),
    );

    const rendered = [];
    for (const a of relevant) {
      const sha = a.latestSha ?? a.mergedSha;
      let html: string | null = null;
      if (sha) {
        const cached = (
          await db
            .select()
            .from(artifactCache)
            .where(and(eq(artifactCache.repoId, a.repoId), eq(artifactCache.path, a.path), eq(artifactCache.commitSha, sha)))
            .limit(1)
        )[0];
        if (cached) html = renderMarkdown(decryptSecret(cached.encryptedContent, deps.cfg.CONSOLE_MASTER_KEY), { repoId: repo.id });
      }
      rendered.push({ path: a.path, kind: a.kind, sha, mergedSha: a.mergedSha, html });
    }

    // What changed since you last looked (per-user last-viewed ref).
    const lastView = (
      await db
        .select()
        .from(gateViews)
        .where(and(eq(gateViews.userId, ctx.userId), eq(gateViews.epicIssueId, epic.id), eq(gateViews.gate, gateInfo.gate)))
        .limit(1)
    )[0];
    const currentSha = rendered[0]?.sha ?? null;
    const changedSinceLastView = Boolean(lastView?.lastViewedSha && currentSha && lastView.lastViewedSha !== currentSha);

    // Open-questions guard: unresolved threads attached to this gate's artifacts
    // or the gate itself — the same computation the approve guard runs, so the
    // panel can never enable a button the guard then refuses.
    const openQuestions = await openGateQuestions(db, epic.id, gateInfo.gate);

    // GS's evidence: what the factory assembled, not what a human is about to
    // read for the first time. The tasks table, the newest agent report on the
    // epic (assembly/dispatch report, suite results) and the PRs still open
    // against it.
    const assembly = gateInfo.gate === "staging" ? await loadAssemblyEvidence(deps, epic, repo) : null;

    return {
      gate: gateInfo.gate,
      label: gateInfo.label,
      state: epic.factoryState,
      amApprover,
      approvers,
      /** Set when this gate's own list is unset and another gate's is standing in. */
      approversFrom: owning.fellBackFrom ? owning.gate : null,
      commentApprovable: COMMENT_APPROVABLE.has(gateInfo.gate),
      assembly,
      documentPrs: docPrs.map(prDto),
      releasePrs: releasePrs.map(prDto),
      artifacts: rendered,
      currentSha,
      changedSinceLastView,
      lastViewedSha: lastView?.lastViewedSha ?? null,
      openQuestions,
    };
  });

  /** Approve: post the literal `Approved` as the acting user. */
  app.post<{ Params: { id: string }; Body: { acknowledgeOpenQuestions?: boolean } }>(
    "/api/epics/:id/gate/approve",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadEpic(deps, ctx, req.params.id);
      if (!found) return reply.code(404).send({ error: "epic not found" });
      const { epic, repo } = found;
      const gateInfo = epic.factoryState ? GATE_STATES[epic.factoryState] : undefined;
      if (!gateInfo) return reply.code(409).send({ error: "no gate is open on this epic" });
      if (!COMMENT_APPROVABLE.has(gateInfo.gate)) {
        return reply.code(409).send({ error: "G3 is not comment-approvable — merge the PRs instead (the merge button is the gate)" });
      }

      // Server-side approver check (UX layer; the router re-checks with
      // authority), down the same fallback chain the panel showed.
      const owning = await loadApproversForGate(deps, repo.estateId, gateInfo.gate);
      const approvers = owning.approvers;
      if (approvers.length > 0 && !approvers.includes(ctx.login)) {
        return reply.code(403).send({ error: `you are not on the ${owning.gate} approver list` });
      }

      // Open-questions guard: approving over open questions needs an explicit,
      // recorded acknowledgement. Computed by the same helper the panel uses —
      // the guard must never see questions the panel did not offer to acknowledge.
      const withEntries = await openGateQuestions(db, epic.id, gateInfo.gate);
      if (withEntries.length > 0 && !req.body?.acknowledgeOpenQuestions) {
        return reply.code(409).send({
          error: `open questions exist on this gate's artifacts: ${withEntries.map((t) => t.title).join(", ")}`,
          openQuestionCount: withEntries.length,
          openQuestions: withEntries,
          hint: "pass acknowledgeOpenQuestions: true to approve anyway (the acknowledgement is recorded)",
        });
      }

      const [owner, name] = repo.fullName.split("/") as [string, string];
      const comment = await postComment(deps, ctx, reply, owner, name, epic.number, APPROVED_BODY);
      if (!comment) return;

      await db.insert(auditLog).values({
        orgId: epic.orgId,
        actorUserId: ctx.userId,
        action: `gate.approve.${gateInfo.gate}`,
        target: `${repo.fullName}#${epic.number}`,
        payload: {
          commentNodeId: comment.node_id,
          commentUrl: comment.html_url,
          acknowledgedOpenQuestions: withEntries.length > 0,
          openQuestionThreads: withEntries.map((t) => t.id),
        },
      });

      // Gate approvals are auto-recorded as decisions (spec 06 §6).
      const artifactRows = await db
        .select({ path: changeArtifacts.path, sha: changeArtifacts.latestSha })
        .from(changeArtifacts)
        .innerJoin(changes, eq(changes.id, changeArtifacts.changeId))
        .where(eq(changes.epicIssueId, epic.id));
      await db.insert(decisions).values({
        orgId: epic.orgId,
        epicIssueId: epic.id,
        title: `${gateInfo.label} approved by @${ctx.login}`,
        context: artifactRows.map((a) => `${a.path}@${a.sha ?? "?"}`).join("\n") || null,
        decidedBy: ctx.login,
        ghCommentNodeId: comment.node_id,
        status: "decided",
      });

      return { ok: true, commentUrl: comment.html_url };
    },
  );

  /** Request changes: by factory semantics, an ordinary comment. */
  app.post<{ Params: { id: string }; Body: { body: string } }>("/api/epics/:id/gate/request-changes", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const body = req.body?.body?.trim();
    if (!body) return reply.code(400).send({ error: "body required" });
    if (body === APPROVED_BODY) return reply.code(400).send({ error: `a request-changes comment cannot be exactly "${APPROVED_BODY}"` });
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const { epic, repo } = found;
    const [owner, name] = repo.fullName.split("/") as [string, string];
    const comment = await postComment(deps, ctx, reply, owner, name, epic.number, body);
    if (!comment) return;
    await db.insert(auditLog).values({
      orgId: epic.orgId,
      actorUserId: ctx.userId,
      action: "gate.request-changes",
      target: `${repo.fullName}#${epic.number}`,
      payload: { commentNodeId: comment.node_id, commentUrl: comment.html_url },
    });
    return { ok: true, commentUrl: comment.html_url };
  });

  /** Merge a PR as the user — G1/G2 manual path and every G3 merge. */
  app.post<{ Params: { id: string } }>("/api/prs/:id/merge", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const pr = (
      await db
        .select({ pr: pullRequests, repoFullName: dsql<string>`(select full_name from repos where repos.id = ${pullRequests.repoId})` })
        .from(pullRequests)
        .where(and(eq(pullRequests.id, req.params.id), inArray(pullRequests.orgId, ctx.orgIds)))
        .limit(1)
    )[0];
    if (!pr) return reply.code(404).send({ error: "PR not found" });
    const [owner, name] = pr.repoFullName.split("/") as [string, string];
    const gh = userClient(deps, ctx);
    try {
      const result = await gh.mergePull(owner, name, pr.pr.number, {
        method: pr.pr.kind === "promotion" ? "merge" : "squash",
      });
      await db.insert(auditLog).values({
        orgId: pr.pr.orgId,
        actorUserId: ctx.userId,
        action: "pr.merge",
        target: `${pr.repoFullName}#${pr.pr.number}`,
        payload: { mergeSha: result.sha, kind: pr.pr.kind },
      });
      await db.update(pullRequests).set({ state: "merged", mergedAt: new Date(), mergeCommitSha: result.sha }).where(eq(pullRequests.id, pr.pr.id));
      return { ok: true, sha: result.sha };
    } catch (err) {
      // GitHub said no — surface that as GitHub's answer, not a Console fault.
      const message = err instanceof GitHubHttpError ? githubMessage(err) : (err as Error).message;
      return reply.code(409).send({ error: `GitHub declined the merge: ${message}` });
    }
  });
}

/**
 * The gates a human passes by commenting the literal `Approved`. G3 is
 * deliberately absent: its merge IS the gate (FACTORY.md §6a), and making it
 * comment-approvable here would let the Console promote to production on a
 * click the factory never accepts.
 */
const COMMENT_APPROVABLE = new Set(["spec", "design", "implementation", "staging"]);

/**
 * What gate GS is deciding on: the epic's tasks and their states, the factory's
 * newest report on the epic (the Release Manager's assembly/dispatch report,
 * which carries the suite results), and any PR still open against it.
 *
 * All of it is already projected — this is a reading of the epic, not a new
 * source of truth, and where the factory has posted nothing yet the panel says
 * so rather than implying the assembly is proven.
 */
async function loadAssemblyEvidence(
  deps: AppDeps,
  epic: typeof issues.$inferSelect,
  repo: typeof repos.$inferSelect,
): Promise<{
  cases: Array<{
    number: number;
    title: string;
    state: string | null;
    open: boolean;
    htmlUrl: string;
    caseId: string | null;
    verdict: "passed" | "failed" | "runnable" | "pending";
    verdictBy: string | null;
    verdictAt: Date | null;
  }>;
  testsOutstanding: number;
  /** The epic's bug reports (§4c) — the other half of the evidence at GS. */
  bugs: Array<{ number: number; title: string; state: string | null; open: boolean; htmlUrl: string }>;
  bugsOpen: number;
  tasks: Array<{ number: number; title: string; state: string | null; open: boolean; htmlUrl: string }>;
  allGreen: boolean;
  report: { author: string | null; at: Date; html: string; htmlUrl: string | null } | null;
  prs: ReturnType<typeof prDto>[];
}> {
  const { db } = deps.dbh;
  const childRows = await db.select().from(issues).where(eq(issues.parentIssueId, epic.id)).orderBy(issues.number);
  const dto = (t: (typeof childRows)[number]) => ({
    number: t.number,
    title: t.title,
    state: t.factoryState,
    open: t.state === "open",
    htmlUrl: t.htmlUrl,
  });
  const tasks = childRows.filter((t) => t.kind !== "test" && t.kind !== "bug").map(dto);
  // The test matrix (FACTORY.md §4b): every case with its verdict and who
  // gave it. This is the evidence gate GS is actually weighed on where a repo
  // runs system tests — the assembly report proves the code built, and the
  // matrix proves a person exercised it.
  const caseRows = childRows.filter((t) => t.kind === "test");
  const verdicts = caseRows.length
    ? await db
        .select({ issueId: comments.issueId, author: comments.author, body: comments.body, at: comments.ghCreatedAt })
        .from(comments)
        .where(inArray(comments.issueId, caseRows.map((c) => c.id)))
        .orderBy(desc(comments.ghCreatedAt))
    : [];
  const verdictOf = new Map<string, { author: string | null; at: Date | null }>();
  for (const v of verdicts) {
    // Newest first, so the first strict-match verdict per case wins.
    if (verdictOf.has(v.issueId)) continue;
    const body = (v.body ?? "").trim();
    if (body === TEST_PASSED_BODY || body === TEST_FAILED_BODY) verdictOf.set(v.issueId, { author: v.author, at: v.at });
  }
  const cases = caseRows.map((c) => ({
    ...dto(c),
    caseId: /^test\(\d+\):\s*(ST-\d+)/i.exec(c.title)?.[1] ?? null,
    verdict:
      c.factoryState === TEST_PASSED_STATE || (!(c.state === "open") && c.factoryState !== TEST_FAILED_STATE)
        ? ("passed" as const)
        : c.factoryState === TEST_FAILED_STATE
          ? ("failed" as const)
          : c.factoryState === MANUAL_TEST_STATE
            ? ("runnable" as const)
            : ("pending" as const),
    verdictBy: verdictOf.get(c.id)?.author ?? null,
    verdictAt: verdictOf.get(c.id)?.at ?? null,
  }));

  // Bug reports (§4c) are children of the epic like cases, and like cases
  // they are neither tasks nor part of the assembly check above.
  const bugs = childRows.filter((t) => t.kind === "bug").map(dto);

  const report = (
    await db
      .select({ author: comments.author, body: comments.body, at: comments.ghCreatedAt, htmlUrl: comments.htmlUrl })
      .from(comments)
      .where(and(eq(comments.issueId, epic.id), eq(comments.isAgent, true)))
      .orderBy(desc(comments.ghCreatedAt))
      .limit(1)
  )[0];

  const prRows = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.issueNumber, epic.number), eq(pullRequests.state, "open")));

  return {
    tasks,
    cases,
    /**
     * Cases neither passed nor abandoned. Rendered as a warning above
     * Approve rather than as a reason to withhold it: the factory holds the
     * gate itself where its policy says to (`mode: gate` with an epic
     * branch), so an epic that is *at* this gate with cases open is one the
     * factory decided not to hold — an advisory repo, a repo with no epic
     * branch, or an epic that adopted its plan after reaching the gate. In
     * every one of those the decision is the approver's, and hiding the
     * button would strand it.
     */
    testsOutstanding: cases.filter((c) => c.verdict !== "passed").length,
    bugs,
    /**
     * Open bug reports (FACTORY.md §4c). Under `mode: gate` with an epic
     * branch the factory refuses `Approved` while any is open, so this is
     * usually zero here — but an advisory repo, or one with no epic branch,
     * reaches this gate with bugs outstanding, and then the approver is the
     * one deciding that is acceptable. Shown for the same reason the case
     * matrix is: it is what they are being asked to weigh.
     */
    bugsOpen: bugs.filter((b) => b.open && b.state !== BUG_VERIFIED_STATE).length,
    // Green at GS means every task has landed: closed, or on the epic branch
    // and beyond. Anything else and the assembly is not what the label claims.
    allGreen: tasks.length > 0 && tasks.every((t) => !t.open || ASSEMBLED_TASK_STATES.has(t.state ?? "")),
    report: report
      ? {
          author: report.author,
          at: report.at,
          html: renderMarkdown(report.body, { repoId: repo.id }),
          htmlUrl: report.htmlUrl,
        }
      : null,
    prs: prRows.map(prDto),
  };
}

/** Task states that count as landed on the epic branch (FACTORY.md §6b). */
const ASSEMBLED_TASK_STATES = new Set(["factory:on-epic", "factory:epic-ready", "factory:in-staging", "factory:deployed"]);

/** Artifact kinds a gate is actually about — the set the gate panel renders. */
function artifactIsRelevant(gate: string, kind: string): boolean {
  if (gate === "spec") return kind === "proposal" || kind === "spec";
  // G2 approves the plan, the design AND the system test plan: the Test
  // Planner commits all of it to the one design PR, and that merge is the
  // only review those cases ever get (FACTORY.md §4b).
  if (gate === "design") return kind === "design" || kind === "tasks" || kind === "test-plan" || kind === "test-data";
  return true;
}

/**
 * The open questions that hold a gate: the gate's own thread plus the threads
 * on the artifacts that gate is about, counting only threads that actually have
 * entries.
 *
 * One definition, called by both the panel and the approve guard. They used to
 * compute two different sets — the panel from the gate's own artifacts, the
 * guard from a fixed proposal/design/tasks list — so a question filed on an
 * artifact belonging to a *later* gate was invisible in the panel (no
 * acknowledge checkbox to tick) yet still blocked approve with a 409. The
 * button looked live, the click posted nothing, and the acknowledgement the
 * server asked for was unreachable.
 */
async function openGateQuestions(
  db: Db,
  epicIssueId: string,
  gate: string,
): Promise<Array<{ id: string; title: string; topicRef: string; entryCount: number }>> {
  const change = (await db.select().from(changes).where(eq(changes.epicIssueId, epicIssueId)).limit(1))[0];
  const artifactRows = change
    ? await db.select({ kind: changeArtifacts.kind }).from(changeArtifacts).where(eq(changeArtifacts.changeId, change.id))
    : [];
  const guardRefs = new Set<string>([
    `gate/${gate}`,
    ...artifactRows.filter((a) => artifactIsRelevant(gate, a.kind)).map((a) => `artifact/${a.kind}`),
  ]);
  const rows = (
    await db
      .select({ id: threads.id, title: threads.title, topicRef: threads.topicRef })
      .from(threads)
      .where(and(eq(threads.epicIssueId, epicIssueId), eq(threads.status, "open")))
  ).filter((t) => guardRefs.has(t.topicRef));
  const counts = await countThreadEntries(db, rows.map((t) => t.id));
  return rows
    .map((t) => ({ ...t, entryCount: counts.get(t.id) ?? 0 }))
    .filter((t) => t.entryCount > 0);
}

function prDto(pr: typeof pullRequests.$inferSelect) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    kind: pr.kind,
    state: pr.state,
    draft: pr.draft,
    ciStatus: pr.ciStatus,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    htmlUrl: pr.htmlUrl,
  };
}
