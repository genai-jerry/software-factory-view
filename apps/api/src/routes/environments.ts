import { issues, repos } from "@console/db";
import { and, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps } from "../context.js";
import {
  fetchOrchestratorEnvironments,
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
  notes: Array<{ at: string | null; role: string; title: string | null; outcome: string; summary: string; runId: string | null }>;
  lastUsedAt: string | null;
}

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
          .select({ id: repos.id, fullName: repos.fullName })
          .from(repos)
          .where(and(inArray(repos.fullName, names), inArray(repos.orgId, ctx.orgIds)))
      : [];
    const repoId = new Map(repoRows.map((r) => [r.fullName, r.id]));
    const repoRowIds = repoRows.map((r) => r.id);
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
        title: titleOf(repo, t.issue),
        state: t.state,
        since: orchestratorClock(t.since),
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
        })),
        lastUsedAt: orchestratorClock(e.last_used_at),
      };
    };

    const envs = got.environments.filter((e) => inFocus(e.repo, e.epic));
    const staging = envs.filter((e) => e.kind === "staging").map(card);

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
      role: agentRoleLabel(s.role ?? undefined) ?? (s.role || "Factory"),
      title: s.repo ? titleOf(s.repo, s.issue) : null,
      staging: Boolean(s.environment?.endsWith("@staging")),
      since: orchestratorClock(s.since),
    });
    const mineSession = (s: OrchestratorSession) => Boolean(s.repo && repoId.get(s.repo));
    const sessions = got.sessions && {
      total: got.sessions.total,
      // Every session counts toward the total; only this org's are named.
      inUse: got.sessions.in_use.map((s) => (mineSession(s) ? session(s) : { runId: null, role: "Another team's run", title: null, staging: false, since: null })),
      waiting: got.sessions.waiting.filter(mineSession).map(session),
    };

    return { available: true, sessions, staging, lanes: laneList, other };
  });
}
