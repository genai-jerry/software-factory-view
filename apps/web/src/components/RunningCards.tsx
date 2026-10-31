import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useFocus } from "../lib/filter.js";
import type { RunningItem } from "../types.js";
import { RepoChip } from "./RepoChip.js";

/** A task's own thread, or the epic when the epic itself is running. */
export function threadLink(item: RunningItem): string {
  return item.kind === "task"
    ? `/epics/${item.epicId}?tab=threads&thread=${encodeURIComponent(`task/${item.number}`)}`
    : `/epics/${item.epicId}`;
}

/** Where a card goes: the run's log, so you can see what the agent is doing; the thread when the run is unknown. */
export function runningLink(item: RunningItem): string {
  return item.runId ? `/runs/${item.runId}` : threadLink(item);
}

/**
 * "Running now": one small card for every task or epic a factory run is live
 * on. It refreshes every 30 seconds and renders nothing when the factory is
 * idle, so a quiet page stays quiet.
 */
export function RunningCards() {
  const focus = useFocus();
  const q = useQuery({
    queryKey: ["running", focus.key],
    queryFn: () => api.get<{ running: RunningItem[] }>(`/api/running${focus.qs}`),
    refetchInterval: 30_000,
  });
  const items = q.data?.running ?? [];
  if (items.length === 0) return null;
  return (
    <section className="card" aria-label="Running now">
      <h2>
        Running now <span className="muted">({items.length})</span>
      </h2>
      <div className="running-strip">
        {items.map((it) => (
          <div key={it.issueId} className="running-card">
            <Link to={runningLink(it)} className="running-card-title" title={`#${it.number} ${it.title}`}>
              #{it.number} {it.title}
            </Link>
            <span className="running-card-meta">
              <RepoChip fullName={it.repo} />
              <span className="badge state">{it.role} running</span>
              {it.kind === "task" && <span className="muted">epic #{it.epicNumber}</span>}
              {it.runId && <Link to={threadLink(it)}>{it.kind === "task" ? "thread" : "epic"}</Link>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
