import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.js";
import { IssuePeek } from "../components/IssuePeek.js";
import { RepoChip } from "../components/RepoChip.js";
import { PipelineBoard } from "../components/PipelineBoard.js";
import { SegmentedTabs } from "../components/SegmentedTabs.js";
import { useFocus } from "../lib/filter.js";
import { EXPEDITE_BADGE, EXPEDITE_TITLE, PHASE_LABELS } from "../lib/labels.js";
import type { BoardCard, FlowData, FlowEpic, FlowMilestone } from "../types.js";

/**
 * The manager / scrum-master lens (plan 07 §7): a collapsible tree from the
 * milestone down, every node rolling up its children, with the Kanban board
 * as an alternate lens on the same page. Same peek drawer as everywhere else
 * — only the top-level organisation differs per audience.
 */
export function FlowPage() {
  const [lens, setLens] = useState<"tree" | "board">("tree");
  const [peekId, setPeekId] = useState<string | null>(null);
  const focus = useFocus();
  const flow = useQuery({ queryKey: ["flow", focus.key], queryFn: () => api.get<FlowData>(`/api/flow${focus.qs}`) });
  const board = useQuery({
    queryKey: ["board", focus.key],
    queryFn: () => api.get<{ columns: string[]; cards: BoardCard[] }>(`/api/board${focus.qs}`),
    enabled: lens === "board",
  });

  return (
    <div>
      <h1>Flow</h1>
      <SegmentedTabs
        ariaLabel="Flow view"
        items={[
          { id: "tree", label: "Tree" },
          { id: "board", label: "Board" },
        ]}
        value={lens}
        onChange={setLens}
      />

      {lens === "board" ? (
        <div className="card">
          {board.isLoading && <p className="muted">Loading…</p>}
          {board.data && <PipelineBoard columns={board.data.columns} cards={board.data.cards} onPeek={setPeekId} />}
        </div>
      ) : (
        <div>
          {flow.isLoading && <p className="muted">Loading…</p>}
          {flow.data?.estates.map((estate) => (
            <div className="card" key={estate.id}>
              <h2>{estate.name}</h2>
              {estate.milestones.length === 0 && <p className="muted">No open epics in this organisation.</p>}
              {estate.milestones.map((m) => (
                <MilestoneNode milestone={m} key={m.title} onPeek={setPeekId} />
              ))}
            </div>
          ))}
        </div>
      )}
      {peekId && <IssuePeek issueId={peekId} onClose={() => setPeekId(null)} />}
    </div>
  );
}

function MilestoneNode({ milestone: m, onPeek }: { milestone: FlowMilestone; onPeek: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const phaseCounts = new Map<string, number>();
  for (const e of m.epics) phaseCounts.set(e.phase, (phaseCounts.get(e.phase) ?? 0) + 1);
  return (
    <div className="tree-node">
      <div
        className="tree-row"
        onClick={() => setOpen(!open)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(!open);
          }
        }}
      >
        <span className="tree-caret" aria-hidden="true">{open ? "▼" : "▶"}</span>
        <strong>{m.title}</strong>
        {m.trackerState && <span className="badge state">{m.trackerState.replace("factory:", "")}</span>}
        <span className="muted">
          {m.epics.length} epic{m.epics.length === 1 ? "" : "s"}
          {[...phaseCounts.entries()].map(([p, n]) => ` · ${n} ${(PHASE_LABELS[p as keyof typeof PHASE_LABELS] ?? p).toLowerCase()}`).join("")}
        </span>
      </div>
      {open && m.epics.map((e) => <EpicNode epic={e} key={e.epicId} onPeek={onPeek} />)}
    </div>
  );
}

function EpicNode({ epic: e, onPeek }: { epic: FlowEpic; onPeek: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const waits =
    e.gate &&
    `${e.gate.label}: ${e.gate.approvers.length > 0 ? e.gate.approvers.map((a) => `@${a}`).join(", ") : "any collaborator"}`;
  return (
    <div className="tree-node indent">
      <div className="tree-row">
        <span
          className="tree-caret"
          onClick={() => setOpen(!open)}
          role="button"
          tabIndex={0}
          aria-label={open ? "Collapse tasks" : "Expand tasks"}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              setOpen(!open);
            }
          }}
        >
          {e.tasks.length > 0 ? (open ? "▼" : "▶") : "·"}
        </span>
        <a
          href="#peek"
          onClick={(ev) => {
            ev.preventDefault();
            onPeek(e.epicId);
          }}
        >
          #{e.number} {e.title}
        </a>
        <span className="badge">{PHASE_LABELS[e.phase]}</span>
        {e.state === "factory:fast-track" && <span className="badge state">fast track</span>}
        {/* Why this epic moves without anyone being asked. */}
        {e.expedited && (
          <span className="badge expedite" title={EXPEDITE_TITLE}>
            {EXPEDITE_BADGE}
          </span>
        )}
        <RepoChip fullName={e.repo} />
        <span className="muted">
          {e.daysInState}d in state
          {e.rollup.total > 0 && ` · ${e.rollup.done}/${e.rollup.total} tasks`}
          {e.rollup.waiting > 0 && ` · ${e.rollup.waiting} waiting`}
          {waits && ` · waits on ${waits}`}
        </span>
        {e.prs.map((pr) => (
          <a className="muted" href={pr.htmlUrl} target="_blank" rel="noreferrer" key={pr.number} title={pr.title}>
            PR #{pr.number} {pr.draft ? "in draft" : "awaiting merge"}
            {pr.ciStatus && pr.ciStatus !== "success" && ` · CI ${pr.ciStatus}`}
          </a>
        ))}
        {e.blockedCount > 0 && <span className="badge blocked">{e.blockedCount} blocked</span>}
      </div>
      {open &&
        e.tasks.map((t) => (
          <div className="tree-row indent" key={t.issueId}>
            <span className="tree-caret">·</span>
            <a
              href="#peek"
              onClick={(ev) => {
                ev.preventDefault();
                onPeek(t.issueId);
              }}
              className={t.open ? "" : "muted"}
            >
              #{t.number} {t.title.replace(/^task\([^)]*\):?\s*/i, "")}
            </a>
            <span className="muted">
              {t.open ? (t.state?.replace("factory:", "") ?? "waiting") : "done"}
              {t.assignees.length > 0 && ` · ${t.assignees.map((a) => `@${a}`).join(", ")}`}
              {t.blockedBy.length > 0 && ` · after ${t.blockedBy.map((n) => `#${n}`).join(", ")}`}
            </span>
            {t.state === "factory:blocked" && <span className="badge blocked">blocked</span>}
          </div>
        ))}
    </div>
  );
}
