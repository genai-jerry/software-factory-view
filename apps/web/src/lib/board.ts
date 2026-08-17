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
