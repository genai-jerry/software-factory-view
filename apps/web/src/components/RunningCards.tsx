import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useFocus } from "../lib/filter.js";
import type { RunningItem } from "../types.js";
import { RepoChip } from "./RepoChip.js";

/** Where a card goes: a task's own thread, or the epic when the epic itself is running. */
export function runningLink(item: RunningItem): string {
  return item.kind === "task"
    ? `/epics/${item.epicId}?tab=threads&thread=${encodeURIComponent(`task/${item.number}`)}`
    : `/epics/${item.epicId}`;
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
          <Link key={it.issueId} to={runningLink(it)} className="running-card" title={`#${it.number} ${it.title}`}>
            <span className="running-card-title">
              #{it.number} {it.title}
            </span>
            <span className="running-card-meta">
              <RepoChip fullName={it.repo} />
              <span className="badge state">{it.role} running</span>
              {it.kind === "task" && <span className="muted">epic #{it.epicNumber}</span>}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
