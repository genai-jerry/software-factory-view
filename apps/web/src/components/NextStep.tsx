import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api.js";
import type { NextStep } from "../types.js";

/**
 * "What now?", beside the thing it is about.
 *
 * The factory says this on the issue at the end of every run; the Console
 * says the same thing on the card, because a state is not an instruction. It
 * matters most for `factory:in-review`, `factory:in-test` and
 * `factory:ready-to-ship`: those route nothing on their own — the pipeline is
 * waiting for a person to start the next role — and the card used to show a
 * badge and a Comment button, which reads as "an agent has this".
 *
 * Where the move is starting a role, the button here starts it. Where the
 * move is an approval, `startRole` is null and the Approve button owns it.
 */
export function NextStepLine({ step }: { step: NextStep }) {
  return (
    <div className={`next-step${step.waitsOnPerson ? " waits" : ""}`}>
      <strong>Next: {step.who}.</strong> {step.how}
    </div>
  );
}

/** What the automatic cue calls each role — "auto — Reviewer next". */
const ROLE_NOUN: Record<NonNullable<NextStep["startRole"]>, string> = {
  architect: "Architect",
  reviewer: "Reviewer",
  qa: "QA",
  release: "Release Manager",
  ops: "Ops",
};

/** Posted as-is; the router treats it as the human equivalent of a clean Reviewer verdict. */
const MARK_REVIEWED_TITLE =
  'Posts the literal comment "Review Done" as you — skips the Reviewer and moves this task straight to In test. ' +
  "No changes-requested equivalent: review the draft PR on GitHub instead if it needs work.";

export function StartRoleButton({
  issueId,
  step,
  onStarted,
}: {
  issueId: string;
  step: NextStep;
  onStarted?: () => void;
}) {
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: () => api.post<{ ok: boolean; role: string; detail: string }>(`/api/issues/${issueId}/start-role`, { role: step.startRole }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["epic"] });
      void qc.invalidateQueries({ queryKey: ["tree"] });
      void qc.invalidateQueries({ queryKey: ["attention"] });
      onStarted?.();
    },
  });
  const markReviewed = useMutation({
    mutationFn: () => api.post<{ ok: boolean; commentUrl: string }>(`/api/issues/${issueId}/mark-reviewed`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["epic"] });
      void qc.invalidateQueries({ queryKey: ["tree"] });
      void qc.invalidateQueries({ queryKey: ["attention"] });
      onStarted?.();
    },
  });
  if (!step.startRole) return null;
  const startLabel = step.startLabel ?? `Start the ${step.startRole}`;
  const button = (
    <button type="button" className="primary" disabled={start.isPending} onClick={() => start.mutate()} title={step.how}>
      {start.isPending ? "Starting…" : startLabel}
    </button>
  );
  /**
   * Expedited: the factory takes this hop itself, so the button is demoted, not
   * removed. Presenting it as the move would be a lie (nothing is waiting on
   * the reader), and removing it would strand a stage whose automatic run
   * never fired — a human may take any stage over, at any time.
   */
  if (step.automatic) {
    return (
      <span className="approve-action">
        <span className="badge expedite" title={step.how}>
          auto — {ROLE_NOUN[step.startRole]} next
        </span>
        <details className="manual-start">
          <summary>Start it by hand</summary>
          {button}
          <span className="muted">Only if the automatic run did not fire.</span>
        </details>
        {start.isSuccess && <span className="muted">Started — {start.data.detail}</span>}
        {start.isError && <span className="approve-error">{(start.error as ApiError).message}</span>}
      </span>
    );
  }
  return (
    <span className="approve-action">
      {button}
      {step.startRole === "reviewer" && (
        <button type="button" disabled={markReviewed.isPending} onClick={() => markReviewed.mutate()} title={MARK_REVIEWED_TITLE}>
          {markReviewed.isPending ? "Marking…" : "Mark Reviewed"}
        </button>
      )}
      {start.isSuccess && <span className="muted">Started — {start.data.detail}</span>}
      {start.isError && <span className="approve-error">{(start.error as ApiError).message}</span>}
      {markReviewed.isSuccess && (
        <a href={markReviewed.data.commentUrl} target="_blank" rel="noreferrer" className="muted">
          Marked reviewed ✓
        </a>
      )}
      {markReviewed.isError && <span className="approve-error">{(markReviewed.error as ApiError).message}</span>}
    </span>
  );
}
