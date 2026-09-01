import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api.js";
import type { TaskStartStatus } from "../types.js";

/**
 * One approval affordance, one word, one look — wherever the factory is
 * waiting on a person.
 *
 * A task at `factory:ready` shows up in three places at once (the Tree, the
 * Tasks list and its Threads card). When only the Tree carried the button,
 * whoever happened to be looking at Tasks or Threads saw the task sitting
 * there with nothing to press and no hint that the wait was on them. So the
 * button lives here and every tab renders this one component: same label
 * ("Approve"), same green, same rule about who may press it, same call.
 */

/** The label. Nothing in the UI says "Approve — start implementer" any more. */
export const APPROVE_LABEL = "Approve";

/** What the approval does, said the same way in every tooltip. */
export const APPROVE_TITLE = 'Posts the literal comment "Approved" as you — the factory starts the implementer';

export interface StartGate {
  approvers: string[];
  amApprover: boolean;
}

export function startGateTitle(startGate: StartGate): string {
  return startGate.amApprover
    ? APPROVE_TITLE
    : `Starting implementers is assigned to: ${startGate.approvers.join(", ")}`;
}

/**
 * The task start gate button. Self-contained: it owns the POST, the pending
 * label, the "Approved ✓" receipt and its own error text, so a tab adopts it
 * without re-inventing any of that (and cannot report a failure differently
 * from the tab next door).
 *
 * `epicId` is what the caller's list is keyed by — approving refreshes the
 * epic workspace, the tree and the threads together, because the same task
 * is on screen in all three.
 */
export function TaskApproveButton({
  epicId,
  taskId,
  startGate,
}: {
  epicId: string;
  taskId: string;
  startGate: StartGate;
}) {
  const qc = useQueryClient();
  const approve = useMutation({
    mutationFn: () => api.post<{ ok: boolean; commentUrl: string }>(`/api/issues/${taskId}/approve`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["epic", epicId] });
      void qc.invalidateQueries({ queryKey: ["tree", epicId] });
      void qc.invalidateQueries({ queryKey: ["thread"] });
    },
  });

  return (
    <span className="approve-action">
      <button
        type="button"
        className="approve"
        disabled={!startGate.amApprover || approve.isPending}
        title={startGateTitle(startGate)}
        onClick={() => approve.mutate()}
      >
        {approve.isPending ? "Approving…" : APPROVE_LABEL}
      </button>
      {approve.isSuccess && (
        <a href={approve.data.commentUrl} target="_blank" rel="noreferrer" className="muted">
          Approved ✓
        </a>
      )}
      {approve.isError && <span className="approve-error">{(approve.error as ApiError).message}</span>}
    </span>
  );
}

/**
 * What the start gate says when it is not asking for a press.
 *
 * `factory:ready` stays on the issue while the approval is routed and while
 * the implementer runs, so the label on its own cannot answer "did my approve
 * land?". The API separates those moments; this is the wording for each, and
 * every tab uses it — a badge that read "Ready to build" over a live run is
 * how the same task got approved twice.
 */
export const START_STATUS_LABEL: Record<TaskStartStatus, string> = {
  none: "",
  awaiting: "Ready to build",
  approved: "Approved — starting",
  running: "Implementer running",
  stalled: "Approved — not started",
  // Expedite: the epic's marker removed this gate, so there is no approval to
  // report — only which role the factory is about to run.
  auto: "auto — Implementer next",
};

/** The two moments that still want a press — the API decides which, this reads it. */
export function startStatusTakesApproval(status: TaskStartStatus): boolean {
  return status === "awaiting" || status === "stalled";
}

function startStatusNote(status: TaskStartStatus, number: number): string {
  if (status === "running") return `An implementer is working on #${number} now — nothing to approve.`;
  if (status === "approved") return `Approved. The factory is starting the implementer on #${number}.`;
  if (status === "stalled") return `Approved, but no implementer started — approve again to retry #${number}.`;
  if (status === "auto") return `Expedite is on: the factory starts the implementer on #${number} itself.`;
  return `Starts the implementer on #${number}.`;
}

/**
 * The whole start gate for one task: the button when an approval is the move,
 * and what is happening instead when it is not. Tabs render this rather than
 * the button directly, so none of them can offer an approval the factory has
 * already been given.
 */
export function TaskStartGate({
  epicId,
  taskId,
  number,
  startGate,
  status,
}: {
  epicId: string;
  taskId: string;
  number: number;
  startGate: StartGate;
  status: TaskStartStatus;
}) {
  if (status === "none") return null;
  const note = startStatusNote(status, number);
  if (status === "approved" || status === "running") {
    return (
      <span className="start-status muted" title={note}>
        {START_STATUS_LABEL[status]} — {note}
      </span>
    );
  }
  // Expedited: the cue, with the approval kept reachable behind a disclosure —
  // any human may still take a stage over, and an automatic start that did not
  // fire has to be startable by hand or the task strands.
  if (status === "auto") {
    return (
      <span className="start-status muted">
        <span className="badge expedite" title={note}>
          {START_STATUS_LABEL[status]}
        </span>
        <details className="manual-start">
          <summary>Start it by hand</summary>
          <TaskApproveButton epicId={epicId} taskId={taskId} startGate={startGate} />
          <span className="muted">Only if the automatic start did not fire — this posts `Approved` on #{number} as you.</span>
        </details>
      </span>
    );
  }
  return (
    <>
      <TaskApproveButton epicId={epicId} taskId={taskId} startGate={startGate} />
      <span className="muted">{note}</span>
    </>
  );
}
