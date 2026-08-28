import { Link, useParams } from "react-router-dom";
import { OrchestratorRunDetail } from "../components/OrchestratorRunView.js";

/**
 * Same-origin page for GitHub comments that link PUBLIC_BASE_URL/runs/{id}.
 * The orchestrator itself only serves JSON at that path; this is the human log.
 */
export function OrchestratorRunPage() {
  const { runId = "" } = useParams();
  return (
    <div className="run-page">
      <p className="muted" style={{ marginTop: 0 }}>
        <Link to="/">My work</Link>
      </p>
      <div className="spread">
        <h1 style={{ marginBottom: 0 }}>Orchestrator run</h1>
        <code className="muted">{runId}</code>
      </div>
      <p className="muted">
        Live log for one Software Factory role — outcome, model, a live event
        timeline, and Claude's transcript as it is written. Factory comments on GitHub
        point here instead of the orchestrator's raw JSON.
      </p>
      <OrchestratorRunDetail runId={runId} repo="" />
    </div>
  );
}
