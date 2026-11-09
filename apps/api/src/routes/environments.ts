import { issues, pullRequests, repos } from "@console/db";
import { and, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps } from "../context.js";
import {
  fetchActiveRuns,
  fetchOrchestratorEnvironments,
  fetchPastRuns,
  orchestratorClock,
  type OrchestratorEnvironment,
  type OrchestratorSession,
  type OrchestratorTurn,
} from "../orchestrator-dispatch.js";
import { agentRoleLabel, resolveRepoFilter, type RepoFilterQuery } from "./read.js";

/**
 * The Environments page: where the Claude sessions run. The orchestrator has
 * one build environment for staging per repo, one per epic and one per task;
 * each runs one session at a time. This route names them with the Console's
 * titles and groups them the way work moves: tasks into their epic, epics
 * onto staging.
 */

/** A task whose work is on the epic branch (or past it). */
const MERGED_STATES = new Set(["factory:on-epic", "factory:in-staging", "factory:ready-to-ship", "factory:deployed"]);

interface IssueRow {
  id: string;
  repoId: string;
  number: number;
  title: string;
  kind: string;
  state: string;
  factoryState: string | null;
  parentIssueId: string | null;
}

export interface EnvTurn {
  runId: string | null;
  /** The model the run used ("claude-opus-5-5"), once the orchestrator has recorded it. */
  model: string | null;
  role: string;
  title: string | null;
  /** running · starting · waiting for a session · waiting (queued for the environment) */
  state: string;
  since: string | null;
}

export interface EnvCard {
  id: string;
  kind: OrchestratorEnvironment["kind"];
  repo: string;
  title: string;
  issueId: string | null;
  epicId: string | null;
  active: EnvTurn | null;
  queue: EnvTurn[];
  notes: EnvNote[];
  lastUsedAt: string | null;
  /** Staging only: the epics already merged onto it and not yet shipped, by lane ref. */
  onStaging?: Array<{ ref: string; title: string }>;
  /**
   * The pull requests this card's work moved through, newest first: a task's
   * own; those into an epic's branch and the epic's own (spec, design, its
   * release onto staging); what went onto staging since its last promotion.
   * Empty when the Console has none for it.
   */
  pulls: EnvPull[];
}

/** A pull request a run merged: which branch it went onto is what the note's reader needs. */
export interface EnvMerge {
  number: number;
  title: string;
  baseRef: string;
  url: string;
}

export interface EnvNote {
  at: string | null;
  role: string;
  title: string | null;
  outcome: string;
  summary: string;
  runId: string | null;
  model: string | null;
  /**
   * The pull requests of this repo merged while the run ran, oldest first: a
   * release run in the staging environment may have assembled an epic
   * (merged onto its branch) rather than put anything onto staging, and the
   * summary alone does not say which.
   */
  merged: EnvMerge[];
}

/** A pull request behind a card, as the Console's projection of GitHub holds it. */
export interface EnvPull {
  number: number;
  title: string;
  /** open · merged · closed (closed without merging) */
  state: "open" | "merged" | "closed";
  mergedAt: string | null;
  headRef: string;
  baseRef: string;
  url: string;
}

/** The pull requests of a repo, as `pullsOf` reads them. */
interface PullRow {
  repoId: string;
  number: number;
  title: string;
  kind: string;
  state: string;
  issueNumber: number | null;
  headRef: string;
  baseRef: string;
  mergedAt: Date | null;
  htmlUrl: string;
  ghUpdatedAt: Date;
}

const MOST_PULLS = 40;

const pullOut = (p: PullRow): EnvPull => ({
  number: p.number,
  title: p.title,
  state: p.mergedAt ? "merged" : p.state === "open" ? "open" : "closed",
  mergedAt: p.mergedAt ? p.mergedAt.toISOString() : null,
  headRef: p.headRef,
  baseRef: p.baseRef,
  url: p.htmlUrl,
});

const newestFirst = (a: PullRow, b: PullRow) =>
  (b.mergedAt ?? b.ghUpdatedAt).getTime() - (a.mergedAt ?? a.ghUpdatedAt).getTime() || b.number - a.number;

const cleanTitle = (t: string) => t.replace(/^(task|test|bug)\([^)]*\):?\s*/i, "");

export function registerEnvironmentRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get<{ Querystring: RepoFilterQuery }>("/api/environments", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const repoFilter = await resolveRepoFilter(deps, ctx, req.query);
    const empty = { available: true, sessions: null, staging: [], lanes: [], other: [] };
    if (repoFilter && repoFilter.length === 0) return empty;

    const got = await fetchOrchestratorEnvironments(deps.cfg);
    if (!got) return { ...empty, available: false };

    // Only this user's orgs' repos, by name.
    const epicRepoOf = (ref: string | null) => (ref ? ref.slice(0, ref.lastIndexOf("#")) : null);
    const names = [...new Set(got.environments.flatMap((e) => [e.repo, epicRepoOf(e.epic)]).filter((n): n is string => Boolean(n)))];
    const repoRows = names.length
      ? await db
          .select({ id: repos.id, fullName: repos.fullName, stagingBranch: repos.stagingBranch })
          .from(repos)
          .where(and(inArray(repos.fullName, names), inArray(repos.orgId, ctx.orgIds)))
      : [];
    const repoId = new Map(repoRows.map((r) => [r.fullName, r.id]));
    const repoRowIds = repoRows.map((r) => r.id);
    const stagingBranchOf = new Map(repoRows.map((r) => [r.id, r.stagingBranch ?? "staging"]));
    // Every pull request of these repos, open or done: what is on staging is
    // read from the merged ones below, and each card lists its own.
    const prRows: PullRow[] = repoRowIds.length
      ? await db
          .select({
            repoId: pullRequests.repoId, number: pullRequests.number, title: pullRequests.title, kind: pullRequests.kind,
            state: pullRequests.state, issueNumber: pullRequests.issueNumber, headRef: pullRequests.headRef,
            baseRef: pullRequests.baseRef, mergedAt: pullRequests.mergedAt, htmlUrl: pullRequests.htmlUrl,
            ghUpdatedAt: pullRequests.ghUpdatedAt,
          })
          .from(pullRequests)
          .where(inArray(pullRequests.repoId, repoRowIds))
      : [];
    const lastPromotion = (id: string | undefined) =>
      Math.max(0, ...prRows.filter((p) => p.repoId === id && p.kind === "promotion" && p.mergedAt).map((p) => p.mergedAt!.getTime()));
    const pullsOf = (e: OrchestratorEnvironment, row: IssueRow | undefined): EnvPull[] => {
      const id = repoId.get(e.repo);
      const mine = prRows.filter((p) => p.repoId === id);
      let chosen: PullRow[];
      if (e.kind === "staging") {
        const promoted = lastPromotion(id);
        const onto = stagingBranchOf.get(id ?? "") ?? "staging";
        // What is in the staging branch: every pull request onto it since the last
        // promotion carried the branch to main, and any still open onto it. A
        // promotion (staging → main) is about leaving staging, and is a decision on
        // the Decisions page rather than a line here.
        chosen = mine.filter(
          (p) => p.baseRef === onto && (p.state === "open" || (p.mergedAt !== null && p.mergedAt.getTime() > promoted)),
        );
      } else if (e.number === null) {
        chosen = [];
      } else if (e.kind === "epic" || row?.kind === "epic") {
        const branch = `factory/epic-${e.number}`;
        chosen = mine.filter((p) => p.baseRef === branch || p.issueNumber === e.number);
      } else {
        chosen = mine.filter((p) => p.issueNumber === e.number || p.headRef.startsWith(`factory/${e.number}-`));
      }
      return chosen.sort(newestFirst).slice(0, MOST_PULLS).map(pullOut);
    };
    // What each remembered run merged: the repo's pull requests whose merge
    // fell within the run, by the orchestrator's own record of when it ran.
    // A run it no longer lists (older than its newest hundred) gets none.
    const ran = new Map<string, { from: number; to: number }>();
    // The model each run used, by run id: finished runs from the past list,
    // live ones from the active list (the orchestrator records it as a run starts).
    const modelOf = new Map<string, string>();
    for (const r of await fetchPastRuns(deps.cfg)) {
      const from = Date.parse(r.startedAt);
      const to = Date.parse(r.finishedAt);
      if (!Number.isNaN(from) && !Number.isNaN(to)) ran.set(r.id, { from, to });
      if (r.model) modelOf.set(r.id, r.model);
    }
    for (const a of (await fetchActiveRuns(deps.cfg)).values()) if (a.model) modelOf.set(a.id, a.model);
    const MERGE_SLACK = 60_000; // the merge's clock and the orchestrator's need not agree to the second
    const mergedDuring = (repo: string, runId: string | null): EnvMerge[] => {
      const w = runId ? ran.get(runId) : undefined;
      if (!w) return [];
      const id = repoId.get(repo);
      return prRows
        .filter((p) => p.repoId === id && p.mergedAt !== null && p.mergedAt.getTime() >= w.from - MERGE_SLACK && p.mergedAt.getTime() <= w.to + MERGE_SLACK)
        .sort((a, b) => a.mergedAt!.getTime() - b.mergedAt!.getTime())
        .map((p) => ({ number: p.number, title: p.title, baseRef: p.baseRef, url: p.htmlUrl }));
    };
    const issueRows: IssueRow[] = repoRowIds.length
      ? ((await db
          .select({
            id: issues.id, repoId: issues.repoId, number: issues.number, title: issues.title, kind: issues.kind,
            state: issues.state, factoryState: issues.factoryState, parentIssueId: issues.parentIssueId,
          })
          .from(issues)
          .where(inArray(issues.repoId, repoRowIds))) as IssueRow[])
      : [];
    const byRef = new Map<string, IssueRow>();
    const fullNameOf = new Map(repoRows.map((r) => [r.id, r.fullName]));
    for (const i of issueRows) byRef.set(`${fullNameOf.get(i.repoId)}#${i.number}`, i);
    const byId = new Map(issueRows.map((i) => [i.id, i]));

    const inFocus = (repo: string, epicRef: string | null) => {
      const id = repoId.get(repo);
      if (!id) return false; // another tenant's repo, or one the Console does not know
      if (!repoFilter) return true;
      const epicRepo = repoId.get(epicRepoOf(epicRef) ?? "");
      return repoFilter.includes(id) || (epicRepo !== undefined && repoFilter.includes(epicRepo));
    };

    const titleOf = (repo: string, issue: number | null) => {
      if (issue === null) return null;
      const row = byRef.get(`${repo}#${issue}`);
      return row ? cleanTitle(row.title) : null;
    };
    const turn = (repo: string, t: OrchestratorTurn | null): EnvTurn | null =>
      t && {
        runId: t.run_id,
        role: agentRoleLabel(t.role ?? undefined) ?? (t.role || "Factory"),
        title: titleOf(t.repo || repo, t.issue),
        state: t.state,
        since: orchestratorClock(t.since),
        model: t.run_id ? (modelOf.get(t.run_id) ?? null) : null,
      };

    const card = (e: OrchestratorEnvironment): EnvCard => {
      const row = e.number !== null ? byRef.get(`${e.repo}#${e.number}`) : undefined;
      const epicRow = row && (row.kind === "epic" ? row : byId.get(row.parentIssueId ?? ""));
      return {
        id: e.id,
        kind: e.kind,
        repo: e.repo,
        title: e.kind === "staging" ? "Staging" : row ? cleanTitle(row.title) : "An issue the Console has not seen",
        issueId: row?.id ?? null,
        epicId: epicRow?.id ?? null,
        active: turn(e.repo, e.active),
        queue: e.queue.map((q) => turn(e.repo, q)!).filter(Boolean),
        notes: e.notes.map((n) => ({
          at: orchestratorClock(n.at),
          role: agentRoleLabel(n.role ?? undefined) ?? (n.role || "Factory"),
          title: titleOf(e.repo, n.issue),
          outcome: n.outcome ?? "",
          summary: n.summary,
          runId: n.run_id,
          model: n.run_id ? (modelOf.get(n.run_id) ?? null) : null,
          merged: mergedDuring(e.repo, n.run_id),
        })),
        lastUsedAt: orchestratorClock(e.last_used_at),
        pulls: pullsOf(e, row),
      };
    };

    const envs = got.environments.filter((e) => inFocus(e.repo, e.epic));
    // What is on a repo's staging comes from its merged pull requests, not
    // from labels (a label can lag: an epic promoted by hand keeps
    // factory:in-staging, and a blocked one already merged there carries no
    // staging label at all). A promotion carries the whole staging branch to
    // the default branch, so an epic is on staging when its
    // `release(<n>): integrate …` pull request merged after the repo's last
    // merged promotion.
    const onStagingOf = (repo: string) => {
      const id = repoId.get(repo);
      const mine = prRows.filter((p) => p.repoId === id && p.mergedAt !== null);
      const promoted = lastPromotion(id);
      const numbers = new Set<number>();
      for (const p of mine) {
        const m = /^release\(([\d,\s]+)\):\s*integrate/i.exec(p.title);
        if (m && p.kind !== "promotion" && p.mergedAt!.getTime() > promoted) {
          for (const n of m[1]!.split(",")) if (Number(n)) numbers.add(Number(n));
        }
      }
      // The number names the epic in its home repo: this repo's own, or a
      // sibling repo's epic that has a task here (a cross-repo train).
      const out: Array<{ ref: string; title: string }> = [];
      for (const n of numbers) {
        const candidates = issueRows.filter((i) => i.number === n && (i.kind === "epic" || i.kind === "plain"));
        const ep =
          candidates.find((i) => i.repoId === id) ??
          candidates.find((i) => issueRows.some((t) => t.parentIssueId === i.id && t.repoId === id));
        if (ep) out.push({ ref: `${fullNameOf.get(ep.repoId)}#${ep.number}`, title: cleanTitle(ep.title) });
      }
      return out;
    };
    const staging = envs.filter((e) => e.kind === "staging").map((e) => ({ ...card(e), onStaging: onStagingOf(e.repo) }));

    // Lanes: one per epic, its own environment and its tasks'.
    const lanes = new Map<string, { epic: EnvCard | null; ref: string; tasks: EnvCard[] }>();
    const lane = (ref: string) => {
      if (!lanes.has(ref)) lanes.set(ref, { epic: null, ref, tasks: [] });
      return lanes.get(ref)!;
    };
    const other: EnvCard[] = [];
    for (const e of envs) {
      if (e.kind === "staging") continue;
      const row = e.number !== null ? byRef.get(`${e.repo}#${e.number}`) : undefined;
      if (e.kind === "epic" || row?.kind === "epic") lane(`${e.repo}#${e.number}`).epic = card(e);
      else if (e.epic) lane(e.epic).tasks.push(card(e));
      else other.push(card(e));
    }

    const busy = (c: EnvCard | null) => Boolean(c && (c.active || c.queue.length));
    const lastUsed = (c: EnvCard | null) => c?.lastUsedAt ?? "";
    const laneList = [...lanes.values()].map(({ epic, ref, tasks }) => {
      const epicRow = byRef.get(ref);
      const children = epicRow ? issueRows.filter((i) => i.parentIssueId === epicRow.id && i.kind === "task") : [];
      const merged = children.filter((t) => t.state === "closed" || MERGED_STATES.has(t.factoryState ?? "")).length;
      tasks.sort((a, b) => Number(busy(b)) - Number(busy(a)) || lastUsed(b).localeCompare(lastUsed(a)));
      return {
        ref,
        epicId: epicRow?.id ?? null,
        title: epicRow ? cleanTitle(epicRow.title) : "An epic the Console has not seen",
        epic,
        tasks,
        tasksTotal: children.length,
        tasksMerged: merged,
      };
    });
    laneList.sort(
      (a, b) =>
        Number(busy(b.epic) || b.tasks.some(busy)) - Number(busy(a.epic) || a.tasks.some(busy)) ||
        [b.epic, ...b.tasks].map(lastUsed).sort().pop()!.localeCompare([a.epic, ...a.tasks].map(lastUsed).sort().pop()!),
    );

    const session = (s: OrchestratorSession) => ({
      runId: s.run_id,
      model: s.run_id ? (modelOf.get(s.run_id) ?? null) : null,
      role: agentRoleLabel(s.role ?? undefined) ?? (s.role || "Factory"),
      title: s.repo ? titleOf(s.repo, s.issue) : null,
      staging: Boolean(s.environment?.endsWith("@staging")),
      since: orchestratorClock(s.since),
    });
    const mineSession = (s: OrchestratorSession) => Boolean(s.repo && repoId.get(s.repo));
    const sessions = got.sessions && {
      total: got.sessions.total,
      // Every session counts toward the total; only this org's are named.
      inUse: got.sessions.in_use.map((s) => (mineSession(s) ? session(s) : { runId: null, model: null, role: "Another team's run", title: null, staging: false, since: null })),
      waiting: got.sessions.waiting.filter(mineSession).map(session),
    };

    return { available: true, sessions, staging, lanes: laneList, other };
  });
}
