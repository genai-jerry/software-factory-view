import { Link } from "react-router-dom";
import type { EpicWorkspace } from "../types.js";

/**
 * Which of this epic's tasks have a factory run live right now. The epic keeps
 * one label for its whole build, so the header said "5 in flight" and nothing
 * about what an agent was actually doing; the tasks' own cards said it, one
 * thread at a time. This puts it at the top, each run a link to its thread.
 */
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
          <Link to={`/epics/${data.epic.id}?tab=threads&thread=${encodeURIComponent(`task/${t.number}`)}`} title={t.title}>
            #{t.number}
          </Link>
        </span>
      ))}
      .
    </div>
  );
}
