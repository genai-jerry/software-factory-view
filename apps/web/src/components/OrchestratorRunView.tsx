import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api, ApiError } from "../api.js";
import { Banner } from "./Banner.js";

export type OrchestratorRunLog = {
  id?: string;
  repo?: string;
  issue?: number;
  role?: string;
  trigger?: string;
  model?: string | null;
  model_fallbacks?: string[] | unknown;
  started_at?: string;
  finished_at?: string | null;
  outcome?: string | null;
  error?: string | null;
  status?: string;
  guards?: { phase?: string; fallbacks?: string[]; model?: string } | unknown;
};

export function runPhase(run?: OrchestratorRunLog | null): string | undefined {
  const g = run?.guards;
  if (g && typeof g === "object" && "phase" in g && typeof g.phase === "string" && g.phase) return g.phase;
  return undefined;
}

function runFallbacks(run?: OrchestratorRunLog | null): string[] {
  const raw = run?.model_fallbacks;
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  const g = run?.guards;
  if (g && typeof g === "object" && "fallbacks" in g && Array.isArray(g.fallbacks)) {
    return g.fallbacks.filter((x): x is string => typeof x === "string");
  }
  return [];
}

export function useLiveOrchestratorRun(opts: {
  runId: string | null;
  repo: string;
  issueNumber?: number;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: ["orchestrator-run", opts.runId, opts.repo, opts.issueNumber],
    enabled: opts.enabled && Boolean(opts.runId || opts.issueNumber),
    refetchInterval: (q) => {
      const d = q.state.data as OrchestratorRunLog | undefined;
      if (!d) return 2000;
      return d.finished_at ? false : 2000;
    },
    queryFn: async (): Promise<OrchestratorRunLog> => {
      if (opts.runId) return api.get<OrchestratorRunLog>(`/api/orchestrator/runs/${encodeURIComponent(opts.runId)}`);
      if (!opts.issueNumber) throw new Error("no orchestrator run id yet");
      const listed = await api.get<{ runs: OrchestratorRunLog[] }>(
        `/api/orchestrator/runs?repo=${encodeURIComponent(opts.repo)}&issue=${opts.issueNumber}`,
      );
      const latest = listed.runs[0];
      if (!latest) throw new Error("the orchestrator has not written a run log yet");
      return latest;
    },
  });
}

function useOrchestratorTranscript(runId: string | null, done: boolean) {
  return useQuery({
    queryKey: ["orchestrator-transcript", runId],
    enabled: Boolean(runId),
    refetchInterval: done ? false : 3000,
    retry: false,
    queryFn: async () => {
      try {
        return await api.get<{ transcript: string }>(
          `/api/orchestrator/runs/${encodeURIComponent(runId!)}/transcript`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return { transcript: "" };
        throw err;
      }
    },
  });
}

/** Fields + live transcript for one orchestrator run. */
export function OrchestratorRunDetail({
  runId,
  repo,
  issueNumber,
}: {
  runId: string | null;
  repo: string;
  issueNumber?: number;
}) {
  const run = useLiveOrchestratorRun({ runId, repo, issueNumber, enabled: true });
  const resolvedId = run.data?.id ?? runId;
  const done = Boolean(run.data?.finished_at);
  const transcript = useOrchestratorTranscript(resolvedId, done);

  return (
    <>
      {run.isLoading && <p className="muted">Loading the run log…</p>}
      {run.isError && (
        <div className="banner error" style={{ marginTop: "0.75rem" }}>
          {(run.error as Error).message}
        </div>
      )}
      {run.data && <OrchestratorRunBody run={run.data} />}
      {!done && run.data && <p className="muted">This log refreshes while the run is in progress.</p>}
      {transcript.data?.transcript ? (
        <>
          <h4 style={{ margin: "1rem 0 0.4rem" }}>Transcript</h4>
          <pre className="run-log">{transcript.data.transcript}</pre>
        </>
      ) : (
        !done && run.data && <p className="muted">Claude's transcript appears here when the run writes it.</p>
      )}
    </>
  );
}

export function OrchestratorRunModal({
  runId,
  repo,
  issueNumber,
  onClose,
}: {
  runId: string | null;
  repo: string;
  issueNumber?: number;
  onClose: () => void;
}) {
  return (
    <div className="run-overlay" onClick={onClose} role="presentation">
      <div className="run-modal" role="dialog" aria-labelledby="run-modal-title" onClick={(e) => e.stopPropagation()}>
        <div className="spread">
          <h3 id="run-modal-title" style={{ margin: 0 }}>
            Orchestrator run
          </h3>
          <button type="button" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <OrchestratorRunDetail runId={runId} repo={repo} issueNumber={issueNumber} />
      </div>
    </div>
  );
}

export function OrchestratorRunBody({ run }: { run: OrchestratorRunLog }) {
  const phase = runPhase(run);
  const fallbacks = runFallbacks(run);
  const outcome =
    run.outcome === "running" || (!run.outcome && !run.finished_at)
      ? "in progress"
      : (run.outcome ?? "—");
  const repoLabel = run.issue != null ? `${run.repo ?? ""}#${run.issue}` : (run.repo ?? "—");
  const rows: Array<[string, ReactNode]> = [
    ["Outcome", outcome],
    ["Role", run.role ?? "—"],
    ["Repo", githubIssueLink(run.repo, run.issue) ?? repoLabel],
    ["Model", run.model ?? (phase ? "choosing…" : "none")],
    ["Started", run.started_at ?? "—"],
    ["Finished", run.finished_at ?? "—"],
  ];
  if (run.trigger) rows.splice(2, 0, ["Trigger", run.trigger]);
  if (phase && !run.finished_at) rows.splice(1, 0, ["Now", phase]);
  return (
    <>
      {run.error && (
        <div style={{ marginTop: "0.75rem" }}>
          <OrchestratorErrorBanner error={run.error} />
        </div>
      )}
      {fallbacks.length > 0 && (
        <div className="banner stale" style={{ marginTop: "0.75rem" }}>
          {fallbacks.join(", ")} was not reachable with this credential — using {run.model ?? "the next model in the chain"}.
        </div>
      )}
      <dl className="run-fields">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export function explainOrchestratorError(error: string): string {
  if (/401 Unauthorized/i.test(error) && /api\.github\.com/i.test(error)) {
    return "GitHub rejected the orchestrator's token (401). Re-run the Profiler from Onboarding so a fresh installation token is issued — a token already near expiry dies mid-run when the role next talks to GitHub.";
  }
  return error;
}

function OrchestratorErrorBanner({ error }: { error: string }) {
  const explained = explainOrchestratorError(error);
  return (
    <Banner tone="error" technical={explained !== error ? error : undefined}>
      {explained}
    </Banner>
  );
}

function githubIssueLink(repo?: string, issue?: number): ReactNode {
  if (!repo || issue == null) return null;
  return (
    <a href={`https://github.com/${repo}/issues/${issue}`} target="_blank" rel="noreferrer">
      {repo}#{issue}
    </a>
  );
}
