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
  if (!step.startRole) return null;
  return (
    <span className="approve-action">
      <button type="button" className="primary" disabled={start.isPending} onClick={() => start.mutate()} title={step.how}>
        {start.isPending ? "Starting…" : (step.startLabel ?? `Start the ${step.startRole}`)}
      </button>
      {start.isSuccess && <span className="muted">Started — {start.data.detail}</span>}
      {start.isError && <span className="approve-error">{(start.error as ApiError).message}</span>}
    </span>
  );
}
