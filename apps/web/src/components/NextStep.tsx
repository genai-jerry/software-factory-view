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

/**
 * Starts pressed in this tab, kept until the task's step changes. Between a
 * successful press and the orchestrator labelling the task in progress, the
 * board still shows the step as waiting; without this the button comes back
 * enabled and invites a second press. Module-level so a board refetch or a
 * remount keeps it; a press older than ten minutes is forgotten, so a start
 * that never fired can be pressed again.
 */
const pressed = new Map<string, number>();
const PRESS_HOLD_MS = 10 * 60_000;

function wasPressed(key: string): boolean {
  const at = pressed.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > PRESS_HOLD_MS) {
    pressed.delete(key);
    return false;
  }
  return true;
}

/** For tests: forget every press. */
export function forgetStartPresses(): void {
  pressed.clear();
}

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
  const pressKey = `${issueId}:${step.startRole ?? ""}`;
  const start = useMutation({
    mutationFn: () => api.post<{ ok: boolean; role: string; detail: string }>(`/api/issues/${issueId}/start-role`, { role: step.startRole }),
    onSuccess: () => {
      pressed.set(pressKey, Date.now());
      void qc.invalidateQueries({ queryKey: ["epic"] });
      void qc.invalidateQueries({ queryKey: ["tree"] });
      void qc.invalidateQueries({ queryKey: ["attention"] });
      onStarted?.();
    },
  });
  const markReviewed = useMutation({
    mutationFn: () => api.post<{ ok: boolean; commentUrl: string }>(`/api/issues/${issueId}/mark-reviewed`),
    onSuccess: () => {
      pressed.set(pressKey, Date.now());
      void qc.invalidateQueries({ queryKey: ["epic"] });
      void qc.invalidateQueries({ queryKey: ["tree"] });
      void qc.invalidateQueries({ queryKey: ["attention"] });
      onStarted?.();
    },
  });
  if (!step.startRole) return null;
  const startLabel = step.startLabel ?? `Start the ${step.startRole}`;
  // In progress from the press until the step moves on: while the request is
  // out, and after it succeeded (here or in an earlier mount of this button).
  const busy = start.isPending || markReviewed.isPending;
  const done = start.isSuccess || markReviewed.isSuccess || wasPressed(pressKey);
  const button = (
    <button
      type="button"
      className="primary"
      disabled={busy || done}
      onClick={() => start.mutate()}
      title={done ? "Started. The board moves on once the run picks it up." : step.how}
    >
      {start.isPending ? "Starting…" : done ? "Started" : startLabel}
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
        <button type="button" disabled={busy || done} onClick={() => markReviewed.mutate()} title={MARK_REVIEWED_TITLE}>
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
