import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.js";
import { RepoChip } from "../components/RepoChip.js";
import { useFocus } from "../lib/filter.js";
import type { SimRun, SimRunsView } from "../types.js";

/**
 * Simulated runs: whether a deploy to staging starts a scenario run, a way to
 * start one by hand, and what the latest run said. The switch is the run
 * repo's SIM_SCENARIOS variable, so it is one control per run repo, covering
 * every service that deploys to that sim.
 */

type Mode = "automatic" | "manual";

/** The latest run's status in a few words: "Running", "Passed", "2 of 37 failed". */
export function simLatestWords(latest: SimRun["latest"]): string | null {
  if (!latest) return null;
  const d = latest.description ?? "";
  switch (latest.state) {
    case "pending":
      return /^waits/i.test(d) ? "Waiting for the next run" : "Running";
    case "success":
      return "Passed";
    case "failure": {
      const m = /^(\d+) of (\d+) scenarios? failed/i.exec(d);
      return m ? `${m[1]} of ${m[2]} failed` : "Failed";
    }
    case "error":
      return "Could not start";
    default:
      return latest.state;
  }
}

const HINT: Record<Mode, string> = {
  automatic: "Every deploy to staging starts a run (merges close together share one).",
  manual: "Deploys wait. Press Run now to test everything waiting.",
};

/** The sims, one group per run repo, in the order their first repo came. */
function byRunRepo(sims: SimRun[]): Array<{ runRepo: string; sims: SimRun[] }> {
  const groups = new Map<string, SimRun[]>();
  for (const s of sims) groups.set(s.runRepo, [...(groups.get(s.runRepo) ?? []), s]);
  return [...groups].map(([runRepo, list]) => ({ runRepo, sims: list }));
}

/**
 * `standalone` when the board has no staging column to sit in: it then
 * brings its own card.
 */
export function SimRunsPanel({ standalone }: { standalone?: boolean }) {
  const focus = useFocus();
  const q = useQuery({
    queryKey: ["sim-runs", focus.key],
    queryFn: () => api.get<SimRunsView>(`/api/sim-runs${focus.qs}`),
    refetchInterval: 30_000,
  });
  const sims = Array.isArray(q.data?.sims) ? q.data.sims : [];
  if (sims.length === 0) return null;
  const controls = byRunRepo(sims).map((g) => <SimRunControl key={g.runRepo} runRepo={g.runRepo} sims={g.sims} />);
  return standalone ? (
    <section className="card env-sim-card" aria-label="Simulated runs">
      {controls}
    </section>
  ) : (
    <>{controls}</>
  );
}

function SimRunControl({ runRepo, sims }: { runRepo: string; sims: SimRun[] }) {
  const qc = useQueryClient();
  const mode = sims[0]!.mode;
  const reason = sims[0]!.reason;
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const setMode = useMutation({
    mutationFn: (next: Mode) => api.post<{ mode: Mode }>("/api/sim-runs/mode", { runRepo, mode: next }),
    onMutate: () => {
      setError(null);
      setStarted(false);
    },
    onError: (e: Error) => setError(e.message),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sim-runs"] }),
  });
  const runNow = useMutation({
    mutationFn: () => api.post("/api/sim-runs/run", { runRepo }),
    onMutate: () => {
      setError(null);
      setStarted(false);
    },
    onError: (e: Error) => setError(e.message),
    onSuccess: () => {
      setStarted(true);
      void qc.invalidateQueries({ queryKey: ["sim-runs"] });
    },
  });
  const saving = setMode.isPending || runNow.isPending;
  // While a switch is saving, show where it is going.
  const shown: Mode | null = setMode.isPending ? (setMode.variables ?? mode) : mode;
  const name = `sim-mode-${runRepo}`;
  const services = sims.map((s) => s.repo.split("/").pop()).join(", ");

  return (
    <section className="sim-runs" aria-label={`Simulated runs in ${runRepo}`}>
      <span className="env-kind">
        SIMULATED RUNS
        <RepoChip fullName={runRepo} title={`The runs happen in ${runRepo}`} />
      </span>
      <div className="sim-mode" role="radiogroup" aria-label="When simulated runs start">
        {(["automatic", "manual"] as const).map((m) => (
          <label key={m} className={shown === m ? "on" : ""}>
            <input
              type="radio"
              name={name}
              checked={shown === m}
              disabled={saving}
              onChange={() => setMode.mutate(m)}
            />{" "}
            {m === "automatic" ? "Automatic" : "By hand"}
          </label>
        ))}
      </div>
      {shown && <span className="env-sub">{HINT[shown]}</span>}
      {mode === null && reason && <span className="sim-reason">{reason}</span>}
      <span className="env-sub">
        Applies to the whole sim in {runRepo}: every repo that deploys to it ({services}).
      </span>
      <ul className="sim-latest" aria-label="Latest simulated runs">
        {sims.map((s) => {
          const words = simLatestWords(s.latest);
          return (
            <li key={s.repo} className={`sim-state-${s.latest?.state ?? "none"}`} title={s.latest?.description ?? undefined}>
              <span className="sim-latest-repo">{s.repo.split("/").pop()} staging:</span>{" "}
              {!words ? (
                <span className="muted">no run yet</span>
              ) : s.latest?.url ? (
                <a href={s.latest.url} target="_blank" rel="noreferrer">
                  {words}
                </a>
              ) : (
                words
              )}
            </li>
          );
        })}
      </ul>
      <div className="sim-actions">
        <button type="button" disabled={saving} onClick={() => runNow.mutate()}>
          {runNow.isPending ? "Starting…" : "Run now"}
        </button>
        {setMode.isPending && <span className="env-sub">Saving…</span>}
        {started && <span className="env-sub">Started. The result shows here when the run reports it.</span>}
      </div>
      {error && (
        <p className="banner error sim-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
