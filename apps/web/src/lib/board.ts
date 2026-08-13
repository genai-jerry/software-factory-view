import type { BoardCard } from "../types.js";

export const HELD_COLUMN = "held";

/**
 * Partition open cards into the pipeline columns plus a final Held column for
 * everything off-rail (`factory:blocked`, `factory:fast-track`,
 * `factory:incident`) or with no factory state at all. Without it those cards
 * rendered in no column and silently vanished from the board.
 */
export function partitionCards(columns: string[], cards: BoardCard[]): Map<string, BoardCard[]> {
  const out = new Map<string, BoardCard[]>();
  for (const col of columns) out.set(col, []);
  out.set(HELD_COLUMN, []);
  const onRail = new Set(columns);
  for (const card of cards) {
    if (!card.open) continue;
    const col = card.state && onRail.has(card.state) ? card.state : HELD_COLUMN;
    out.get(col)!.push(card);
  }
  return out;
}
