import {
  BUG_RETEST_STATE,
  BUG_VERIFIED_STATE,
  bugReportAvailability,
  decryptSecret,
  deriveExpedited,
  epicStatus,
  factoryRunIsPending,
  GATE_STATES,
  IN_PROGRESS_LABEL,
  githubActionsEnabled,
  MANUAL_TEST_STATE,
  TEST_FAILED_STATE,
  TEST_PASSED_STATE,
  PIPELINE_ORDER,
  planTestsAvailability,
  READY_STATE,
  startStatusTakesApproval,
  tasksInFlight,
} from "@console/core";
import {
  artifactCache,
  auditLog,
  changeArtifacts,
  changes,
  comments,
  decisions,
  estates,
  gateAssignments,
  gateViews,
  issues,
  issueStateHistory,
  memberships,
  orgs,
  pullRequests,
  repos,
  runs,
  taskDependencies,
  threadEntries,
  threads,
  users,
  webhookDeliveries,
} from "@console/db";
import { and, desc, eq, ilike, inArray, isNotNull, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildAttention } from "../attention.js";
import { EXPEDITE_ACTIONS, expediteAvailability, loadLastExpediteFlip } from "../expedite.js";
import { loadApproversForGate, loadGateApprovers, loadTaskStartFacts, nextStepFor, startStatusOf } from "../start-gate.js";
import { requireAuth, resolveSession, userClient, type AppDeps, type RequestCtx } from "../context.js";
import { fetchGitHubMedia, isGitHubMediaUrl } from "../media.js";
import { renderMarkdown } from "../render.js";
import { countThreadEntries } from "../threads.js";

/** Read surface. Every query is scoped to the caller's orgs at the data layer. */
export function registerReadRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  /**
   * Who the caller is. Deliberately not behind requireAuth's membership check:
   * "signed in, member of nothing" is a true answer, and it is the state every
   * first user of a Console is in — membership is granted by connecting an
   * estate, which is a screen the shell can only offer once it knows who it is
   * talking to. Answering 403 here made that a dead end. The org scope still
   * guards every route that returns estate data.
   */
  app.get("/api/me", async (req, reply) => {
    const ctx = await resolveSession(deps, req);
    if (!ctx) return reply.code(401).send({ error: "not signed in" });
    const user = (await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1))[0]!;
    const orgRows = await db
      .select({ id: orgs.id, name: orgs.name, role: memberships.role })
      .from(memberships)
      .innerJoin(orgs, eq(orgs.id, memberships.orgId))
      .where(eq(memberships.userId, ctx.userId));
    return { login: user.login, name: user.name, avatarUrl: user.avatarUrl, orgs: orgRows };
  });

  /** Proxy GitHub-hosted issue/comment images with installation or user auth. */
  app.get<{ Params: { repoId: string }; Querystring: { url?: string } }>("/api/media/:repoId", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const url = req.query.url?.trim();
    if (!url || !isGitHubMediaUrl(url)) return reply.code(400).send({ error: "unsupported or missing media url" });

    const row = (
      await db
        .select({ repo: repos, estate: estates })
        .from(repos)
        .innerJoin(estates, eq(estates.id, repos.estateId))
        .where(and(eq(repos.id, req.params.repoId), inArray(repos.orgId, ctx.orgIds)))
        .limit(1)
    )[0];
    if (!row) return reply.code(404).send({ error: "repo not found" });

    let token: string;
    try {
      const auth = await deps.credentials.auth();
      if (auth) {
        token = await auth.installationToken(row.estate.installationId);
      } else {
        token = await ctx.userToken();
      }
    } catch {
      try {
        token = await ctx.userToken();
      } catch {
        return reply.code(503).send({ error: "no GitHub credentials available to fetch media" });
      }
    }

    try {
      const { body, contentType } = await fetchGitHubMedia(url, token);
      reply.header("content-type", contentType);
      reply.header("cache-control", "private, max-age=3600");
      return reply.send(body);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get("/api/estates", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const estateRows = await db.select().from(estates).where(inArray(estates.orgId, ctx.orgIds));

    // Ingestion health: when the projections look empty, the difference
    // between "no webhook ever arrived" (App webhook URL/secret broken) and
    // "webhooks arrive but sit unprocessed" (worker or Redis down) is the
    // whole diagnosis — surface it instead of leaving the operator to guess.
    const ingestion = (
      await db
        .select({
          lastReceivedAt: dsql<Date | null>`max(${webhookDeliveries.receivedAt})`,
          lastProcessedAt: dsql<Date | null>`max(${webhookDeliveries.processedAt})`,
          pending: dsql<number>`count(*) filter (where ${webhookDeliveries.processedAt} is null)`,
        })
        .from(webhookDeliveries)
    )[0]!;

    const out = [];
    const staleMs = deps.cfg.STALENESS_THRESHOLD_MINUTES * 60_000;
    const backedUpSince = await oldestUnprocessedDelivery(db);
    for (const e of estateRows) {
      const fresh = freshnessOf(e.lastSyncedAt, backedUpSince, staleMs);
      const repoRows = await db.select().from(repos).where(eq(repos.estateId, e.id));
      out.push({
        id: e.id,
        name: e.name,
        lastSyncedAt: e.lastSyncedAt,
        stale: fresh.stale,
        staleReason: fresh.reason,
        repos: repoRows.map((r) => ({
          id: r.id,
          fullName: r.fullName,
          defaultBranch: r.defaultBranch,
          stagingBranch: r.stagingBranch,
          factoryEnabled: r.factoryEnabled,
          lastSyncedAt: r.lastSyncedAt,
        })),
      });
    }
    return {
      estates: out,
      ingestion: {
        lastReceivedAt: ingestion.lastReceivedAt,
        lastProcessedAt: ingestion.lastProcessedAt,
        pending: Number(ingestion.pending),
      },
    };
  });

  /**
   * The attention queue — a query, not a table (spec 02 §3), with ownership
   * routing and ranks so an agent halted on *you* outranks broadcast noise.
   * The full derivation lives in ../attention.ts, shared with /api/my-work.
   */
  app.get<{ Querystring: RepoFilterQuery }>("/api/attention", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repoFilter = await resolveRepoFilter(deps, ctx, req.query);
    if (repoFilter && repoFilter.length === 0) return { entries: [] };
    return { entries: await buildAttention(deps, ctx, repoFilter ?? undefined) };
  });

  /** Pipeline board: epics as cards in state-machine columns, one lane per estate. */
  app.get<{ Querystring: RepoFilterQuery }>("/api/board", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repoFilter = await resolveRepoFilter(deps, ctx, req.query);
    if (repoFilter && repoFilter.length === 0) return { columns: PIPELINE_ORDER, cards: [] };
    const epicRows = await db
      .select({ issue: issues, repoFullName: repos.fullName, estateId: repos.estateId })
      .from(issues)
      .innerJoin(repos, eq(repos.id, issues.repoId))
      .where(
        and(
          inArray(issues.orgId, ctx.orgIds),
          eq(issues.kind, "epic"),
          ...(repoFilter ? [inArray(issues.repoId, repoFilter)] : []),
        ),
      );

    const cards = [];
    for (const row of epicRows) {
      const rollup = await taskRollup(deps, row.issue.id);
      const lastTransition = (
        await db
          .select({ at: issueStateHistory.occurredAt })
          .from(issueStateHistory)
          .where(eq(issueStateHistory.issueId, row.issue.id))
          .orderBy(desc(issueStateHistory.occurredAt))
          .limit(1)
      )[0];
      const sinceMs = Date.now() - (lastTransition?.at ?? row.issue.ghCreatedAt ?? row.issue.ghUpdatedAt).getTime();
      cards.push({
        epicId: row.issue.id,
        number: row.issue.number,
        title: row.issue.title,
        repo: row.repoFullName,
        estateId: row.estateId,
        state: row.issue.factoryState,
        open: row.issue.state === "open",
        daysInState: Math.floor(sinceMs / 86_400_000),
        blocked: rollup.blocked > 0 || row.issue.factoryState === "factory:blocked",
        // The marker changes what the card's state means — an expedited epic
        // advances between the two remaining gates on its own — so the board
        // says so rather than leaving the reader to open the workspace.
        expedited: deriveExpedited(row.issue.labels),
        tasks: rollup,
      });
    }
    return { columns: PIPELINE_ORDER, cards };
  });

  /** The epic workspace payload: everything the shell needs in one round trip. */
  app.get<{ Params: { id: string } }>("/api/epics/:id", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const { epic, repo } = found;

    const rollup = await taskRollup(deps, epic.id);
    const taskRows = await db
      .select()
      .from(issues)
      .where(eq(issues.parentIssueId, epic.id))
      .orderBy(issues.number);
    const deps_ = await loadDependencies(
      deps,
      taskRows.map((t) => t.id),
    );
    // Bug reports (FACTORY.md §4c) are children of the epic like tasks and
    // cases, and belong on neither the board nor the case list: the board
    // would offer a start on somebody's evidence, and the case list would
    // read a report as a case that was never planned. They get their own
    // section, so they are split out here once.
    const bugRows = taskRows.filter((t) => t.kind === "bug");
    const codeAndCaseRows = taskRows.filter((t) => t.kind !== "bug");

    const change = (await db.select().from(changes).where(eq(changes.epicIssueId, epic.id)).limit(1))[0];
    const artifacts = change
      ? await db.select().from(changeArtifacts).where(eq(changeArtifacts.changeId, change.id))
      : [];

    const threadBase = await db
      .select({
        id: threads.id,
        topicKind: threads.topicKind,
        topicRef: threads.topicRef,
        title: threads.title,
        status: threads.status,
      })
      .from(threads)
      .where(eq(threads.epicIssueId, epic.id));
    const threadCounts = await countThreadEntries(db, threadBase.map((t) => t.id));
    const threadRows = threadBase.map((t) => ({ ...t, entryCount: threadCounts.get(t.id) ?? 0 }));

    const gateInfo = epic.factoryState ? GATE_STATES[epic.factoryState] : undefined;
    let myGate: { gate: string; label: string; amApprover: boolean; approvers: string[] } | null = null;
    if (gateInfo && epic.state === "open") {
      // Down the fallback chain, so GS finds the `release` list on an estate
      // whose approver file has no `staging` key yet.
      const owning = await loadApproversForGate(deps, repo.estateId, gateInfo.gate);
      myGate = {
        gate: gateInfo.gate,
        label: gateInfo.label,
        amApprover: owning.approvers.length === 0 || owning.approvers.includes(ctx.login),
        approvers: owning.approvers,
      };
    }

    // Expedite: the marker on the epic, whether the toggle may be pressed, and
    // the Console's own record of the last flip. The label is the state — this
    // is read from the projection like everything else on this payload.
    const expedited = deriveExpedited(epic.labels);
    const expediteState = expediteAvailability(epic);
    const lastFlip = await loadLastExpediteFlip(deps, epic.orgId, `${repo.fullName}#${epic.number}`);

    // The task start gate (the `implementation` gate): who may put `Approved`
    // on a `factory:ready` task. Same shape the tree tab reads, so every tab
    // renders the one Approve button under the same rule. Empty list = any
    // collaborator, matching the router.
    const startApproverRows = await db
      .select()
      .from(gateAssignments)
      .where(and(eq(gateAssignments.estateId, repo.estateId), eq(gateAssignments.gate, "implementation")));
    const startApprovers = [...new Set(startApproverRows.map((a) => a.login))];
    const startGate = {
      approvers: startApprovers,
      amApprover: startApprovers.length === 0 || startApprovers.includes(ctx.login),
    };

    // Where each ready task actually stands at the start gate: untouched,
    // approved and waiting for the run, or with an implementer already on it.
    // The state label alone cannot tell those apart (see core/start-gate.ts).
    const startFacts = await loadTaskStartFacts(
      deps,
      codeAndCaseRows.filter((t) => t.state === "open" && t.factoryState === READY_STATE).map((t) => t.id),
    );

    // "What now?" for the epic and for every task, with each gate's approver
    // list filled in — the same answer the factory posts on the issue when a
    // run ends, shown beside the state it belongs to.
    const gateApprovers = await loadGateApprovers(deps, repo.estateId);

    // A test plan exists when either half of it is visible: the plan document
    // in the change folder, or the cases the Test Planner mirrored out of it.
    // Either alone is enough — the documents land before the sub-issues on a
    // fresh epic, and an adopted epic's plan can be merged long after.
    const plan = artifacts.find((a) => a.kind === "test-plan") ?? null;
    const hasPlan = Boolean(plan) || taskRows.some((t) => t.kind === "test");

    const blockedSubs = codeAndCaseRows.filter((t) => t.factoryState === "factory:blocked");
    const estate = (await db.select().from(estates).where(eq(estates.id, repo.estateId)).limit(1))[0];
    const org = (await db.select().from(orgs).where(eq(orgs.id, repo.orgId)).limit(1))[0];
    const staleMs = deps.cfg.STALENESS_THRESHOLD_MINUTES * 60_000;
    const backedUpSince = await oldestUnprocessedDelivery(db);
    const actions = githubActionsEnabled(org?.orchestrator);
    // The Dispatcher's output is on the tasks, never on the epic — it releases
    // them and leaves `factory:design-approved` where it is. So "has the
    // factory started?" is answered by whether any task has moved, not by the
    // epic's own label, which would answer "no" for the whole build.
    const dispatched = rollup.ready + rollup.inFlight + rollup.done > 0;
    const pending = factoryRunIsPending({
      open: epic.state === "open",
      labels: epic.labels,
      started: dispatched,
    });

    return {
      epic: {
        id: epic.id,
        number: epic.number,
        title: epic.title,
        bodyHtml: epic.body ? renderMarkdown(epic.body, { repoId: repo.id }) : "",
        state: epic.factoryState,
        open: epic.state === "open",
        author: epic.author,
        htmlUrl: epic.htmlUrl,
        labels: epic.labels,
        status: epicStatus(epic.state === "open" ? epic.factoryState : null, rollup, rollup.tests),
        nextStep: nextStepFor(epic.state === "open" ? epic.factoryState : null, gateApprovers, { tasks: rollup, expedited }),
      },
      /**
       * The toggle's whole state: on/off from the label, whether it may be
       * pressed here and why not, and who last flipped it through the Console.
       * `lastFlip.on` with `on: false` is the factory having taken the marker
       * back off — it reverts an application from someone it does not accept
       * and leaves its reason on the epic.
       */
      expedite: {
        on: expedited,
        available: expediteState.available,
        dormant: expediteState.dormant,
        reason: expediteState.reason,
        lastFlip: lastFlip ? { on: lastFlip.on, actor: lastFlip.actor, at: lastFlip.at } : null,
      },
      repo: { id: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch },
      pipeline: PIPELINE_ORDER,
      gate: myGate,
      startGate,
      tasks: codeAndCaseRows.map((t) => {
        // A task inherits its epic's marker — the factory never copies the
        // label down, so the epic's answer is the task's answer.
        const startStatus = startStatusOf(t, startFacts.get(t.id), expedited);
        return {
          id: t.id,
          number: t.number,
          title: t.title,
          // `task` or `test` (FACTORY.md §4b). A case is a child of the epic
          // like a task, and everything downstream treats it differently:
          // it is grouped apart, counted apart, and offers a verdict where a
          // task offers a start.
          kind: t.kind,
          caseId: caseIdOf(t.title),
          state: t.factoryState,
          open: t.state === "open",
          htmlUrl: t.htmlUrl,
          blockedBy: deps_.get(t.id)?.blockedBy ?? [],
          blocks: deps_.get(t.id)?.blocks ?? [],
          nextStep: nextStepFor(t.state === "open" ? t.factoryState : null, gateApprovers, {
            startStatus,
            expedited,
            running: t.labels.includes(IN_PROGRESS_LABEL),
          }),
          startStatus,
          approvable: startStatusTakesApproval(startStatus),
        };
      }),
      rollup,
      blockedSubIssues: blockedSubs.map((t) => ({ id: t.id, number: t.number, title: t.title, htmlUrl: t.htmlUrl })),
      change: change ? { id: change.id, slug: change.slug, status: change.status } : null,
      artifacts: artifacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        path: a.path,
        latestSha: a.latestSha,
        mergedSha: a.mergedSha,
        diverged: Boolean(a.latestSha && a.mergedSha && a.latestSha !== a.mergedSha),
      })),
      threads: threadRows,
      /**
       * The epic's system-test standing (FACTORY.md §4b), for the Tests tab:
       * the repo's policy as mirrored from `.github/factory-testing.json`,
       * whether a plan exists at all, where that plan is, and whether the
       * Console may offer to write one.
       *
       * `enabled: null` is a repo whose policy has not been read yet — not a
       * repo with tests off. The two must stay distinct here, because the
       * action's whole point is the epic that has no cases.
       */
      /**
       * The epic's bug reports (FACTORY.md §4c) and the one action that
       * raises another: the Tests tab renders both beside the cases, because
       * a bug is what the same tester found while running them.
       *
       * `enabled: null` is an unread policy, not bugs being off — the same
       * distinction `systemTests` makes, for the same reason.
       */
      bugs: {
        enabled: repo.bugReports,
        rows: bugRows.map((b) => ({
          id: b.id,
          number: b.number,
          title: b.title,
          state: b.factoryState,
          open: b.state === "open",
          htmlUrl: b.htmlUrl,
          /** The task(s) filed to fix it, as projected dependencies. */
          fixes: deps_.get(b.id)?.blockedBy ?? [],
          nextStep: nextStepFor(b.state === "open" ? b.factoryState : null, gateApprovers, {}),
        })),
        report: bugReportAvailability({
          state: epic.factoryState,
          open: epic.state === "open",
          kind: epic.kind,
          labels: epic.labels,
          bugReports: repo.bugReports,
        }),
      },
      systemTests: {
        enabled: repo.systemTests,
        mode: (repo.testMode as "gate" | "advisory" | null) ?? null,
        planned: hasPlan,
        plan: plan
          ? {
              path: plan.path,
              // The Dispatcher releases a case only once its plan is merged on
              // the epic's home branch, so an unmerged plan is the reason a
              // case that looks ready is not runnable yet.
              merged: Boolean(plan.mergedSha),
            }
          : null,
        planTests: planTestsAvailability({
          state: epic.factoryState,
          open: epic.state === "open",
          kind: epic.kind,
          labels: epic.labels,
          systemTests: repo.systemTests,
          hasPlan,
        }),
      },
      freshness: {
        lastSyncedAt: estate?.lastSyncedAt ?? null,
        ...(() => {
          const f = freshnessOf(estate?.lastSyncedAt, backedUpSince, staleMs);
          return { stale: f.stale, staleReason: f.reason };
        })(),
      },
      orchestrator: {
        engine: actions ? "github-actions" : "software-factory",
        githubActionsEnabled: actions,
        canStart: !actions && pending,
      },
    };
  });

  /** Timeline: state history + workflow runs, interleaved. */
  app.get<{ Params: { id: string } }>("/api/epics/:id/timeline", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const { epic, repo } = found;

    const taskIds = (await db.select({ id: issues.id }).from(issues).where(eq(issues.parentIssueId, epic.id))).map((r) => r.id);
    const history = await db
      .select()
      .from(issueStateHistory)
      .where(inArray(issueStateHistory.issueId, [epic.id, ...taskIds]))
      .orderBy(desc(issueStateHistory.occurredAt))
      .limit(200);
    const runRows = await db
      .select()
      .from(runs)
      .where(eq(runs.repoId, repo.id))
      .orderBy(desc(runs.startedAt))
      .limit(100);

    // Expedite flips. The projection records label events only for STATE
    // labels (worker: projectLabelEvent), and the marker deliberately is not
    // one — so the audit trail of the Console's own writes is where "who asked
    // for this, and when" lives. A flip made on GitHub instead shows up as the
    // marker itself, on the epic, not as a row here.
    const expediteRows = await db
      .select({ action: auditLog.action, payload: auditLog.payload, at: auditLog.at })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, epic.orgId),
          eq(auditLog.target, `${repo.fullName}#${epic.number}`),
          inArray(auditLog.action, EXPEDITE_ACTIONS),
        ),
      )
      .orderBy(desc(auditLog.at))
      .limit(50);

    const events = [
      ...expediteRows.map((r) => ({
        type: "state" as const,
        at: r.at,
        detail: r.action === "epic.expedite.on" ? "Expedite turned on" : "Expedite turned off",
        actor: typeof r.payload["actor"] === "string" ? r.payload["actor"] : null,
      })),
      ...history.map((h) => ({
        type: "state" as const,
        at: h.occurredAt,
        detail: h.toState ? `→ ${h.toState}` : `− ${h.fromState}`,
        actor: h.actor,
        issueId: h.issueId,
      })),
      ...runRows.map((r) => ({
        type: "run" as const,
        at: r.startedAt ?? r.ghUpdatedAt,
        detail: `${r.role ?? r.workflowName ?? "run"} — ${r.conclusion ?? r.status ?? "running"}`,
        actor: null,
        link: r.htmlUrl,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    return { events };
  });

  /** Artifact reader: decrypt from the immutable cache and render, at either ref. */
  app.get<{ Params: { id: string }; Querystring: { path: string; ref?: "proposed" | "approved" } }>(
    "/api/epics/:id/artifact",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadEpic(deps, ctx, req.params.id);
      if (!found) return reply.code(404).send({ error: "epic not found" });
      const { epic, repo } = found;

      const change = (await db.select().from(changes).where(eq(changes.epicIssueId, epic.id)).limit(1))[0];
      if (!change) return reply.code(404).send({ error: "no change folder discovered for this epic" });
      const artifact = (
        await db
          .select()
          .from(changeArtifacts)
          .where(and(eq(changeArtifacts.changeId, change.id), eq(changeArtifacts.path, req.query.path)))
          .limit(1)
      )[0];
      if (!artifact) return reply.code(404).send({ error: "unknown artifact path" });

      const wantRef = req.query.ref ?? "proposed";
      const sha = wantRef === "approved" ? artifact.mergedSha : artifact.latestSha;
      if (!sha) return reply.code(404).send({ error: `no ${wantRef} version cached` });
      const cached = (
        await db
          .select()
          .from(artifactCache)
          .where(and(eq(artifactCache.repoId, artifact.repoId), eq(artifactCache.path, artifact.path), eq(artifactCache.commitSha, sha)))
          .limit(1)
      )[0];
      if (!cached) return reply.code(404).send({ error: "content not in cache yet — reconcile pending" });

      const content = decryptSecret(cached.encryptedContent, deps.cfg.CONSOLE_MASTER_KEY);
      return {
        path: artifact.path,
        ref: wantRef,
        sha,
        markdown: content,
        html: renderMarkdown(content, { repoId: repo.id }),
        otherSha: wantRef === "approved" ? artifact.latestSha : artifact.mergedSha,
      };
    },
  );

  /** Thread detail with rendered entries. */
  app.get<{ Params: { id: string } }>("/api/threads/:id", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const thread = (
      await db.select().from(threads).where(and(eq(threads.id, req.params.id), inArray(threads.orgId, ctx.orgIds))).limit(1)
    )[0];
    if (!thread) return reply.code(404).send({ error: "thread not found" });

    const epicRow = (
      await db
        .select({ repoId: issues.repoId })
        .from(issues)
        .where(and(eq(issues.id, thread.epicIssueId), inArray(issues.orgId, ctx.orgIds)))
        .limit(1)
    )[0];
    const repoId = epicRow?.repoId;

    const entries = await db
      .select({ entry: threadEntries, comment: comments })
      .from(threadEntries)
      .leftJoin(comments, eq(comments.id, threadEntries.commentId))
      .where(eq(threadEntries.threadId, thread.id))
      .orderBy(threadEntries.createdAt);

    return {
      id: thread.id,
      title: thread.title,
      topicKind: thread.topicKind,
      topicRef: thread.topicRef,
      status: thread.status,
      entries: entries.map(({ entry, comment }) => ({
        id: entry.id,
        source: entry.source,
        author: entry.author ?? comment?.author ?? null,
        bodyHtml: renderMarkdown(comment?.body ?? entry.body ?? "", repoId ? { repoId } : undefined),
        isAgent: comment?.isAgent ?? false,
        isApproval: comment?.isApproval ?? false,
        htmlUrl: comment?.htmlUrl ?? null,
        createdAt: entry.createdAt,
      })),
    };
  });

  /** Decisions: per-epic list and org-wide search. */
  app.get<{ Params: { id: string } }>("/api/epics/:id/decisions", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    const rows = await db
      .select()
      .from(decisions)
      .where(eq(decisions.epicIssueId, found.epic.id))
      .orderBy(desc(decisions.createdAt));
    return { decisions: rows.map(decisionDto) };
  });

  app.get<{ Querystring: { q?: string } }>("/api/decisions", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const q = req.query.q?.trim();
    const rows = await db
      .select()
      .from(decisions)
      .where(
        q
          ? and(inArray(decisions.orgId, ctx.orgIds), ilike(decisions.title, `%${q}%`))
          : inArray(decisions.orgId, ctx.orgIds),
      )
      .orderBy(desc(decisions.createdAt))
      .limit(100);
    return { decisions: rows.map(decisionDto) };
  });

  /** Blocked inbox. */
  app.get<{ Querystring: RepoFilterQuery }>("/api/blocked", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repoFilter = await resolveRepoFilter(deps, ctx, req.query);
    if (repoFilter && repoFilter.length === 0) return { issues: [] };
    const rows = await db
      .select({ issue: issues, repoFullName: repos.fullName })
      .from(issues)
      .innerJoin(repos, eq(repos.id, issues.repoId))
      .where(
        and(
          inArray(issues.orgId, ctx.orgIds),
          eq(issues.factoryState, "factory:blocked"),
          eq(issues.state, "open"),
          ...(repoFilter ? [inArray(issues.repoId, repoFilter)] : []),
        ),
      );
    return {
      issues: rows.map((r) => ({
        id: r.issue.id,
        number: r.issue.number,
        title: r.issue.title,
        repo: r.repoFullName,
        epicId: r.issue.parentIssueId ?? r.issue.id,
        htmlUrl: r.issue.htmlUrl,
        ageDays: Math.floor((Date.now() - r.issue.ghUpdatedAt.getTime()) / 86_400_000),
      })),
    };
  });

  /** Record "I looked at this gate at this sha" for the what-changed diff. */
  app.post<{ Params: { id: string }; Body: { gate: string; sha: string } }>("/api/epics/:id/gate-view", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadEpic(deps, ctx, req.params.id);
    if (!found) return reply.code(404).send({ error: "epic not found" });
    await db
      .insert(gateViews)
      .values({
        orgId: found.epic.orgId,
        userId: ctx.userId,
        epicIssueId: found.epic.id,
        gate: req.body.gate,
        lastViewedSha: req.body.sha,
        lastViewedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [gateViews.userId, gateViews.epicIssueId, gateViews.gate],
        set: { lastViewedSha: req.body.sha, lastViewedAt: new Date() },
      });
    return { ok: true };
  });
}

/* ------------------------------- shared helpers ------------------------------- */

export interface RepoFilterQuery {
  repo?: string;
  project?: string;
}

/**
 * Resolve the ?repo= / ?project= focus filter to a set of repo ids.
 * Returns null for "no filter" (show everything); an array otherwise —
 * possibly empty, which callers must treat as "match nothing" rather than
 * passing an empty inArray() to SQL. A repo filter wins over a project one.
 */
export async function resolveRepoFilter(deps: AppDeps, ctx: RequestCtx, query: RepoFilterQuery): Promise<string[] | null> {
  const { db } = deps.dbh;
  if (query.repo) {
    const rows = await db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.id, query.repo), inArray(repos.orgId, ctx.orgIds)));
    return rows.map((r) => r.id);
  }
  if (query.project) {
    const rows = await db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.projectId, query.project), inArray(repos.orgId, ctx.orgIds)));
    return rows.map((r) => r.id);
  }
  return null;
}

export async function loadEpic(
  deps: AppDeps,
  ctx: RequestCtx,
  epicId: string,
): Promise<{ epic: typeof issues.$inferSelect; repo: typeof repos.$inferSelect } | null> {
  const { db } = deps.dbh;
  const rows = await db
    .select({ epic: issues, repo: repos })
    .from(issues)
    .innerJoin(repos, eq(repos.id, issues.repoId))
    .where(and(eq(issues.id, epicId), inArray(issues.orgId, ctx.orgIds)))
    .limit(1);
  return rows[0] ?? null;
}

/** Any issue in the caller's orgs, with its repo — loadEpic without the epic assumption. */
export async function loadIssue(
  deps: AppDeps,
  ctx: RequestCtx,
  issueId: string,
): Promise<{ issue: typeof issues.$inferSelect; repo: typeof repos.$inferSelect } | null> {
  const { db } = deps.dbh;
  const rows = await db
    .select({ issue: issues, repo: repos })
    .from(issues)
    .innerJoin(repos, eq(repos.id, issues.repoId))
    .where(and(eq(issues.id, issueId), inArray(issues.orgId, ctx.orgIds)))
    .limit(1);
  return rows[0] ?? null;
}

export interface DepNode {
  id: string;
  number: number;
  title: string;
  state: string | null;
  open: boolean;
  htmlUrl: string;
}

/** Both directions of the dependency graph for a set of issues, two batched queries. */
export async function loadDependencies(
  deps: AppDeps,
  issueIds: string[],
): Promise<Map<string, { blockedBy: DepNode[]; blocks: DepNode[] }>> {
  const { db } = deps.dbh;
  const out = new Map<string, { blockedBy: DepNode[]; blocks: DepNode[] }>();
  if (issueIds.length === 0) return out;
  const entry = (id: string) => {
    if (!out.has(id)) out.set(id, { blockedBy: [], blocks: [] });
    return out.get(id)!;
  };
  const node = (i: typeof issues.$inferSelect): DepNode => ({
    id: i.id,
    number: i.number,
    title: i.title,
    state: i.factoryState,
    open: i.state === "open",
    htmlUrl: i.htmlUrl,
  });
  const blockedByRows = await db
    .select({ dep: taskDependencies, other: issues })
    .from(taskDependencies)
    .innerJoin(issues, eq(issues.id, taskDependencies.blockerIssueId))
    .where(inArray(taskDependencies.blockedIssueId, issueIds));
  for (const r of blockedByRows) entry(r.dep.blockedIssueId).blockedBy.push(node(r.other));
  const blocksRows = await db
    .select({ dep: taskDependencies, other: issues })
    .from(taskDependencies)
    .innerJoin(issues, eq(issues.id, taskDependencies.blockedIssueId))
    .where(inArray(taskDependencies.blockerIssueId, issueIds));
  for (const r of blocksRows) entry(r.dep.blockerIssueId).blocks.push(node(r.other));
  for (const v of out.values()) {
    v.blockedBy.sort((a, b) => a.number - b.number);
    v.blocks.sort((a, b) => a.number - b.number);
  }
  return out;
}

/** Green, merged onto a branch, not yet closed — the states between in-test and done. */
const SHIPPING_STATES = new Set(["factory:ready-to-ship", "factory:on-epic", "factory:in-staging"]);

/**
 * An epic's system test cases (FACTORY.md §4b), rolled up beside its code
 * tasks and never mixed into them. A case is a child of the epic like a task
 * is, so without this split a `test(` sub-issue inflates `total` while
 * falling into no bucket — and a passed case, which the router closes, would
 * count as a task done.
 */
/** `test(9): ST-4 Renewal fires` -> `ST-4` — the identifier testers cite. */
function caseIdOf(title: string): string | null {
  return /^test\(\d+\):\s*(ST-\d+)/i.exec(title)?.[1] ?? null;
}

export interface TestRollup {
  total: number;
  passed: number;
  runnable: number;
  failed: number;
  /** Cases neither passed nor abandoned: what the epic still waits on. */
  outstanding: number;
}

/**
 * An epic's bug reports (FACTORY.md §4c), rolled up the same way and for the
 * same reason: a report is a child of the epic that is neither a code task nor
 * a case. `open` is what holds gate GS under `mode: gate` — a defect somebody
 * found that nobody has confirmed repaired.
 */
export interface BugRollup {
  total: number;
  /** Raised; the task fixing it is in flight. */
  fixing: number;
  /** The fix is assembled; a tester has to confirm it. */
  retest: number;
  verified: number;
  /** `fixing + retest` — what the epic still waits on. */
  open: number;
}

export interface TaskRollup {
  total: number;
  ready: number;
  inReview: number;
  inTest: number;
  shipping: number;
  /** Of `shipping`: green and waiting for the Release Manager. */
  readyToShip: number;
  /** Of `shipping`: merged onto the epic branch. */
  onEpic: number;
  done: number;
  blocked: number;
  waiting: number;
  /**
   * `inReview + inTest + shipping` — the tasks an agent has already carried
   * past the start gate. Counted once here (by core, the same function the
   * badge reads) so the browser never re-derives it and drifts.
   */
  inFlight: number;
  /** Absent where the repo runs no system tests, or the epic has no cases. */
  tests?: TestRollup;
  /** Absent where the repo runs no bug reports, or the epic has none. */
  bugs?: BugRollup;
}

export async function taskRollup(deps: AppDeps, epicIssueId: string): Promise<TaskRollup> {
  const { db } = deps.dbh;
  const children = await db
    .select({ id: issues.id, kind: issues.kind, factoryState: issues.factoryState, state: issues.state })
    .from(issues)
    .where(eq(issues.parentIssueId, epicIssueId));
  // Cases and bug reports are counted apart from code tasks — see TestRollup
  // and BugRollup. The task that FIXES a bug is an ordinary task and is
  // counted with the others, which is right: it is code the epic assembles.
  const tasks = children.filter((c) => c.kind !== "test" && c.kind !== "bug");
  const cases = children.filter((c) => c.kind === "test");
  const bugRows = children.filter((c) => c.kind === "bug");
  const tests: TestRollup = { total: cases.length, passed: 0, runnable: 0, failed: 0, outstanding: 0 };
  for (const c of cases) {
    if (c.factoryState === TEST_PASSED_STATE || (c.state === "closed" && c.factoryState !== TEST_FAILED_STATE)) {
      tests.passed++;
    } else if (c.factoryState === TEST_FAILED_STATE) tests.failed++;
    else if (c.factoryState === MANUAL_TEST_STATE) tests.runnable++;
  }
  tests.outstanding = tests.total - tests.passed;
  const bugs: BugRollup = { total: bugRows.length, fixing: 0, retest: 0, verified: 0, open: 0 };
  for (const b of bugRows) {
    // A report closed by hand — "not a defect", a duplicate — holds nothing,
    // exactly as a verified one does. Only an OPEN report is a hold.
    if (b.factoryState === BUG_VERIFIED_STATE || b.state === "closed") bugs.verified++;
    else if (b.factoryState === BUG_RETEST_STATE) bugs.retest++;
    else bugs.fixing++;
  }
  bugs.open = bugs.fixing + bugs.retest;
  const rollup = {
    total: tasks.length,
    ready: 0,
    inReview: 0,
    inTest: 0,
    shipping: 0,
    readyToShip: 0,
    onEpic: 0,
    done: 0,
    blocked: 0,
    waiting: 0,
    inFlight: 0,
    ...(cases.length > 0 ? { tests } : {}),
    ...(bugRows.length > 0 ? { bugs } : {}),
  };
  const openIds: string[] = [];
  for (const t of tasks) {
    if (t.state === "open") openIds.push(t.id);
    if (t.state === "closed" || t.factoryState === "factory:deployed") rollup.done++;
    else if (t.factoryState === "factory:ready") rollup.ready++;
    else if (t.factoryState === "factory:in-review") rollup.inReview++;
    else if (t.factoryState === "factory:in-test") rollup.inTest++;
    // Green and on a branch: ready-to-ship, on-epic and in-staging used to
    // fall through every bucket and be counted only in `total`, so an epic
    // whose every task was waiting on the Release Manager rolled up as
    // "0 done, 0 ready" — reading as if nothing had happened.
    else if (SHIPPING_STATES.has(t.factoryState ?? "")) {
      rollup.shipping++;
      if (t.factoryState === "factory:ready-to-ship") rollup.readyToShip++;
      else if (t.factoryState === "factory:on-epic") rollup.onEpic++;
    }
    else if (t.factoryState === "factory:blocked") rollup.blocked++;
  }
  if (openIds.length > 0) {
    const waiting = await db
      .selectDistinct({ blocked: taskDependencies.blockedIssueId })
      .from(taskDependencies)
      .innerJoin(issues, eq(issues.id, taskDependencies.blockerIssueId))
      .where(and(inArray(taskDependencies.blockedIssueId, openIds), eq(issues.state, "open")));
    rollup.waiting = waiting.length;
  }
  rollup.inFlight = tasksInFlight(rollup);
  return rollup;
}

/** A nightly walk (03:17 UTC) that has not happened in this long was missed. */
const NIGHTLY_WALK_GRACE_MS = 26 * 3_600_000;

/**
 * Whether the Console's copy of an estate may be behind GitHub.
 *
 * `lastSyncedAt` is stamped only by a full reconcile walk, which runs once a
 * night. Webhooks keep the projections current in between without touching
 * it, so testing it against the 15-minute threshold put "this view may be
 * behind GitHub" on screen for all but the quarter hour after the walk, and
 * said nothing when the webhooks themselves stopped arriving. Behind means:
 * the nightly walk was missed, or a webhook has sat unprocessed for longer
 * than the threshold (the worker or its queue is down).
 */
export function freshnessOf(
  lastSyncedAt: Date | null | undefined,
  oldestUnprocessedAt: Date | null | undefined,
  staleMs: number,
  now = Date.now(),
): { stale: boolean; reason: "never-synced" | "walk-missed" | "webhooks-backed-up" | null } {
  if (!lastSyncedAt) return { stale: true, reason: "never-synced" };
  if (oldestUnprocessedAt && now - oldestUnprocessedAt.getTime() > staleMs) {
    return { stale: true, reason: "webhooks-backed-up" };
  }
  if (now - lastSyncedAt.getTime() > NIGHTLY_WALK_GRACE_MS) return { stale: true, reason: "walk-missed" };
  return { stale: false, reason: null };
}

async function oldestUnprocessedDelivery(db: AppDeps["dbh"]["db"]): Promise<Date | null> {
  const row = (
    await db
      .select({ at: dsql<Date | null>`min(${webhookDeliveries.receivedAt})` })
      .from(webhookDeliveries)
      .where(dsql`${webhookDeliveries.processedAt} is null`)
  )[0];
  return row?.at ? new Date(row.at) : null;
}

function decisionDto(d: typeof decisions.$inferSelect) {
  return {
    id: d.id,
    title: d.title,
    context: d.context,
    options: d.options,
    chosen: d.chosen,
    consequences: d.consequences,
    decidedBy: d.decidedBy,
    status: d.status,
    supersedesId: d.supersedesId,
    createdAt: d.createdAt,
  };
}
