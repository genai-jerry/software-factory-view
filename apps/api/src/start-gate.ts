import {
  GATE_FOR_APPROVERS,
  nextStep,
  READY_STATE,
  taskStartStatus,
  type NextStep,
  type NextStepContext,
  type TaskStartStatus,
} from "@console/core";
import { comments, gateAssignments, issueStateHistory } from "@console/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppDeps } from "./context.js";

/**
 * The two projected facts that tell an untouched start gate from an approved
 * one, batched for a whole epic's tasks: the newest `Approved` comment on each
 * task, and when each task last entered `factory:ready`.
 *
 * Both are already projected — the comment by `projectComment` (which flags
 * approvals) and the transition by `projectLabelEvent`. Nothing new is stored;
 * the Console was simply not reading them when it decided to draw the button.
 */
export interface TaskStartFacts {
  approvedAt: Date | null;
  readySince: Date | null;
}

export async function loadTaskStartFacts(deps: AppDeps, issueIds: string[]): Promise<Map<string, TaskStartFacts>> {
  const { db } = deps.dbh;
  const facts = new Map<string, TaskStartFacts>();
  if (issueIds.length === 0) return facts;

  const approvals = await db
    .select({ issueId: comments.issueId, at: comments.ghCreatedAt })
    .from(comments)
    .where(and(inArray(comments.issueId, issueIds), eq(comments.isApproval, true)))
    .orderBy(desc(comments.ghCreatedAt));
  const readyEvents = await db
    .select({ issueId: issueStateHistory.issueId, at: issueStateHistory.occurredAt })
    .from(issueStateHistory)
    .where(and(inArray(issueStateHistory.issueId, issueIds), eq(issueStateHistory.toState, READY_STATE)))
    .orderBy(desc(issueStateHistory.occurredAt));

  for (const id of issueIds) facts.set(id, { approvedAt: null, readySince: null });
  // Newest first, so the first row per issue wins.
  for (const row of approvals) {
    const f = facts.get(row.issueId)!;
    if (!f.approvedAt) f.approvedAt = row.at;
  }
  for (const row of readyEvents) {
    const f = facts.get(row.issueId)!;
    if (!f.readySince) f.readySince = row.at;
  }
  return facts;
}

/** The status of one task, given its row and the batch above. */
export function startStatusOf(
  issue: { state: string; factoryState: string | null; labels: string[] },
  facts: TaskStartFacts | undefined,
): TaskStartStatus {
  return taskStartStatus({
    open: issue.state === "open",
    state: issue.factoryState,
    labels: issue.labels,
    approvedAt: facts?.approvedAt ?? null,
    readySince: facts?.readySince ?? null,
  });
}


/**
 * "What now?" for one issue, with the gate's approver list filled in.
 *
 * Every card that shows a factory state shows this beside it: a state is not
 * an instruction, and three of them (`in-review`, `in-test`,
 * `ready-to-ship`) start nothing on their own — the factory is waiting on a
 * person, and nothing on the card used to say so.
 *
 * Pass `ctx` wherever the caller has already read the start gate or the task
 * rollup: `factory:ready` and `factory:design-approved` each span a whole
 * stage, so without it the line answers for the moment the stage opened and
 * goes on asking for an approval the factory already has.
 */
export function nextStepFor(
  state: string | null,
  approversByGate: Map<string, string[]>,
  ctx: NextStepContext = {},
): NextStep {
  const gate = state ? GATE_FOR_APPROVERS[state] : undefined;
  return nextStep(state, gate ? (approversByGate.get(gate) ?? []) : [], ctx);
}

/** Every gate's approver list for one estate, in one query. */
export async function loadGateApprovers(deps: AppDeps, estateId: string): Promise<Map<string, string[]>> {
  const rows = await deps.dbh.db.select().from(gateAssignments).where(eq(gateAssignments.estateId, estateId));
  const byGate = new Map<string, string[]>();
  for (const row of rows) {
    const list = byGate.get(row.gate) ?? [];
    if (!list.includes(row.login)) list.push(row.login);
    byGate.set(row.gate, list);
  }
  return byGate;
}
