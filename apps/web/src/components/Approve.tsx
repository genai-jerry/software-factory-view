import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api.js";

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
