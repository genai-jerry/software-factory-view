import { comments, issueStateHistory } from "@console/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { AppDeps } from "./context.js";
import { isRoleComment, visiblePart } from "./questions.js";

/**
 * Gate GS, read from the epic's own thread rather than its label alone.
 *
 * The label stays `factory:epic-ready` while the Release Manager works on an
 * approved release — it stops short when something is missing (a sibling
 * repo's design PR, a task still in review) and says your approval stands.
 * Reading only the label, Compass asked for the release again after every
 * such run, and each click started another run that stopped for the same
 * reason (beacon-api#324). So: has a person already approved since the epic
 * reached the gate, and what does the factory's newest word ask of a person?
 */

export interface ReleaseMeta {
  /** Who approved the release, and when — null when nobody has yet. */
  approvedBy: string | null;
  approvedAt: Date | null;
  /** The factory's newest "You need to: …" line since the approval, as plain text. */
  ask: string | null;
  /** The first link in that line (the PR to merge, say). */
  askLink: string | null;
}

const APPROVED = /^\s*approved\s*[.!]?\s*$/i;
const NEED = /\*\*You need to:\*\*\s*(.+)/i;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** "Merge [the design](https://…) — that is …" → text without markdown, and the first URL. */
export function readNeed(body: string): { text: string; link: string | null } | null {
  const m = NEED.exec(visiblePart(body));
  if (!m) return null;
  let link: string | null = null;
  const text = m[1]!
    .replace(LINK, (_all, label: string, url: string) => {
      link ??= url;
      return label;
    })
    .replace(/[*_`]/g, "")
    .trim();
  return text ? { text, link } : null;
}

export async function loadReleaseMeta(deps: AppDeps, epicIds: string[]): Promise<Map<string, ReleaseMeta>> {
  const { db } = deps.dbh;
  const out = new Map<string, ReleaseMeta>();
  if (epicIds.length === 0) return out;
  for (const id of epicIds) out.set(id, { approvedBy: null, approvedAt: null, ask: null, askLink: null });

  // The gate opened when the epic first reached it; an approval before that was for another gate.
  const reached = new Map<string, Date>();
  const history = await db
    .select({ issueId: issueStateHistory.issueId, at: issueStateHistory.occurredAt })
    .from(issueStateHistory)
    .where(and(inArray(issueStateHistory.issueId, epicIds), eq(issueStateHistory.toState, "factory:epic-ready")))
    .orderBy(asc(issueStateHistory.occurredAt));
  for (const h of history) if (!reached.has(h.issueId)) reached.set(h.issueId, h.at);

  const rows = await db
    .select({ issueId: comments.issueId, body: comments.body, author: comments.author, isAgent: comments.isAgent, at: comments.ghCreatedAt })
    .from(comments)
    .where(inArray(comments.issueId, epicIds))
    .orderBy(desc(comments.ghCreatedAt));

  for (const id of epicIds) {
    const since = reached.get(id);
    if (!since) continue;
    const mine = rows.filter((r) => r.issueId === id && r.at.getTime() >= since.getTime() - 60_000);
    // Newest-first: the most recent approval stands for the gate.
    const approval = mine.find((r) => !r.isAgent && APPROVED.test(r.body ?? ""));
    if (!approval) continue;
    const meta = out.get(id)!;
    meta.approvedBy = approval.author ?? null;
    meta.approvedAt = approval.at;
    // What the factory asks now: its newest role comment after the approval decides,
    // and a newest comment that asks nothing means nothing is asked.
    const newest = mine.find((r) => r.isAgent && isRoleComment(r.body) && r.at.getTime() > approval.at.getTime());
    const need = newest ? readNeed(newest.body ?? "") : null;
    if (need) {
      meta.ask = need.text;
      meta.askLink = need.link;
    }
  }
  return out;
}
