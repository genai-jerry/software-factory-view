import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@console/db";

/** In-process Postgres for projection tests: real SQL, zero infrastructure.
 * Applies every migration in order, exactly like the runtime runner. */
export async function testDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = new PGlite();
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await pg.exec(s);
    }
  }
  // PGlite's drizzle instance is API-compatible with the postgres-js one for
  // everything the projectors use; the cast keeps one projector signature.
  const db = drizzle(pg) as unknown as Db;
  return { db, pg };
}
