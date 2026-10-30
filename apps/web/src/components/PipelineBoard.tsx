import type { BoardCard } from "../types.js";
import { RepoChip } from "./RepoChip.js";
import { FAST_TRACK_COLUMN, HELD_COLUMN, partitionCards, stageChips, stageLine, type StageChip } from "../lib/board.js";
import { EXPEDITE_BADGE, EXPEDITE_TITLE, PHASE_LABELS, peopleLabel } from "../lib/labels.js";

const STATE_SHORT: Record<string, string> = {
  "factory:intake": "intake",
  "factory:spec-ready": "spec-ready",
  "factory:spec-approved": "spec-approved",
  "factory:planned": "planned",
  "factory:design-ready": "design-ready",
  "factory:design-approved": "design-approved",
  "factory:ready": "ready",
  "factory:in-review": "in-review",
  "factory:in-test": "in-test",
  "factory:ready-to-ship": "ready-to-ship",
  "factory:on-epic": "on-epic",
  "factory:epic-ready": "epic-ready",
  "factory:in-staging": "in-staging",
  "factory:deployed": "deployed",
  [FAST_TRACK_COLUMN]: "fast track",
  [HELD_COLUMN]: "held / off-rail",
};

const LIST_PHASES: Array<{ id: string; label: string; match: (state: string | null) => boolean }> = [
  { id: "held", label: PHASE_LABELS.held, match: (s) => !s || s === "factory:blocked" || s === "factory:incident" || s === "factory:backlog" },
  { id: "spec", label: PHASE_LABELS.specifying, match: (s) => s === "factory:intake" || s === "factory:spec-ready" },
  { id: "plan", label: PHASE_LABELS.planning, match: (s) => s === "factory:spec-approved" || s === "factory:planned" || s === "factory:design-ready" },
  { id: "build", label: PHASE_LABELS.building, match: (s) => s === "factory:design-approved" || s === "factory:ready" || s === "factory:in-review" || s === "factory:in-test" },
  { id: "ship", label: PHASE_LABELS.shipping, match: (s) => s === "factory:ready-to-ship" || s === "factory:on-epic" || s === "factory:epic-ready" || s === "factory:in-staging" || s === "factory:deployed" },
  { id: "fast", label: "Fast track", match: (s) => s === FAST_TRACK_COLUMN || s === "factory:fast-track" },
];

export function PipelineBoard({ columns, cards, onPeek }: { columns: string[]; cards: BoardCard[]; onPeek: (issueId: string) => void }) {
  const byCol = partitionCards(columns, cards);
  const chips = stageChips(columns, cards);
  const openCards = cards.filter((c) => c.open);
  return (
    <div className="board-host">
      <div className="board">
        {[...byCol.entries()].map(([col, colCards]) => {
          const work = chips.get(col) ?? [];
          const total = colCards.length + work.reduce((n, w) => n + w.count, 0);
          return (
            <div className="board-col" key={col}>
              <h4>
                {STATE_SHORT[col] ?? col} {total > 0 && `(${total})`}
              </h4>
              {colCards.map((c) => (
                <BoardCardView key={c.epicId} card={c} onPeek={onPeek} />
              ))}
              {work.map((w) => (
                <StageChipView key={w.card.epicId} chip={w} onPeek={onPeek} />
              ))}
            </div>
          );
        })}
      </div>
      <div className="board-list">
        {LIST_PHASES.map((phase) => {
          const items = openCards.filter((c) => phase.match(c.state));
          if (items.length === 0) return null;
          return (
            <div className="board-phase" key={phase.id}>
              <h4>
                {phase.label} ({items.length})
              </h4>
              {items.map((c) => (
                <BoardCardView key={c.epicId} card={c} onPeek={onPeek} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Tasks of one epic that sit in this column's stage. The epic's own card is
    in its gate column; this says where its work actually is. */
function StageChipView({ chip: { card: c, count }, onPeek }: { chip: StageChip; onPeek: (id: string) => void }) {
  return (
    <button
      type="button"
      className="board-chip"
      onClick={() => onPeek(c.epicId)}
      title={`#${c.number} ${c.title}`}
    >
      <strong>
        {count} task{count === 1 ? "" : "s"}
      </strong>{" "}
      of #{c.number} {c.title}
    </button>
  );
}

function BoardCardView({ card: c, onPeek }: { card: BoardCard; onPeek: (id: string) => void }) {
  return (
    <div
      className={`board-card clickable${c.blocked ? " blocked" : ""}`}
      onClick={() => onPeek(c.epicId)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPeek(c.epicId);
        }
      }}
    >
      <div>
        #{c.number} {c.title}
      </div>
      <div className="meta">
        <RepoChip fullName={c.repo} />
        <span>{peopleLabel(c.state)}</span>
        <span>{c.daysInState}d in state</span>
        {c.tasks.total > 0 && (
          <span>
            {c.tasks.done}/{c.tasks.total} tasks
          </span>
        )}
        {c.tasks.waiting > 0 && <span>{c.tasks.waiting} waiting on another task</span>}
        {/* The marker changes what the state means — this epic advances
            between gates on its own — so the card says so. */}
        {c.expedited && (
          <span className="badge expedite" title={EXPEDITE_TITLE}>
            {EXPEDITE_BADGE}
          </span>
        )}
        {c.blocked && <span className="badge blocked">Agent halted</span>}
      </div>
      {/* A task closes only at the end of the line, so "0/8 tasks" is what a
          fully-busy epic reads as. Where the rest of them are is the point of
          the card: the epic keeps one gate label for the whole build. */}
      {stageLine(c.tasks).length > 0 && (
        <div className="board-stages">{stageLine(c.tasks).join(" · ")}</div>
      )}
    </div>
  );
}
