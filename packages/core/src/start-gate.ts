import { IN_PROGRESS_LABEL } from "./factory.js";

/**
 * What a task at the start gate is actually waiting for.
 *
 * `factory:ready` is not one moment, it is three. The state label stays
 * `factory:ready` from the dispatcher releasing the task until the implementer
 * flips it to `factory:in-review` — which means it is still `factory:ready`
 * while the approval sits on the issue waiting to be routed, and still
 * `factory:ready` while the implementer is running. The Console used to read
 * that one label as "press Approve", so a task that had already been approved
 * kept offering the button: the reader could not tell an untouched task from
 * one with an agent working on it, and pressing again posts a second
 * `Approved` — which the router happily takes as a second start (FACTORY.md
 * §3: the marker is orthogonal to the state, so it does not guard the router).
 *
 * The two facts that separate the three moments are already projected: the
 * `factory:in-progress` run marker, and the approval comment itself.
 */

/** The state at which a task waits for its implementation start. */
export const READY_STATE = "factory:ready";

/**
 * How long an approval is allowed to sit before the Console offers the button
 * again. The dispatch is webhook-driven and normally takes seconds; an
 * approval still unrouted after this either lost its event or was refused, and
 * the only human move left is to approve again — so hiding the button forever
 * would strand the task.
 */
export const START_APPROVAL_GRACE_MS = 10 * 60_000;

export type TaskStartStatus =
  /** Not at the start gate at all (any other state, or closed). */
  | "none"
  /** At `factory:ready`, nothing approved yet — the one moment that wants a button. */
  | "awaiting"
  /** Approved; the factory has not started the run yet. */
  | "approved"
  /** A factory run is live on the issue right now. */
  | "running"
  /** Approved long enough ago that nothing is coming — approving again is the move. */
  | "stalled";

export interface TaskStartInput {
  /** Issue open on GitHub. */
  open: boolean;
  /** Derived factory state label. */
  state: string | null;
  /** All labels on the issue — the run marker lives here, not in the state. */
  labels: readonly string[];
  /** Newest `Approved` comment on the task, or null when there is none. */
  approvedAt: Date | null;
  /**
   * When the task last entered `factory:ready`. An approval older than this
   * belongs to a previous build round (the reviewer sent the task back, and
   * the router needs a fresh `Approved` to start the implementer again).
   * Null when the projection has no label history for the issue — a
   * reconciled issue has none, and there the newest approval is the best
   * evidence available.
   */
  readySince: Date | null;
  now?: Date;
}

export function taskStartStatus(input: TaskStartInput): TaskStartStatus {
  if (!input.open || input.state !== READY_STATE) return "none";
  if (input.labels.includes(IN_PROGRESS_LABEL)) return "running";
  if (!input.approvedAt) return "awaiting";
  if (input.readySince && input.approvedAt < input.readySince) return "awaiting";
  const age = (input.now ?? new Date()).getTime() - input.approvedAt.getTime();
  return age > START_APPROVAL_GRACE_MS ? "stalled" : "approved";
}

/** True only where pressing Approve is the move — everywhere else the button is noise. */
export function startStatusTakesApproval(status: TaskStartStatus): boolean {
  return status === "awaiting" || status === "stalled";
}
