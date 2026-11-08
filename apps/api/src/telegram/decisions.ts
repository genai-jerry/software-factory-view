import { decisionCards, type AttentionEntry, type BoardCard, type RunningItem, type WorkItem } from "@console/core";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../context.js";
import { asUser } from "./as-user.js";

/**
 * The decisions waiting on one person — computed from the same three reads
 * and the same `decisionCards` the Decisions page uses, as that person, so the
 * phone and the page always agree (openspec telegram-decisions, design §3).
 * Null when the reads fail (the person's sign-in has lapsed, say): the caller
 * then changes nothing rather than resolving every open message.
 */
export async function decisionsFor(app: FastifyInstance, deps: AppDeps, userId: string): Promise<WorkItem[] | null> {
  const [board, mine, running] = await Promise.all([
    asUser<{ cards: BoardCard[] }>(app, deps, userId, "GET", "/api/board"),
    asUser<{ needsYou: AttentionEntry[] }>(app, deps, userId, "GET", "/api/my-work"),
    asUser<{ running: RunningItem[] }>(app, deps, userId, "GET", "/api/running"),
  ]);
  if (!board.ok || !mine.ok || !running.ok) return null;
  return decisionCards(board.body.cards, mine.body.needsYou, running.body.running);
}

/** The entry an ask is about: the gate, the blocked question, the first start. */
export function primaryEntry(w: WorkItem): AttentionEntry | undefined {
  const want: Record<string, (e: AttentionEntry) => boolean> = {
    answer: (e) => e.kind === "blocked",
    decide: (e) => e.kind === "gate",
    release: (e) => e.kind === "gate",
    ship: (e) => e.kind === "merge" || e.kind === "gate",
  };
  const f = w.ask ? want[w.ask] : undefined;
  return (f ? w.entries.find(f) : undefined) ?? w.entries[0];
}

/**
 * A decision's identity: the item, the repo, what is asked, and — for a gate
 * or a blocked question — which issue and state. Approving the plan and then
 * the design are two decisions; a second task joining the review list is the
 * same decision, its message edited in place.
 */
export function decisionKey(w: WorkItem): string {
  const e = primaryEntry(w);
  const specific = w.ask === "decide" || w.ask === "release" || w.ask === "ship" || w.ask === "answer";
  return [w.card.epicId, w.card.repo, w.ask ?? "-", specific ? `${e?.issueId ?? "-"}@${e?.state ?? "-"}` : ""].join("|");
}

/** The issue a discussion about this decision is about, and where its comment goes. */
export function discussionIssue(w: WorkItem): string {
  if (w.ask === "answer") return primaryEntry(w)?.issueId ?? w.card.epicId;
  return w.card.epicId;
}
