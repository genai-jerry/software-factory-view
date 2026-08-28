import { useState } from "react";
import { Link } from "react-router-dom";
import {
  OrchestratorRunModal,
  runPhase,
  useLiveOrchestratorRun,
  type OrchestratorRunLog,
} from "./OrchestratorRunView.js";

function outcomeLabel(run: OrchestratorRunLog): string {
  if (run.outcome === "running" || (!run.outcome && !run.finished_at)) return "in progress";
  if (run.outcome === "no_op") return "finished (no GitHub trace)";
  return run.outcome ?? "—";
}

/** Live factory run status for an epic workspace when an agent is working the issue. */
export function EpicFactoryRunStatus({
  repo,
  issueNumber,
  inProgress,
  githubActions,
}: {
  repo: string;
  issueNumber: number;
  inProgress: boolean;
  githubActions: boolean;
}) {
  const [runOpen, setRunOpen] = useState(false);
  const factoryEngine = !githubActions;
  const enabled = factoryEngine && inProgress;
  const live = useLiveOrchestratorRun({ runId: null, repo, issueNumber, enabled });
  const run = live.data;
  const running = inProgress && (!run || !run.finished_at);
  const runId = run?.id ?? null;

  if (!inProgress && !run) return null;

  const runModal = runOpen && factoryEngine ? (
    <OrchestratorRunModal runId={runId} repo={repo} issueNumber={issueNumber} onClose={() => setRunOpen(false)} />
  ) : null;

  if (githubActions) {
    return (
      <>
        <div className="banner info">
          <strong>Factory run {running ? "in progress" : "recently active"}.</strong> Watch progress in GitHub Actions on{" "}
          <a href={`https://github.com/${repo}/actions`} target="_blank" rel="noreferrer">
            {repo}
          </a>
          .
        </div>
      </>
    );
  }

  const phase = runPhase(run);
  const model = run?.model;
  const role = run?.role ?? "factory";

  return (
    <>
      <div className="banner info">
        <strong>
          {role} run {running ? "in progress" : outcomeLabel(run ?? {})}
        </strong>
        {model ? (
          <>
            {" "}
            using <code>{model}</code>
          </>
        ) : null}
        {phase ? <> — {phase}</> : null}
        {runId ? (
          <>
            {" "}
            ·{" "}
            <button type="button" className="link" onClick={() => setRunOpen(true)}>
              View run log
            </button>{" "}
            · <Link to={`/runs/${encodeURIComponent(runId)}`}>Open run page</Link>
          </>
        ) : live.isLoading ? (
          <> · loading run status…</>
        ) : live.isError ? (
          <> · waiting for the orchestrator run log</>
        ) : null}
      </div>
      {runModal}
    </>
  );
}
