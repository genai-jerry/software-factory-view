import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useFocus } from "../lib/filter.js";
import type { PastRunItem } from "../types.js";
import { RepoChip } from "./RepoChip.js";

const PAGE = 10;

/** How a run ended, in plain words, with the badge style that says it at a glance. */
export function outcomeOf(outcome: string): { label: string; cls: string } {
  switch (outcome) {
    case "success":
      return { label: "Succeeded", cls: "merge" };
    case "error":
      return { label: "Failed", cls: "blocked" };
    case "timeout":
      return { label: "Timed out", cls: "task-start" };
    case "no_op":
      return { label: "No change", cls: "" };
    default:
      return { label: outcome || "Ended", cls: "" };
  }
}

/** 45 → "45 s", 252 → "4 min 12 s", 7500 → "2 h 5 min". */
export function durationText(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ${seconds % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function agoText(iso: string, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86_400)} d ago`;
}

function threadLink(r: PastRunItem): string | null {
  if (!r.epicId) return null;
  return r.kind === "task"
    ? `/epics/${r.epicId}?tab=threads&thread=${encodeURIComponent(`task/${r.number}`)}`
    : `/epics/${r.epicId}`;
}

/**
 * "Recent runs": the factory's finished runs, ten at a time, newest first.
 * Each card says what ran, on what, how it ended and how long it took, and
 * opens the run's log when the log still exists (a redeploy can clear old
 * ones). It sits under "Running now", so the home page shows what is live and
 * what just happened.
 */
export function RecentRuns() {
  const focus = useFocus();
  const [limit, setLimit] = useState(PAGE);
  const q = useQuery({
    queryKey: ["recent-runs", focus.key, limit],
    queryFn: () => api.get<{ runs: PastRunItem[]; hasMore: boolean }>(`/api/runs/recent${focus.qs ? `${focus.qs}&` : "?"}limit=${limit}`),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  const runs = q.data?.runs ?? [];
  if (runs.length === 0) return null;
  return (
    <section className="card" aria-label="Recent runs">
      <h2>
        Recent runs <span className="muted">({runs.length}{q.data?.hasMore ? "+" : ""})</span>
      </h2>
      <div className="running-strip">
        {runs.map((r) => {
          const o = outcomeOf(r.outcome);
          const thread = threadLink(r);
          const heading = `#${r.number}${r.title ? ` ${r.title}` : ""}`;
          return (
            <div key={r.runId} className="running-card past-run">
              {r.hasLog ? (
                <Link to={`/runs/${r.runId}`} className="running-card-title" title={`Open the run log: ${heading}`}>
                  {heading}
                </Link>
              ) : (
                <span className="running-card-title" title={heading}>
                  {heading}
                </span>
              )}
              <span className="running-card-meta">
                <RepoChip fullName={r.repo} />
                <span className={`badge ${o.cls}`}>{o.label}</span>
                <span>{r.role}</span>
              </span>
              <span className="running-card-meta muted">
                {agoText(r.finishedAt)} · took {durationText(r.seconds)}
                {r.model ? ` · ${r.model}` : ""}
              </span>
              {r.error && r.outcome !== "success" && <span className="running-card-error">{r.error}</span>}
              <span className="running-card-meta">
                {!r.hasLog && <span className="muted">log no longer available</span>}
                {thread && <Link to={thread}>{r.kind === "task" ? "thread" : "epic"}</Link>}
              </span>
            </div>
          );
        })}
        {q.data?.hasMore && (
          <button type="button" className="running-card running-more" onClick={() => setLimit((n) => n + PAGE)} disabled={q.isFetching}>
            {q.isFetching ? "Loading…" : `Show ${PAGE} more`}
          </button>
        )}
      </div>
    </section>
  );
}
