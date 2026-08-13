import type { BoardCard } from "../types.js";
import { HELD_COLUMN, partitionCards } from "../lib/board.js";

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
  "factory:deployed": "deployed",
  [HELD_COLUMN]: "held / off-rail",
};

/**
 * The flow lens: epics as cards in state-machine columns, plus a final Held
 * column so off-rail epics (blocked / fast-track / incident / no state) are
 * visible instead of vanishing. Card click opens the peek drawer — same
 * disclosure model as the personal sections.
 */
export function PipelineBoard({ columns, cards, onPeek }: { columns: string[]; cards: BoardCard[]; onPeek: (issueId: string) => void }) {
  const byCol = partitionCards(columns, cards);
  return (
    <div className="board">
      {[...byCol.entries()].map(([col, colCards]) => (
        <div className="board-col" key={col}>
          <h4>
            {STATE_SHORT[col] ?? col} {colCards.length > 0 && `(${colCards.length})`}
          </h4>
          {colCards.map((c) => (
            <div
              className={`board-card clickable${c.blocked ? " blocked" : ""}`}
              key={c.epicId}
              onClick={() => onPeek(c.epicId)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && onPeek(c.epicId)}
            >
              <div>
                #{c.number} {c.title}
              </div>
              <div className="meta">
                <span>{c.repo.split("/")[1]}</span>
                <span>{c.daysInState}d in state</span>
                {c.tasks.total > 0 && (
                  <span>
                    {c.tasks.done}/{c.tasks.total} tasks
                  </span>
                )}
                {c.tasks.waiting > 0 && <span>{c.tasks.waiting} waiting</span>}
                {c.blocked && <span className="badge blocked">blocked</span>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
