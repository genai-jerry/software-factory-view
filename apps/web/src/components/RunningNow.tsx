import { Link } from "react-router-dom";
import type { EpicWorkspace } from "../types.js";

/**
 * Which of this epic's tasks have a factory run live right now. The epic keeps
 * one label for its whole build, so the header said "5 in flight" and nothing
 * about what an agent was actually doing; the tasks' own cards said it, one
 * thread at a time. This puts it at the top, each run a link to its log (the
 * thread when the orchestrator cannot name the run).
 */
function threadHref(data: EpicWorkspace, number: number): string {
  return `/epics/${data.epic.id}?tab=threads&thread=${encodeURIComponent(`task/${number}`)}`;
}

export function RunningNow({ data }: { data: EpicWorkspace }) {
  const running = data.tasks.filter((t) => t.running && t.open);
  if (running.length === 0) return null;
  return (
    <div className="banner info" role="status">
      <strong>Running now</strong>
      {" — "}
      {running.map((t, i) => (
        <span key={t.id}>
          {i > 0 && ", "}
          {t.runningRole ?? "Factory"} on{" "}
          <Link to={t.runId ? `/runs/${t.runId}` : threadHref(data, t.number)} title={t.runId ? `Open the run log: ${t.title}` : t.title}>
            #{t.number}
          </Link>
          {t.runId && (
            <>
              {" "}
              (<Link to={threadHref(data, t.number)}>thread</Link>)
            </>
          )}
        </span>
      ))}
      .
    </div>
  );
}
