import type { BoardCard } from "../types.js";

export const FAST_TRACK_COLUMN = "factory:fast-track";
export const HELD_COLUMN = "held";

/**
 * Partition open cards into the pipeline columns, a Fast track column, and a
 * final Held column. Fast-track epics are live work awaiting a human merge —
 * parking them under "held / off-rail" made them read as paused (and, before
 * the Held column existed, they vanished from the board entirely, which is
 * exactly how a fast-track issue went missing from the factory view). Held
 * keeps everything genuinely off-rail (`factory:blocked`, `factory:incident`,
 * `factory:backlog`, no state at all) visible instead of vanishing.
 */
export function partitionCards(columns: string[], cards: BoardCard[]): Map<string, BoardCard[]> {
  const out = new Map<string, BoardCard[]>();
  for (const col of columns) out.set(col, []);
  out.set(FAST_TRACK_COLUMN, []);
  out.set(HELD_COLUMN, []);
  const onRail = new Set([...columns, FAST_TRACK_COLUMN]);
  for (const card of cards) {
    if (!card.open) continue;
    const col = card.state && onRail.has(card.state) ? card.state : HELD_COLUMN;
    out.get(col)!.push(card);
  }
  return out;
}

/**
 * An epic keeps one state label for its whole build — `design-approved` from
 * the moment its tasks are released until the last one is assembled — so the
 * board's task columns (ready, in-review, in-test, ready-to-ship, on-epic)
 * never held a card, and an epic with tasks in test read as "stuck at design
 * approved". These chips put the work where it is: one per epic per stage
 * that has tasks in it. The epic's own card stays in its gate column.
 */
export interface StageChip {
  card: BoardCard;
  count: number;
}

const TASK_STAGES: Array<{ column: string; count: (t: BoardCard["tasks"]) => number }> = [
  { column: "factory:ready", count: (t) => t.ready },
  { column: "factory:in-review", count: (t) => t.inReview },
  { column: "factory:in-test", count: (t) => t.inTest },
  { column: "factory:ready-to-ship", count: (t) => t.readyToShip ?? 0 },
  { column: "factory:on-epic", count: (t) => t.onEpic ?? 0 },
];

export function stageChips(columns: string[], cards: BoardCard[]): Map<string, StageChip[]> {
  const out = new Map<string, StageChip[]>();
  const shown = new Set(columns);
  for (const card of cards) {
    if (!card.open) continue;
    for (const stage of TASK_STAGES) {
      const count = stage.count(card.tasks);
      if (count > 0 && shown.has(stage.column)) {
        out.set(stage.column, [...(out.get(stage.column) ?? []), { card, count }]);
      }
    }
  }
  return out;
}

/** The counts behind a card's stage line, zero entries left out. */
export function stageLine(t: BoardCard["tasks"]): string[] {
  const parts: Array<[number, string]> = [
    [t.ready, "ready to start"],
    [t.inReview, "in review"],
    [t.inTest, "in test"],
    [t.readyToShip ?? 0, "ready to ship"],
    [t.onEpic ?? 0, "on the epic branch"],
    [t.blocked, "blocked"],
  ];
  const out = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  const tests = t.tests;
  if (tests && tests.total > 0) {
    if (tests.runnable > 0) out.push(`${tests.runnable} test${tests.runnable === 1 ? "" : "s"} to run`);
    if (tests.failed > 0) out.push(`${tests.failed} test${tests.failed === 1 ? "" : "s"} failed`);
    if (tests.runnable === 0 && tests.failed === 0) out.push(`${tests.passed}/${tests.total} tests passed`);
  }
  return out;
}
