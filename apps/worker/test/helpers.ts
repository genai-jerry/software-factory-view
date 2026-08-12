import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@console/db";

/** In-process Postgres for projection tests: real SQL, zero infrastructure. */
export async function testDb(): Promise<{ db: Db; pg: PGlite; params: unknown[] }> {
  const pg = new PGlite();
  const migrationPath = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations/0000_init.sql");
  const sql = await readFile(migrationPath, "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await pg.exec(s);
  }
  // Every bound parameter drizzle hands the driver, in order. PGlite is more
  // forgiving than postgres.js about what it will serialise, so tests assert
  // on this directly rather than trusting "it ran here" (see the driver-safe
  // parameters test in projection.test.ts).
  const params: unknown[] = [];
  // PGlite's drizzle instance is API-compatible with the postgres-js one for
  // everything the projectors use; the cast keeps one projector signature.
  const db = drizzle(pg, {
    logger: { logQuery: (_query, queryParams) => void params.push(...queryParams) },
  }) as unknown as Db;
  return { db, pg, params };
}
