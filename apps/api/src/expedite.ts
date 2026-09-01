import { EXPEDITE_LABEL, RELEASE_KIND_LABEL, deriveExpedited } from "@console/core";
import { auditLog, issues } from "@console/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppDeps } from "./context.js";

/**
 * Expedite, read from the projection (change `add-expedite-mode-console`).
 *
 * The marker lives on the EPIC and only there — the factory never copies it
 * onto the sub-issues, a task is expedited because its epic is. Every caller
 * that renders a task therefore has to resolve the epic first, which is what
 * this module exists to make cheap (one batched query per request) and
 * consistent (one definition of "expedited", one of "may this be toggled").
 *
 * Nothing here writes: applying and removing the label is a GitHub operation
 * under the acting user's own token (routes/write.ts), never the App's.
 */

/**
 * Whether each of these epics carries the marker, in one query. Callers pass
 * ids they have already authorised — rows loaded under `ctx.orgIds` — the same
 * discipline as `loadTaskStartFacts` and `loadBlockedMeta`.
 */
export async function loadExpeditedEpics(deps: AppDeps, epicIssueIds: string[]): Promise<Set<string>> {
  const expedited = new Set<string>();
  const ids = [...new Set(epicIssueIds)];
  if (ids.length === 0) return expedited;
  const rows = await deps.dbh.db
    .select({ id: issues.id, labels: issues.labels })
    .from(issues)
    .where(inArray(issues.id, ids));
  for (const row of rows) if (deriveExpedited(row.labels)) expedited.add(row.id);
  return expedited;
}

/** The Console's own record of who last flipped the toggle here, and which way. */
export interface ExpediteFlip {
  on: boolean;
  actor: string | null;
  at: Date;
}

/**
 * Whether the toggle is offered on this issue, and what to say when it is not.
 *
 * These mirror the factory's own refusals rather than inventing Console
 * policy: the fast lane has no gates to waive, a release tracker and a profile
 * issue are not requirements at all, and applied before the spec exists the
 * marker simply lies dormant until there is a gate for it to open (the factory
 * reads it from G1 onward). A refusal the factory would make silently is worse
 * than one the Console explains here.
 */
export interface ExpediteAvailability {
  /** The toggle may be pressed. */
  available: boolean;
  /** On, per the projection. */
  on: boolean;
  /** Applied here it would do nothing yet — the spec does not exist. */
  dormant: boolean;
  /** Why it is unavailable, or what dormancy means. Null when it is simply live. */
  reason: string | null;
}

/** States before a spec exists: the marker is accepted but nothing acts on it yet. */
const PRE_SPEC_STATES = new Set(["factory:backlog", "factory:intake"]);

export function expediteAvailability(issue: {
  kind: string;
  state: string;
  factoryState: string | null;
  labels: string[];
}): ExpediteAvailability {
  const on = deriveExpedited(issue.labels);
  const no = (reason: string): ExpediteAvailability => ({ available: false, on, dormant: false, reason });

  if (issue.labels.includes(RELEASE_KIND_LABEL)) {
    return no("This is a release tracker, not a requirement — expedite an epic under it instead.");
  }
  if (issue.labels.includes("factory:profile") || issue.factoryState === "factory:profile") {
    return no("This is the repo profile issue — it has no spec, design or tasks to expedite.");
  }
  if (issue.labels.includes("factory:fast-track") || issue.factoryState === "factory:fast-track") {
    return no("The fast lane already runs without gates — there is nothing here for expedite to waive.");
  }
  if (issue.kind !== "epic") {
    return no("Expedite is applied to the epic; its tasks inherit it. Open the epic to turn it on.");
  }
  if (issue.state !== "open") {
    return no("This epic is closed.");
  }
  if (!issue.factoryState || PRE_SPEC_STATES.has(issue.factoryState)) {
    return {
      available: true,
      on,
      dormant: true,
      reason: "Expedite lies dormant until the spec exists — the factory acts on it from gate G1 onward.",
    };
  }
  return { available: true, on, dormant: false, reason: null };
}

/**
 * The newest expedite flip the Console recorded on this epic.
 *
 * The label itself is the truth (it comes back through the projection like any
 * other), so this is not state — it answers "who asked for this, and when",
 * and it is how the workspace can say that a flip the Console posted is no
 * longer on the issue: the factory reverts an application from someone it does
 * not accept, leaving its own comment on the epic as the explanation.
 */
export async function loadLastExpediteFlip(
  deps: AppDeps,
  orgId: string,
  target: string,
): Promise<ExpediteFlip | null> {
  const rows = await deps.dbh.db
    .select({ action: auditLog.action, payload: auditLog.payload, at: auditLog.at })
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), eq(auditLog.target, target), inArray(auditLog.action, EXPEDITE_ACTIONS)))
    .orderBy(desc(auditLog.at))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    on: row.action === EXPEDITE_ON_ACTION,
    actor: typeof row.payload["actor"] === "string" ? row.payload["actor"] : null,
    at: row.at,
  };
}

export const EXPEDITE_ON_ACTION = "epic.expedite.on";
export const EXPEDITE_OFF_ACTION = "epic.expedite.off";
export const EXPEDITE_ACTIONS = [EXPEDITE_ON_ACTION, EXPEDITE_OFF_ACTION];

/** The label the toggle writes — re-exported so routes never spell it themselves. */
export { EXPEDITE_LABEL };
