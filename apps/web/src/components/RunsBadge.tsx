import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { plainTitle } from "../lib/labels.js";
import { roleName } from "../lib/runs.js";
import { useIsPhone } from "../lib/screens.js";
import type { RunningItem } from "../types.js";
import { Sheet } from "./Sheet.js";

/** What a run is doing, in the reader's words: "Release Manager on Day-wise…". */
export function runLine(r: RunningItem): { who: string; what: string } {
  const who = roleName(r.role);
  const item = plainTitle(r.title) || r.epicTitle || `#${r.number}`;
  const what = r.kind === "task" && r.epicTitle ? `the task “${item}” of ${r.epicTitle}` : item;
  return { who, what };
}

/**
 * What is running, one line per run, each opening its run (or its epic when
 * the run has no page yet). Shared by the header popover and the phone sheet.
 */
export function RunsList({ running, onPick }: { running: RunningItem[]; onPick: () => void }) {
  return (
    <>
      {running.length === 0 ? (
        <p className="muted">Nothing is running. The factory starts when a task is released or a gate is approved.</p>
      ) : (
        <ul className="runs-list">
          {running.map((r) => {
            const { who, what } = runLine(r);
            return (
              <li key={r.issueId}>
                <Link to={r.runId ? `/runs/${r.runId}` : `/work/${r.epicId}`} onClick={onPick}>
                  <strong>{who}</strong> on {what}
                </Link>
                <span className="muted"> · {r.repo.split("/").pop()}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted runs-all">
        <Link to="/activity" onClick={onPick}>
          All activity
        </Link>
      </p>
    </>
  );
}

/**
 * Header badge: how many factory runs are live right now, and which. The
 * Work page's "factory is working" list only covers items with no decision
 * pending, so a release the reader just approved — a run on the epic itself
 * — showed nowhere on the home page. This is the always-visible sign, on
 * every page, with the list one click away.
 *
 * On a phone the list opens in the bottom sheet (epic #178, design D5): at
 * 360px the header wraps, the badge can sit near the left edge, and a
 * popover anchored to its right side ran off the screen. The sheet always
 * stays on screen, traps focus and closes on Escape by itself, so the
 * outside-click and Escape listeners below serve the popover only.
 */
export function RunsBadge() {
  const q = useQuery({
    queryKey: ["running"],
    queryFn: () => api.get<{ running: RunningItem[] }>("/api/running"),
    refetchInterval: 15_000,
  });
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const asPopover = open && !phone;
  useEffect(() => {
    if (!asPopover) return;
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
  }, [asPopover]);
  const running = q.data?.running ?? [];
  const n = running.length;
  const close = () => setOpen(false);
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
      {asPopover && (
        <div className="runs-pop" role="dialog" aria-label="Running now">
          <h3>Running now</h3>
          <RunsList running={running} onPick={close} />
        </div>
      )}
      {open && phone && (
        <Sheet title="Running now" onClose={close}>
          <RunsList running={running} onPick={close} />
        </Sheet>
      )}
    </div>
  );
}
