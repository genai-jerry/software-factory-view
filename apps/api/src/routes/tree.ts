import {
  APPROVED_BODY,
  BUG_RETEST_STATE,
  bugCommentBody,
  bugReportAvailability,
  deriveExpedited,
  epicStatus,
  GATE_STATES,
  IN_PROGRESS_LABEL,
  IN_REVIEW_STATE,
  READY_STATE,
  REVIEW_DONE_BODY,
  MANUAL_TEST_STATE,
  PLAN_TESTS_BODY,
  planTestsAvailability,
  TEST_PASSED_BODY,
  TEST_FAILED_BODY,
  startStatusIsAutomatic,
  startStatusTakesApproval,
} from "@console/core";
import { auditLog, changeArtifacts, changes, comments, gateAssignments, issues, repos, taskDependencies } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps } from "../context.js";
import { loadExpeditedEpics } from "../expedite.js";
import { postComment } from "../gh-write.js";
import { loadGateApprovers, loadTaskStartFacts, nextStepFor, startStatusOf } from "../start-gate.js";
import { loadEpic, loadIssue, taskRollup } from "./read.js";

/**
 * The epic's dependency tree (plan 11 §1): every task sub-issue — sibling-repo
 * ones included — with both directions of the dependency graph and what the
 * viewer can do about each node. The one write here is the task start gate:
 * `Approved` on a `factory:ready` task, posted as the acting user so the
 * factory router starts the implementer untouched — the same discipline as
 * the gate panel (the Console relocates the button, not the authority).
 */

interface TreeDep {
  id: string;
  number: number;
  title: string;
  state: string | null;
  open: boolean;
  htmlUrl: string;
  /** owner/name — render a qualifier when it differs from the node's repo. */
  repo: string;
  inTree: boolean;
}

export function registerTreeRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get<{ Params: { id: string } }>("/api/epics/:id/tree", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const { epic, repo } = found;

    const taskRows = await db
      .select({ issue: issues, repoFullName: repos.fullName })
      .from(issues)
      .innerJoin(repos, eq(repos.id, issues.repoId))
      .where(eq(issues.parentIssueId, epic.id))
      .orderBy(issues.number);
    const taskIds = new Set(taskRows.map((t) => t.issue.id));

    // Both directions of the dependency graph, with each counterpart's repo —
    // an edge may point at an issue outside the epic (another epic's task, an
    // infra issue); it still renders, marked `inTree: false`.
    const dep = (row: { issue: typeof issues.$inferSelect; repoFullName: string }): TreeDep => ({
      id: row.issue.id,
      number: row.issue.number,
      title: row.issue.title,
      state: row.issue.factoryState,
      open: row.issue.state === "open",
      htmlUrl: row.issue.htmlUrl,
      repo: row.repoFullName,
      inTree: taskIds.has(row.issue.id),
    });
    const blockedBy = new Map<string, TreeDep[]>();
    const blocks = new Map<string, TreeDep[]>();
    if (taskIds.size > 0) {
      const ids = [...taskIds];
      const upRows = await db
        .select({ dep: taskDependencies, issue: issues, repoFullName: repos.fullName })
        .from(taskDependencies)
        .innerJoin(issues, eq(issues.id, taskDependencies.blockerIssueId))
        .innerJoin(repos, eq(repos.id, issues.repoId))
        .where(inArray(taskDependencies.blockedIssueId, ids));
      for (const r of upRows) {
        if (!blockedBy.has(r.dep.blockedIssueId)) blockedBy.set(r.dep.blockedIssueId, []);
        blockedBy.get(r.dep.blockedIssueId)!.push(dep(r));
      }
      const downRows = await db
        .select({ dep: taskDependencies, issue: issues, repoFullName: repos.fullName })
        .from(taskDependencies)
        .innerJoin(issues, eq(issues.id, taskDependencies.blockedIssueId))
        .innerJoin(repos, eq(repos.id, issues.repoId))
        .where(inArray(taskDependencies.blockerIssueId, ids));
      for (const r of downRows) {
        if (!blocks.has(r.dep.blockerIssueId)) blocks.set(r.dep.blockerIssueId, []);
        blocks.get(r.dep.blockerIssueId)!.push(dep(r));
      }
      for (const m of [blockedBy, blocks]) for (const v of m.values()) v.sort((a, b) => a.number - b.number);
    }

    // Start-gate approvers (the `implementation` gate): who may put `Approved`
    // on a ready task. Empty list = any collaborator, same as the router.
    const approverRows = await db
      .select()
      .from(gateAssignments)
      .where(and(eq(gateAssignments.estateId, repo.estateId), eq(gateAssignments.gate, "implementation")));
    const approvers = [...new Set(approverRows.map((a) => a.login))];
    const amApprover = approvers.length === 0 || approvers.includes(ctx.login);

    // Only the epic-level gates (G1/G2/G3) — factory:ready is the task start
    // gate and renders on the task nodes, not the epic header.
    const gateInfo = epic.factoryState && epic.state === "open" ? GATE_STATES[epic.factoryState] : undefined;
    const epicGate = gateInfo && gateInfo.gate !== "implementation" ? gateInfo : undefined;

    // The same three-way start-gate reading the Tasks list and the threads
    // use — a node whose implementer is already running says so instead of
    // offering the button that started it.
    const gateApprovers = await loadGateApprovers(deps, repo.estateId);
    const rollup = await taskRollup(deps, epic.id);
    // The marker is the epic's; every node in this tree inherits it.
    const expedited = deriveExpedited(epic.labels);
    const startFacts = await loadTaskStartFacts(
      deps,
      taskRows.filter((t) => t.issue.state === "open" && t.issue.factoryState === READY_STATE).map((t) => t.issue.id),
    );

    return {
      epic: {
        id: epic.id,
        number: epic.number,
        title: epic.title,
        state: epic.factoryState,
        open: epic.state === "open",
        htmlUrl: epic.htmlUrl,
        repo: repo.fullName,
        gate: epicGate ? { gate: epicGate.gate, label: epicGate.label } : null,
        // The same rollup the workspace payload carries, from the same
        // function: the Tree's epic header shows a derived status, and two
        // tabs deriving it from separately-counted tasks would drift.
        rollup,
        status: epicStatus(epic.state === "open" ? epic.factoryState : null, rollup),
        nextStep: nextStepFor(epic.state === "open" ? epic.factoryState : null, gateApprovers, { tasks: rollup, expedited }),
        expedited,
      },
      startGate: { approvers, amApprover },
      nodes: taskRows.map((t) => {
        const up = blockedBy.get(t.issue.id) ?? [];
        const startStatus = startStatusOf(t.issue, startFacts.get(t.issue.id), expedited);
        return {
          id: t.issue.id,
          number: t.issue.number,
          title: t.issue.title,
          state: t.issue.factoryState,
          open: t.issue.state === "open",
          htmlUrl: t.issue.htmlUrl,
          repo: t.repoFullName,
          crossRepo: t.repoFullName !== repo.fullName,
          assignees: (t.issue.assignees as string[] | null) ?? [],
          blockedBy: up,
          blocks: blocks.get(t.issue.id) ?? [],
          waiting: t.issue.state === "open" && up.some((d) => d.open),
          agentHalted: t.issue.factoryState === "factory:blocked",
          nextStep: nextStepFor(t.issue.state === "open" ? t.issue.factoryState : null, gateApprovers, {
            startStatus,
            expedited,
            running: t.issue.labels.includes(IN_PROGRESS_LABEL),
          }),
          startStatus,
          approvable: startStatusTakesApproval(startStatus),
        };
      }),
    };
  });

  /**
   * The task start gate: post the literal `Approved` on a `factory:ready`
   * task as the acting user. Console-side approver check mirrors the router's
   * (`implementation` list; empty = any collaborator) — GitHub enforces for
   * real either way.
   *
   * The start is guarded twice over, because the router is not: a second
   * `Approved` while a run is live starts a second implementer on the same
   * task (the run marker is orthogonal to the state, FACTORY.md §3). The
   * buttons are gone from every tab once a task is approved, and this refuses
   * the post for a stale tab that still shows one.
   */
  app.post<{ Params: { id: string } }>("/api/issues/:id/approve", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadIssue(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "issue not found" });
    const { issue, repo } = found;
    if (issue.state !== "open" || issue.factoryState !== READY_STATE) {
      return reply.code(409).send({
        error: "only an open task at factory:ready takes a start approval — epic gates go through the gate panel",
      });
    }
    // Expedite makes the start automatic, not forbidden: nothing is running
    // and nothing is approved at `auto`, so a human taking the stage over by
    // hand is safe — it is only the *offer* that has to go, and that is the
    // `approvable` flag the tabs read. The double-start guard below still
    // covers the two statuses that mean a run is in flight.
    const expedited = issue.parentIssueId
      ? (await loadExpeditedEpics(deps, [issue.parentIssueId])).has(issue.parentIssueId)
      : false;
    const startStatus = startStatusOf(issue, (await loadTaskStartFacts(deps, [issue.id])).get(issue.id), expedited);
    if (!startStatusTakesApproval(startStatus) && !startStatusIsAutomatic(startStatus)) {
      return reply.code(409).send({
        error:
          startStatus === "running"
            ? `an implementer is already running on #${issue.number} — approving again would start a second one`
            : `#${issue.number} is already approved and waiting for the factory to start the implementer`,
        startStatus,
      });
    }
    const approverRows = await db
      .select()
      .from(gateAssignments)
      .where(and(eq(gateAssignments.estateId, repo.estateId), eq(gateAssignments.gate, "implementation")));
    const approvers = [...new Set(approverRows.map((a) => a.login))];
    if (approvers.length > 0 && !approvers.includes(ctx.login)) {
      return reply.code(403).send({ error: `starting implementers is assigned to: ${approvers.join(", ")}` });
    }

    const [owner, name] = repo.fullName.split("/") as [string, string];
    const comment = await postComment(deps, ctx, reply, owner, name, issue.number, APPROVED_BODY);
    if (!comment) return;
    await db.insert(auditLog).values({
      orgId: issue.orgId,
      actorUserId: ctx.userId,
      action: "task.approve",
      target: `${repo.fullName}#${issue.number}`,
      payload: { commentNodeId: comment.node_id, commentUrl: comment.html_url },
    });
    // Project the approval we just posted, rather than waiting for its webhook
    // to come back around: the tabs refetch the moment this returns, and an
    // approval the projection has not heard of yet would draw the button again
    // for as long as the round trip takes. The worker's own projection upserts
    // on the same node id, so this is the same row, written earlier.
    if (comment.node_id && typeof comment.id === "number") {
      const at = comment.created_at ? new Date(comment.created_at) : new Date();
      try {
        await db
          .insert(comments)
          .values({
            orgId: issue.orgId,
            issueId: issue.id,
            ghNodeId: comment.node_id,
            ghId: comment.id,
            author: comment.user?.login ?? ctx.login,
            body: APPROVED_BODY,
            isAgent: false,
            isApproval: true,
            htmlUrl: comment.html_url,
            ghCreatedAt: at,
            ghUpdatedAt: comment.updated_at ? new Date(comment.updated_at) : at,
          })
          .onConflictDoNothing({ target: comments.ghNodeId });
      } catch (err) {
        req.log.warn({ err }, "could not record the approval locally — the webhook projection will");
      }
    }
    return { ok: true, commentUrl: comment.html_url };
  });

  /**
   * Skip the Reviewer: post the literal `Review Done` on a `factory:in-review`
   * task as the acting user, same discipline as the start gate above — the
   * router does the relabel untouched. There is no changes-requested
   * equivalent here; a human who found problems reviews the draft PR
   * directly on GitHub instead of pressing this.
   */
  app.post<{ Params: { id: string } }>("/api/issues/:id/mark-reviewed", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadIssue(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "issue not found" });
    const { issue, repo } = found;
    if (issue.state !== "open" || issue.factoryState !== IN_REVIEW_STATE) {
      return reply.code(409).send({ error: "only an open task at factory:in-review can be marked reviewed" });
    }
    if (issue.labels.includes(IN_PROGRESS_LABEL)) {
      return reply.code(409).send({
        error: `a factory run is already live on #${issue.number} — the Reviewer may be running this verdict right now`,
      });
    }
    const [owner, name] = repo.fullName.split("/") as [string, string];
    const comment = await postComment(deps, ctx, reply, owner, name, issue.number, REVIEW_DONE_BODY);
    if (!comment) return;
    await db.insert(auditLog).values({
      orgId: issue.orgId,
      actorUserId: ctx.userId,
      action: "task.mark-reviewed",
      target: `${repo.fullName}#${issue.number}`,
      payload: { commentNodeId: comment.node_id, commentUrl: comment.html_url },
    });
    return { ok: true, commentUrl: comment.html_url };
  });

  /**
   * Record a system test verdict (FACTORY.md §4b): post the literal
   * `Test Passed` or `Test Failed` on a `factory:manual-test` case as the
   * acting user, and let the router do everything else — close the case, or
   * file the fix task and park it.
   *
   * Evidence goes first, as an ordinary comment, so the strict-match verdict
   * is the newest comment on the thread. The router matches the body exactly;
   * a verdict with a paragraph of observations appended would simply not be
   * one, and the tester's report would vanish into a comment nobody acts on.
   *
   * Authorisation is the factory's, not ours: `Test Passed` is checked
   * against the `testers` list (falling back to `implementation`) by the
   * router when it reads the comment. What this endpoint enforces is only
   * that the case is in a state where a verdict means anything — the same
   * discipline as the start gate and `Review Done` above.
   */
  app.post<{ Params: { id: string }; Body: { verdict?: string; evidence?: string } }>(
    "/api/issues/:id/test-verdict",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const verdict = req.body?.verdict;
      if (verdict !== "passed" && verdict !== "failed") {
        return reply.code(400).send({ error: "verdict must be \"passed\" or \"failed\"" });
      }
      const found = await loadIssue(deps, ctx, req.params.id);
      if (!found) return reply.code(404).send({ error: "issue not found" });
      const { issue, repo } = found;
      // The same two words answer a bug's re-test (FACTORY.md §4c), from the
      // same list, so one endpoint carries both: `factory:bug-retest` is where
      // a report is waiting for exactly this.
      const verdictable = issue.factoryState === MANUAL_TEST_STATE || issue.factoryState === BUG_RETEST_STATE;
      if (issue.state !== "open" || !verdictable) {
        return reply.code(409).send({
          error:
            "only an open system test case at factory:manual-test, or a bug report at factory:bug-retest, can take a verdict",
        });
      }
      const [owner, name] = repo.fullName.split("/") as [string, string];
      // The evidence first, so the verdict is the newest comment and the
      // router's strict match sees it.
      const evidence = (req.body?.evidence ?? "").trim();
      if (evidence) {
        const note = await postComment(deps, ctx, reply, owner, name, issue.number, evidence);
        if (!note) return;
      }
      const body = verdict === "passed" ? TEST_PASSED_BODY : TEST_FAILED_BODY;
      const comment = await postComment(deps, ctx, reply, owner, name, issue.number, body);
      if (!comment) return;
      await db.insert(auditLog).values({
        orgId: issue.orgId,
        actorUserId: ctx.userId,
        action: issue.factoryState === BUG_RETEST_STATE ? `bug.retest-${verdict}` : `test.${verdict}`,
        target: `${repo.fullName}#${issue.number}`,
        payload: { commentNodeId: comment.node_id, commentUrl: comment.html_url, hadEvidence: Boolean(evidence) },
      });
      return { ok: true, commentUrl: comment.html_url };
    },
  );

  /**
   * Ask the Test Planner for a system test plan (FACTORY.md §4b, adoption):
   * post the literal `Plan tests` on the epic as the acting user, exactly as
   * the gate buttons post `Approved`. The router does the rest — it starts
   * the Test Planner, which writes `system-tests/test-plan.md` and
   * `test-data.md` and opens one sub-issue per case.
   *
   * The guard is `planTestsAvailability`, the same function the payload uses
   * to decide whether to draw the button, so a click that the screen offered
   * cannot be refused here and a click on a stale screen is refused with the
   * reason the screen would have shown. Nothing about authorisation is
   * decided here: the factory checks the commenter's access itself, and the
   * comment is posted under their own GitHub identity.
   */
  app.post<{ Params: { id: string } }>("/api/epics/:id/plan-tests", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const { epic, repo } = found;

    const children = await db
      .select({ kind: issues.kind })
      .from(issues)
      .where(eq(issues.parentIssueId, epic.id));
    const change = (await db.select().from(changes).where(eq(changes.epicIssueId, epic.id)).limit(1))[0];
    const planArtifact = change
      ? (
          await db
            .select({ id: changeArtifacts.id })
            .from(changeArtifacts)
            .where(and(eq(changeArtifacts.changeId, change.id), eq(changeArtifacts.kind, "test-plan")))
            .limit(1)
        )[0]
      : undefined;

    const availability = planTestsAvailability({
      state: epic.factoryState,
      open: epic.state === "open",
      kind: epic.kind,
      labels: epic.labels,
      systemTests: repo.systemTests,
      hasPlan: Boolean(planArtifact) || children.some((c) => c.kind === "test"),
    });
    if (!availability.offered) return reply.code(409).send({ error: availability.reason });

    const [owner, name] = repo.fullName.split("/") as [string, string];
    const comment = await postComment(deps, ctx, reply, owner, name, epic.number, PLAN_TESTS_BODY);
    if (!comment) return;
    await db.insert(auditLog).values({
      orgId: epic.orgId,
      actorUserId: ctx.userId,
      action: "epic.plan-tests",
      target: `${repo.fullName}#${epic.number}`,
      payload: { commentNodeId: comment.node_id, commentUrl: comment.html_url },
    });
    return { ok: true, commentUrl: comment.html_url };
  });

  /**
   * Raise a bug against an epic under test (FACTORY.md §4c): post the `Bug`
   * comment on the epic as the acting user, and let the router do the rest —
   * open the `bug(<epic>)` report, file the task that fixes it, and link the
   * two.
   *
   * The title and the report go in **one** comment, because this is the one
   * factory control that reads past its first line. Splitting them the way the
   * verdict endpoint splits evidence from the verdict would put the tester's
   * observation in a comment nothing routes, and file a fix quoting nothing.
   *
   * The guard is `bugReportAvailability`, the same function the payload uses
   * to decide whether to draw the control, so a click the screen offered
   * cannot be refused here and a click on a stale screen is refused with the
   * reason the screen would have shown. Authorisation stays the factory's: it
   * checks the commenter's access itself, and the comment is posted under
   * their own GitHub identity.
   */
  app.post<{ Params: { id: string }; Body: { title?: string; report?: string } }>(
    "/api/epics/:id/bugs",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const title = (req.body?.title ?? "").trim();
      const report = (req.body?.report ?? "").trim();
      if (!title) return reply.code(400).send({ error: "a bug needs a one-line title" });
      if (!report) {
        return reply.code(400).send({
          error: "a bug needs the report: what you saw, what you did and what you expected",
        });
      }
      const found = await loadEpic(deps, ctx, req.params.id);
      if (!found) return reply.code(404).send({ error: "epic not found" });
      const { epic, repo } = found;
      const availability = bugReportAvailability({
        state: epic.factoryState,
        open: epic.state === "open",
        kind: epic.kind,
        labels: epic.labels,
        bugReports: repo.bugReports,
      });
      if (!availability.offered) return reply.code(409).send({ error: availability.reason });

      const [owner, name] = repo.fullName.split("/") as [string, string];
      const comment = await postComment(deps, ctx, reply, owner, name, epic.number, bugCommentBody(title, report));
      if (!comment) return;
      await db.insert(auditLog).values({
        orgId: epic.orgId,
        actorUserId: ctx.userId,
        action: "epic.report-bug",
        target: `${repo.fullName}#${epic.number}`,
        payload: { commentNodeId: comment.node_id, commentUrl: comment.html_url, title },
      });
      return { ok: true, commentUrl: comment.html_url };
    },
  );
}
