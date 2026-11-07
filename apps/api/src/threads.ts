import { comments, threadEntries, type Db } from "@console/db";
import { eq, inArray, sql as dsql } from "drizzle-orm";

/**
 * Entry counts for a set of threads, as one grouped query.
 *
 * Deliberately not a correlated subquery. Drizzle renders columns unqualified
 * inside a raw `sql` template, so the natural-looking
 *
 *     sql`(select count(*) from ${threadEntries} where ${threadEntries.threadId} = ${threads.id})`
 *
 * compiles to `... where "thread_id" = "id"`, and inside the subquery both names
 * resolve against `thread_entries` — a predicate that is never true. It reported
 * every thread as empty, which hid the gate panel's open questions.
 */
export async function countThreadEntries(db: Db, threadIds: string[]): Promise<Map<string, number>> {
  if (threadIds.length === 0) return new Map();
  const rows = await db
    .select({ threadId: threadEntries.threadId, n: dsql<number>`count(*)` })
    .from(threadEntries)
    .where(inArray(threadEntries.threadId, threadIds))
    .groupBy(threadEntries.threadId);
  return new Map(rows.map((r) => [r.threadId, Number(r.n)]));
}

/** The exact comment controls (FACTORY.md §4): a person's move, not a question. */
const CONTROL = /^\s*(approved|plan\s+release|plan\s+tests|review\s+done|test\s+passed|test\s+failed|skip\s+tests)\s*[.!]?\s*$/i;
const BOT = /\[bot\]$|^github-actions/;

/**
 * How many entries in each thread a person actually wrote — the ones a gate
 * can be held on. A thread mirrors every comment on its topic, so the gate
 * thread fills with the factory's own hand-off notices, the approver's
 * `Approved` and the run-start note, none of which asks anything. Counting
 * those held gate GS on "1 open question" that nobody had asked.
 */
export async function countQuestionEntries(db: Db, threadIds: string[], viewer?: string): Promise<Map<string, number>> {
  if (threadIds.length === 0) return new Map();
  const rows = await db
    .select({
      threadId: threadEntries.threadId,
      source: threadEntries.source,
      author: threadEntries.author,
      noteBody: threadEntries.body,
      commentBody: comments.body,
      commentAuthor: comments.author,
    })
    .from(threadEntries)
    .leftJoin(comments, eq(comments.id, threadEntries.commentId))
    .where(inArray(threadEntries.threadId, threadIds));
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.source === "ask_answer") continue;
    const author = r.author ?? r.commentAuthor;
    if (author && BOT.test(author)) continue;
    // What the person looking wrote is their own instruction or note, not a
    // question put to them: "Merge the beacon-web design PR" on the gate
    // thread held that same person's GS approval on "1 open question".
    if (viewer && author && author.toLowerCase() === viewer.toLowerCase()) continue;
    const body = r.source === "gh_comment" ? r.commentBody : r.noteBody;
    if (body && (CONTROL.test(body) || body.includes("<!-- factory-agent -->"))) continue;
    out.set(r.threadId, (out.get(r.threadId) ?? 0) + 1);
  }
  return out;
}
