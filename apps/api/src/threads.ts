import { threadEntries, type Db } from "@console/db";
import { inArray, sql as dsql } from "drizzle-orm";

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
