import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api.js";
import type { EpicWorkspace, FactoryHandoff } from "../types.js";

/**
 * "Why is nothing happening on this issue?"
 *
 * The old banner only ever said the orchestrator "has not started yet" and
 * offered a button — which is the same sentence whether the Console cannot
 * reach the orchestrator, the repo never claimed it, or a dead run left
 * `factory:in-progress` behind and is blocking every restart. The API now
 * names the state; this renders it, with the one action that state allows.
 *
 * The live-run case belongs to FactoryRunStatus (it owns the run log links),
 * so this stays quiet for `running`, `actions` and `idle`.
 */
const QUIET: ReadonlyArray<FactoryHandoff["status"]> = ["running", "actions", "idle"];
const ALARMING: ReadonlyArray<FactoryHandoff["status"]> = ["stalled", "orphaned", "not-configured", "failed"];

export function FactoryHandoffPanel({ data }: { data: EpicWorkspace }) {
  const handoff = data.orchestrator.handoff;
  const queryClient = useQueryClient();
  const epicId = data.epic.id;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["epic", epicId] });
    void queryClient.invalidateQueries({ queryKey: ["timeline", epicId] });
  };

  const start = useMutation({
    mutationFn: () =>
      api.post<{
        queued: boolean;
        deliveryGuid: string;
        action: string;
        label: string | null;
        role: { role: string; human: string; label: string } | null;
        fromProjection: boolean;
      }>(`/api/epics/${epicId}/factory-run`),
    onSuccess: invalidate,
  });

  const clear = useMutation({
    mutationFn: () => api.post<{ cleared: boolean; labels: string[] }>(`/api/epics/${epicId}/factory-run/clear-marker`),
    onSuccess: invalidate,
  });

  if (!handoff || QUIET.includes(handoff.status)) return null;

  return (
    <div className={`banner ${ALARMING.includes(handoff.status) ? "error" : "info"}`}>
      <p style={{ margin: "0 0 0.35rem", fontWeight: 600 }}>{handoff.headline}</p>
      <p style={{ margin: "0 0 0.5rem" }}>{handoff.detail}</p>
      {handoff.nextStep && <p style={{ margin: "0 0 0.5rem" }}>{handoff.nextStep}</p>}
      {handoff.runsError && handoff.status !== "unknown" && (
        <p className="muted" style={{ margin: "0 0 0.5rem" }}>
          The orchestrator could not be reached for run details: {handoff.runsError}
        </p>
      )}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {handoff.canClearMarker && (
          <button onClick={() => clear.mutate()} disabled={clear.isPending}>
            {clear.isPending ? "Clearing…" : "Clear the stuck marker"}
          </button>
        )}
        {handoff.canStart && (
          <button onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending
              ? "Starting…"
              : handoff.startsRole
                ? `Start the ${handoff.startsRole.human}`
                : "Start factory run"}
          </button>
        )}
      </div>

      {clear.isError && <p className="muted">{(clear.error as ApiError).message}</p>}
      {clear.isSuccess && <p className="muted">Marker cleared on GitHub — you can start the run now.</p>}
      {start.isError && <p className="muted">{(start.error as ApiError).message}</p>}
      {start.isSuccess && (
        <p className="muted">
          {start.data.queued
            ? `Queued with the orchestrator as ${start.data.role?.human ?? "a factory run"}`
            : "The orchestrator already had this delivery"}
          {start.data.label ? ` (from \`${start.data.label}\`)` : ""}.{" "}
          {start.data.fromProjection
            ? "GitHub could not be read, so the Console's last-known labels chose the role — check the issue if that is not what you expected. "
            : ""}
          Queued is not started: the orchestrator still applies its own claim check, and only comments on the issue
          once a role actually begins.
        </p>
      )}
    </div>
  );
}
