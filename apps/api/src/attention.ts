import { EPIC_READY_STATE, GATE_STATES, MANUAL_TEST_STATE, READY_STATE, resolveGateApprovers, startStatusTakesApproval } from "@console/core";
import { comments, estates, gateAssignments, issues, issueStateHistory, pullRequests, repos } from "@console/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { AppDeps, RequestCtx } from "./context.js";
import { loadExpeditedEpics } from "./expedite.js";
import { loadTaskStartFacts, startStatusOf } from "./start-gate.js";

/**
 * The attention queue — a query, not a table (spec 02 §3), re-ranked so an
 * agent halted *on this user specifically* always outranks broadcast entries
 * (plan 07 §4.1 / plan 08 WP1). Ranks:
 *   1  factory:blocked and this user is the best responder
 *      (assignee → author → approver of the stage it halted in)
 *   2  a gate awaiting this user (G1 / G2 / G3), or a fast-track PR awaiting
 *      merge (the fast lane has no gate — the merge is its one human step)
 *   3  a task awaiting this user's implementation `Approved`
 *   4  factory:blocked with no ownership signal — the old broadcast entry,
 *      demoted so ownership always sorts above it
 * Within a rank: age descending. Blocked ages count from the blocked label's
 * own history event, not ghUpdatedAt (which any comment resets).
 *
 * An epic carrying `factory:expedite` surfaces only for the decisions expedite
 * keeps: gate GS at `factory:epic-ready`, gate G3 at `factory:in-staging`,
 * a runnable system test case (FACTORY.md §4b — expedite waives starts, and
 * running a case is not one), and `factory:blocked` at any stage. Its G1/G2 approvals and its tasks' start
 * approvals are the factory's own now, and a queue that goes on asking for
 * them is asking for work nobody owes — the one thing this queue must never do.
 */

export interface AttentionEntryDto {
  kind: "gate" | "blocked" | "task-start" | "merge";
  rank: 1 | 2 | 3 | 4;
  whyYou: string;
  epicId: string;
  issueId: string;
  title: string;
  repo: string;
  state: string | null;
  ageDays: number;
  /** For blocked entries: the agent's actual stuck question, when it left one. */
  question: string | null;
  /** The epic carries `factory:expedite` — rows say so, since it changes what runs itself. */
  expedited: boolean;
  link: string;
}

const DAY_MS = 86_400_000;

export async function buildAttention(deps: AppDeps, ctx: RequestCtx, repoFilter?: string[]): Promise<AttentionEntryDto[]> {
  const { db } = deps.dbh;
  const entries: AttentionEntryDto[] = [];
  if (repoFilter && repoFilter.length === 0) return entries;

  // All gate assignments across the caller's estates, loaded once (the old
  // per-issue query was an N+1). Two views of the same rows: membership
  // lookups for "is this mine", and per-(estate,gate) sets for list-empty and
  // stage-approver routing. Estate-wide rows (repoId null) count for any repo.
  const estateRows = await db.select({ id: estates.id }).from(estates).where(inArray(estates.orgId, ctx.orgIds));
  const estateIds = estateRows.map((e) => e.id);
  const allAssignments = estateIds.length
    ? await db.select().from(gateAssignments).where(inArray(gateAssignments.estateId, estateIds))
    : [];
  const gateApprovers = new Map<string, Set<string>>(); // `${estateId}:${gate}` -> logins
  const myGates = new Set<string>(); // `${estateId}:${repoId|*}:${gate}`
  for (const a of allAssignments) {
    const key = `${a.estateId}:${a.gate}`;
    if (!gateApprovers.has(key)) gateApprovers.set(key, new Set());
    gateApprovers.get(key)!.add(a.login);
    if (a.login === ctx.login) myGates.add(`${a.estateId}:${a.repoId ?? "*"}:${a.gate}`);
  }
  const amOnGate = (estateId: string, repoId: string, gate: string): boolean =>
    myGates.has(`${estateId}:${repoId}:${gate}`) || myGates.has(`${estateId}:*:${gate}`);
  const gateListEmpty = (estateId: string, gate: string): boolean => !gateApprovers.get(`${estateId}:${gate}`)?.size;

  const openFactoryIssues = await db
    .select({ issue: issues, repoFullName: repos.fullName, estateId: repos.estateId, repoId: repos.id })
    .from(issues)
    .innerJoin(repos, eq(repos.id, issues.repoId))
    .where(
      and(
        inArray(issues.orgId, ctx.orgIds),
        eq(issues.state, "open"),
        isNotNull(issues.factoryState),
        ...(repoFilter ? [inArray(issues.repoId, repoFilter)] : []),
      ),
    );

  // Blocked metadata, batched: when each issue was labelled blocked, the state
  // it halted in, and the agent's stuck question.
  const blockedIds = openFactoryIssues.filter((r) => r.issue.factoryState === "factory:blocked").map((r) => r.issue.id);
  const blockedMeta = await loadBlockedMeta(deps, blockedIds);

  // A task at factory:ready has not necessarily kept its start gate open: the
  // state label stays put while the approval is routed and while the
  // implementer runs (core/start-gate.ts). The queue asks for an action, so it
  // lists only the tasks that still take one.
  const startFacts = await loadTaskStartFacts(
    deps,
    openFactoryIssues.filter((r) => r.issue.factoryState === READY_STATE).map((r) => r.issue.id),
  );

  // The expedite marker sits on the epic; a task is expedited because its epic
  // is (the factory never copies the label down), so resolve every row's epic
  // in one query rather than reading the row's own labels — which never carry
  // it for a task, and would silently leave the whole suppression rule off.
  const expeditedEpics = await loadExpeditedEpics(deps, openFactoryIssues.map((r) => r.issue.parentIssueId ?? r.issue.id));

  // Fast-track issues have no gate — their one human step is merging the PR
  // the fast lane opened. Look those PRs up in one batch so the queue can
  // announce them; without this the fast lane finished in silence.
  const fastTrackRows = openFactoryIssues.filter((r) => r.issue.factoryState === "factory:fast-track");
  const fastTrackPrs = new Map<string, number[]>();
  if (fastTrackRows.length > 0) {
    const prRows = await db
      .select({ repoId: pullRequests.repoId, issueNumber: pullRequests.issueNumber, number: pullRequests.number })
      .from(pullRequests)
      .where(
        and(
          inArray(pullRequests.repoId, [...new Set(fastTrackRows.map((r) => r.repoId))]),
          inArray(pullRequests.issueNumber, [...new Set(fastTrackRows.map((r) => r.issue.number))]),
          eq(pullRequests.state, "open"),
          eq(pullRequests.draft, false),
        ),
      );
    for (const pr of prRows) {
      const key = `${pr.repoId}:${pr.issueNumber}`;
      if (!fastTrackPrs.has(key)) fastTrackPrs.set(key, []);
      fastTrackPrs.get(key)!.push(pr.number);
    }
  }

  const now = Date.now();
  for (const row of openFactoryIssues) {
    const { issue } = row;
    const state = issue.factoryState!;
    const ageDays = Math.floor((now - issue.ghUpdatedAt.getTime()) / DAY_MS);
    const epicId = issue.parentIssueId ?? issue.id;
    const expedited = expeditedEpics.has(epicId);

    if (state === "factory:blocked") {
      const meta = blockedMeta.get(issue.id);
      const since = meta?.since ?? issue.ghUpdatedAt;
      const blockedAgeDays = Math.floor((now - since.getTime()) / DAY_MS);
      const priorGate = meta?.priorState ? GATE_STATES[meta.priorState] : undefined;

      let whyYou: string | null = null;
      if (issue.assignees.includes(ctx.login)) whyYou = "blocked on a question — assigned to you";
      else if (issue.author === ctx.login) whyYou = "blocked on a question — you filed it";
      else if (priorGate && (amOnGate(row.estateId, row.repoId, priorGate.gate) || gateListEmpty(row.estateId, priorGate.gate)))
        whyYou = `blocked out of ${meta!.priorState!.replace("factory:", "")} — you own the ${priorGate.gate} list`;

      entries.push({
        kind: "blocked",
        rank: whyYou ? 1 : 4,
        whyYou: whyYou ?? "blocked issue in your organisation — any member may reply to resume it",
        epicId,
        issueId: issue.id,
        title: `#${issue.number} ${issue.title}`,
        repo: row.repoFullName,
        state,
        ageDays: blockedAgeDays,
        question: meta?.question ?? null,
        expedited,
        link: `/epics/${epicId}`,
      });
      continue;
    }

    if (state === "factory:fast-track") {
      const prNumbers = fastTrackPrs.get(`${row.repoId}:${issue.number}`) ?? [];
      if (prNumbers.length > 0) {
        entries.push({
          kind: "merge",
          rank: 2,
          whyYou: `fast-track PR ${prNumbers.map((n) => `#${n}`).join(", ")} awaits review and merge — the fast lane bypasses gates; any collaborator may act`,
          epicId,
          issueId: issue.id,
          title: `#${issue.number} ${issue.title}`,
          repo: row.repoFullName,
          state,
          ageDays,
          question: null,
          expedited,
          link: `/epics/${epicId}`,
        });
      }
      continue;
    }

    const gateInfo = GATE_STATES[state];
    if (!gateInfo) continue;
    // Which list actually owns this gate here: GS reads `staging`, falling back
    // to `release` on an estate whose approver file predates it (GATE_FALLBACK).
    const owning = resolveGateApprovers(gateInfo.gate, (g) => [...(gateApprovers.get(`${row.estateId}:${g}`) ?? [])]);
    const listEmpty = owning.approvers.length === 0;
    if (!amOnGate(row.estateId, row.repoId, owning.gate) && !listEmpty) continue;

    const whyBase = listEmpty ? "approver list is empty — any collaborator may act" : `you are on the ${owning.gate} approver list`;
    const base = {
      epicId: issue.kind === "epic" ? issue.id : epicId,
      issueId: issue.id,
      title: `#${issue.number} ${issue.title}`,
      repo: row.repoFullName,
      state,
      ageDays,
      question: null,
      expedited,
    };
    if (issue.kind === "epic" && (state === "factory:spec-ready" || state === "factory:design-ready")) {
      // Expedite approves G1 and G2 itself. Listing them anyway would ask a
      // person for an approval the factory is not waiting for — and pressing it
      // is harmless but teaches the queue's rows to be ignored.
      if (expedited) continue;
      entries.push({ kind: "gate", rank: 2, whyYou: `${gateInfo.label} awaits approval — ${whyBase}`, ...base, link: `/epics/${issue.id}?tab=gate` });
    } else if (issue.kind === "epic" && state === EPIC_READY_STATE) {
      // Gate GS, universal: every epic passes through it, expedited or not.
      // This is the item that replaces the old "all tasks are on the epic
      // branch — start the Release Manager" reading of the assembly stage.
      entries.push({
        kind: "gate",
        rank: 2,
        whyYou: `${gateInfo.label} — release to staging is waiting on you; ${whyBase}`,
        ...base,
        link: `/epics/${issue.id}?tab=gate`,
      });
    } else if (issue.kind === "test" && state === MANUAL_TEST_STATE) {
      // A runnable system test case (FACTORY.md §4b). It is not a gate — no
      // approval is being given — but it is a decision only a person can make,
      // and it is the one item expedite never suppresses: the factory can
      // assemble an epic by itself and it still cannot run its cases.
      entries.push({
        kind: "task-start",
        rank: 3,
        whyYou: `system test ${caseIdOf(issue.title) ?? "case"} is ready to run — ${whyBase}`,
        ...base,
        link: `/epics/${epicId}?tab=tasks`,
      });
    } else if (issue.kind === "task" && state === READY_STATE) {
      // `startStatusOf` answers `auto` for an expedited task, which takes no
      // approval — the per-task suppression rule falls straight out of it.
      if (!startStatusTakesApproval(startStatusOf(issue, startFacts.get(issue.id), expedited))) continue;
      entries.push({ kind: "task-start", rank: 3, whyYou: `task awaits an implementation start — ${whyBase}`, ...base, link: `/epics/${epicId}?tab=tasks` });
    } else if (issue.kind === "epic" && state === "factory:in-staging") {
      entries.push({ kind: "merge", rank: 2, whyYou: `release train is green on staging and awaits promotion — ${whyBase}`, ...base, link: `/epics/${issue.id}?tab=gate` });
    }
  }

  entries.sort((a, b) => a.rank - b.rank || b.ageDays - a.ageDays);
  return entries;
}

/** `test(9): ST-4 Renewal fires` -> `ST-4`, for the queue's one-line reason. */
function caseIdOf(title: string): string | null {
  return /^test\(\d+\):\s*(ST-\d+)/i.exec(title)?.[1] ?? null;
}

interface BlockedMeta {
  since: Date | null;
  priorState: string | null;
  question: string | null;
}

/**
 * Batched blocked metadata from projections that already exist: the history
 * event that applied the label (its absence means the issue arrived already
 * blocked via reconcile — label-event history is not recoverable from the
 * API, so callers fall back to ghUpdatedAt), the newest non-blocked state
 * before it, and the agent comment that carried the question.
 */
export async function loadBlockedMeta(deps: AppDeps, issueIds: string[]): Promise<Map<string, BlockedMeta>> {
  const { db } = deps.dbh;
  const meta = new Map<string, BlockedMeta>();
  if (issueIds.length === 0) return meta;
  for (const id of issueIds) meta.set(id, { since: null, priorState: null, question: null });

  const history = await db
    .select({ issueId: issueStateHistory.issueId, toState: issueStateHistory.toState, occurredAt: issueStateHistory.occurredAt })
    .from(issueStateHistory)
    .where(and(inArray(issueStateHistory.issueId, issueIds), isNotNull(issueStateHistory.toState)))
    .orderBy(desc(issueStateHistory.occurredAt));
  for (const h of history) {
    const m = meta.get(h.issueId)!;
    if (h.toState === "factory:blocked") {
      if (!m.since) m.since = h.occurredAt;
    } else if (!m.priorState) {
      // Rows arrive newest-first, so the first non-blocked state seen is the
      // stage the issue halted in. (Only sound before `since` is known for
      // re-blocked issues, but a newer non-blocked event would also have
      // cleared the label — the projection keeps these consistent.)
      m.priorState = h.toState;
    }
  }

  const agentComments = await db
    .select({ issueId: comments.issueId, body: comments.body, ghCreatedAt: comments.ghCreatedAt })
    .from(comments)
    .where(and(inArray(comments.issueId, issueIds), eq(comments.isAgent, true)))
    .orderBy(desc(comments.ghCreatedAt));
  for (const c of agentComments) {
    const m = meta.get(c.issueId)!;
    if (m.question) continue; // newest wins; rows arrive newest-first
    // Only a comment from around or after the halt carries the question; a 5
    // minute grace covers the comment landing just before the label did.
    if (m.since && c.ghCreatedAt.getTime() < m.since.getTime() - 5 * 60_000) continue;
    m.question = extractQuestion(c.body);
  }
  return meta;
}

/** First meaningful line of an agent comment: markers stripped, headings skipped (they label the question, they aren't it), bounded. */
export function extractQuestion(body: string): string | null {
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, "");
  for (const raw of cleaned.split("\n")) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/^>\s*/, "").trim();
    if (!line) continue;
    return line.length > 140 ? `${line.slice(0, 139)}…` : line;
  }
  return null;
}
