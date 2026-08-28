import { useState } from "react";
import { Link } from "react-router-dom";
import type { EpicWorkspace } from "../types.js";
import {
  OrchestratorRunModal,
  runPhase,
  useLiveOrchestratorRun,
  type OrchestratorRunLog,
} from "./OrchestratorRunView.js";

function orchestratorRunId(run?: OrchestratorRunLog | null): string | null {
  const raw = run?.id;
  if (!raw || raw === "queued" || raw === "in-progress") return null;
  return raw;
}

export function FactoryRunStatus({ data }: { data: EpicWorkspace }) {
  const inProgressLabel = data.epic.labels.includes("factory:in-progress");
  const isSoftwareFactory = data.orchestrator.engine === "software-factory";
  const [runOpen, setRunOpen] = useState(false);

  const live = useLiveOrchestratorRun({
    runId: null,
    repo: data.repo.fullName,
    issueNumber: data.epic.number,
    enabled: isSoftwareFactory && inProgressLabel,
  });

  if (!inProgressLabel) return null;

  if (!isSoftwareFactory) {
    return (
      <div className="banner info">
        <strong>Factory run in progress.</strong> A GitHub Actions workflow is working on this issue.{" "}
        <a href={data.epic.htmlUrl} target="_blank" rel="noreferrer">
          Watch on GitHub
        </a>
      </div>
    );
  }

  const run = live.data;
  const runId = orchestratorRunId(run);
  const phase = runPhase(run);
  const model = run?.model;
  const role = run?.role ?? "factory";
  const finished = Boolean(run?.finished_at);
  const runModal = runOpen ? (
    <OrchestratorRunModal
      runId={runId}
      repo={data.repo.fullName}
      issueNumber={data.epic.number}
      onClose={() => setRunOpen(false)}
    />
  ) : null;

  return (
    <>
      <div className="banner info">
        <strong>{finished ? "Factory run" : `${role} running`}</strong>
        {!finished && (
          <>
            {" "}
            — the Software Factory orchestrator is working on this issue
            {model ? (
              <>
                {" "}
                using <code>{model}</code>
              </>
            ) : null}
            {phase ? <> ({phase})</> : null}
          </>
        )}
        {finished && run?.outcome && <> — {run.outcome === "no_op" ? "finished (no GitHub trace)" : run.outcome}</>}
        {runId ? (
          <>
            {" "}
            <Link to={`/runs/${runId}`}>Open run log</Link>
            {" · "}
            <button type="button" className="link" onClick={() => setRunOpen(true)}>
              Full log
            </button>
          </>
        ) : live.isLoading ? (
          <span className="muted"> Loading run log…</span>
        ) : (
          <>
            {" "}
            <button type="button" className="link" onClick={() => setRunOpen(true)}>
              View run log
            </button>
          </>
        )}
      </div>
      {runModal}
    </>
  );
}
