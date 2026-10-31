import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { RepoChip } from "../components/RepoChip.js";
import { useFocus } from "../lib/filter.js";
import { roleName } from "../lib/runs.js";
import { STAGE_LABEL } from "../lib/work.js";
import type { FactoryUsage, RunningItem } from "../types.js";

/**
 * Activity — what people and the factory did, newest first (redesign board
 * 3b). One line per move, grouped by day, each opening the item where it
 * happened; what is running now and today's Claude use beside it.
 */

interface Line {
  at: string;
  who: string;
  person: boolean;
  text: string;
  stage: string | null;
  repo: string;
  epicId: string;
}

type Who = "everyone" | "people" | "factory";

export function ActivityPage() {
  const focus = useFocus();
  const [who, setWho] = useState<Who>("everyone");
  const activity = useQuery({ queryKey: ["activity", focus.key], queryFn: () => api.get<{ lines: Line[] }>(`/api/activity${focus.qs}`), refetchInterval: 60_000 });
  const running = useQuery({ queryKey: ["running"], queryFn: () => api.get<{ items: RunningItem[] }>("/api/running"), refetchInterval: 30_000 });
  const usage = useQuery({ queryKey: ["usage"], queryFn: () => api.get<FactoryUsage>("/api/orchestrator/usage"), retry: false });

  const lines = (activity.data?.lines ?? []).filter((l) => (who === "everyone" ? true : who === "people" ? l.person : !l.person));
  const days = new Map<string, Line[]>();
  for (const l of lines) {
    const key = dayLabel(new Date(l.at));
    days.set(key, [...(days.get(key) ?? []), l]);
  }

  return (
    <div className="activity-page">
      <h1>Activity</h1>
      <p className="muted">What people and the factory did, newest first. Each line opens the item where it happened.</p>
      <div className="wi-body">
        <div className="wi-main">
          <div className="act-filter" role="group" aria-label="Who">
            {(["everyone", "people", "factory"] as Who[]).map((w) => (
              <button key={w} type="button" className={who === w ? "primary" : ""} onClick={() => setWho(w)}>
                {w === "everyone" ? "Everyone" : w === "people" ? "People" : "The factory"}
              </button>
            ))}
          </div>
          {activity.isLoading && <p className="muted">Reading…</p>}
          {activity.data && lines.length === 0 && <p className="muted">Nothing yet.</p>}
          {[...days.entries()].map(([day, list]) => (
            <section className="card" key={day}>
              <h2>{day}</h2>
              {list.map((l, i) => (
                <Link to={`/work/${l.epicId}`} className="act-line" key={i}>
                  <span className="act-time">{new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="act-text">
                    <strong>{l.who}</strong> {l.text.replace(new RegExp(`^${escape(l.who)} `), "")}
                  </span>
                  <span className="act-meta">
                    {l.stage && l.stage !== "new" && <span className="stage-chip">{STAGE_LABEL[l.stage as keyof typeof STAGE_LABEL] ?? l.stage}</span>}
                    {l.stage === "new" && <span className="stage-chip">New</span>}
                    <RepoChip fullName={l.repo} />
                  </span>
                </Link>
              ))}
            </section>
          ))}
        </div>
        <aside className="wi-side">
          <section className="card">
            <h2>Running now {running.data && <span className="muted">({running.data.items.length})</span>}</h2>
            {running.data?.items.length === 0 && <p className="muted">Nothing is running.</p>}
            <ul className="facts">
              {running.data?.items.map((r) => (
                <li key={r.issueId}>
                  {roleName(r.role)} on {r.kind === "task" ? `task #${r.number} of ${r.epicTitle}` : r.epicTitle}
                  {r.runId && (
                    <>
                      {" · "}
                      <Link to={`/runs/${r.runId}`}>what it is doing</Link>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>Claude use</h2>
            {usage.data ? (
              <>
                <p>
                  {usage.data.runs} run{usage.data.runs === 1 ? "" : "s"} in the last {usage.data.window_hours} hours
                  {usage.data.active_runs > 0 && `, ${usage.data.active_runs} live`}.
                </p>
                <p className="muted">
                  {usage.data.limit.reached
                    ? `The limit was hit${usage.data.limit.resets_at ? `; it resets at ${new Date(usage.data.limit.resets_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}.`
                    : "No limit hit."}
                </p>
              </>
            ) : (
              <p className="muted">Not available.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}
