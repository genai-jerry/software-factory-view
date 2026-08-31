import { APPROVED_BODY, GATE_STATES, GitHubHttpError, decryptSecret } from "@console/core";
import {
  artifactCache,
  auditLog,
  changeArtifacts,
  changes,
  decisions,
  gateAssignments,
  gateViews,
  pullRequests,
  threads,
  type Db,
} from "@console/db";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, userClient, type AppDeps } from "../context.js";
import { githubMessage, postComment } from "../gh-write.js";
import { countThreadEntries } from "../threads.js";
import { renderMarkdown } from "../render.js";
import { loadEpic } from "./read.js";

/**
 * The gate panel (spec 06 §4): what you are approving, what changed since you
 * last looked, open questions beside the approve control, and the act itself —
 * the literal `Approved` comment posted under the user's own identity so the
 * factory router does the merge + label flip untouched. The Console relocates
 * the button, not the authority.
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
    const approverRows = await db
      .select()
      .from(gateAssignments)
      .where(and(eq(gateAssignments.estateId, repo.estateId), eq(gateAssignments.gate, gateInfo.gate)));
    const approvers = [...new Set(approverRows.map((a) => a.login))];
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
    const relevant = artifactRows.filter((a) => artifactIsRelevant(gateInfo.gate, a.kind));

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

    return {
      gate: gateInfo.gate,
      label: gateInfo.label,
      state: epic.factoryState,
      amApprover,
      approvers,
      commentApprovable: gateInfo.gate === "spec" || gateInfo.gate === "design" || gateInfo.gate === "implementation",
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
      if (gateInfo.gate === "release") {
        return reply.code(409).send({ error: "G3 is not comment-approvable — merge the PRs instead (the merge button is the gate)" });
      }

      // Server-side approver check (UX layer; the router re-checks with authority).
      const approverRows = await db
        .select()
        .from(gateAssignments)
        .where(and(eq(gateAssignments.estateId, repo.estateId), eq(gateAssignments.gate, gateInfo.gate)));
      const approvers = [...new Set(approverRows.map((a) => a.login))];
      if (approvers.length > 0 && !approvers.includes(ctx.login)) {
        return reply.code(403).send({ error: `you are not on the ${gateInfo.gate} approver list` });
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

/** Artifact kinds a gate is actually about — the set the gate panel renders. */
function artifactIsRelevant(gate: string, kind: string): boolean {
  if (gate === "spec") return kind === "proposal" || kind === "spec";
  if (gate === "design") return kind === "design" || kind === "tasks";
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
