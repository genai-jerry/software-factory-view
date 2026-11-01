import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { plainTitle } from "../lib/labels.js";
import { roleName } from "../lib/runs.js";
import type { RunningItem } from "../types.js";

/** What a run is doing, in the reader's words: "Release Manager on Day-wise…". */
export function runLine(r: RunningItem): { who: string; what: string } {
  const who = roleName(r.role);
  const item = plainTitle(r.title) || r.epicTitle || `#${r.number}`;
  const what = r.kind === "task" && r.epicTitle ? `the task “${item}” of ${r.epicTitle}` : item;
  return { who, what };
}

/**
 * Header badge: how many factory runs are live right now, and which. The
 * Work page's "factory is working" list only covers items with no decision
 * pending, so a release the reader just approved — a run on the epic itself
 * — showed nowhere on the home page. This is the always-visible sign, on
 * every page, with the list one click away.
 */
export function RunsBadge() {
  const q = useQuery({
    queryKey: ["running"],
    queryFn: () => api.get<{ running: RunningItem[] }>("/api/running"),
    refetchInterval: 15_000,
  });
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const running = q.data?.running ?? [];
  const n = running.length;
  return (
    <div className="runs-badge" ref={box}>
      <button
        type="button"
        className={`runs-pill${n > 0 ? " live" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={n > 0 ? "What the factory is doing right now" : "The factory is idle"}
      >
        <span className="dot" aria-hidden="true" />
        {n === 0 ? "Factory idle" : `${n} running`}
      </button>
      {open && (
        <div className="runs-pop" role="dialog" aria-label="Running now">
          <h3>Running now</h3>
          {n === 0 ? (
            <p className="muted">Nothing is running. The factory starts when a task is released or a gate is approved.</p>
          ) : (
            <ul>
              {running.map((r) => {
                const { who, what } = runLine(r);
                return (
                  <li key={r.issueId}>
                    <Link to={r.runId ? `/runs/${r.runId}` : `/work/${r.epicId}`} onClick={() => setOpen(false)}>
                      <strong>{who}</strong> on {what}
                    </Link>
                    <span className="muted"> · {r.repo.split("/").pop()}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="muted">
            <Link to="/activity" onClick={() => setOpen(false)}>
              All activity
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
