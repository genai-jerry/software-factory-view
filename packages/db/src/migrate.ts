import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Minimal forward-only migration runner. Applies migrations/*.sql in
 * lexicographic order, recording each in _migrations. Statement-breakpoint
 * splitting matches drizzle-kit's output format.
 */
export async function runMigrations(databaseUrl: string, migrationsDir?: string): Promise<string[]> {
  const dir = migrationsDir ?? join(dirname(fileURLToPath(import.meta.url)), "migrations");
  // Read the directory before touching the database: a missing or empty
  // migrations dir means a broken build/copy (the .sql files ride along via
  // the package's build step), and silently reporting "up to date" against
  // an empty schema is exactly the failure that surfaces later as
  // `relation "sessions" does not exist`. Fail loudly here instead.
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  } catch (err) {
    throw new Error(`migrations directory not found at ${dir} — the @console/db build copies migrations/ into dist/; rebuild the package (pnpm -r build) or the image (./scripts/start.sh --rebuild)`, { cause: err });
  }
  if (files.length === 0) {
    throw new Error(`no .sql migrations found in ${dir} — the build's migrations copy is incomplete; rebuild the package (pnpm -r build) or the image (./scripts/start.sh --rebuild)`);
  }
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const applied: string[] = [];
  try {
    // The api and worker boot together and both migrate. Without this lock they
    // race: each sees a migration as unapplied and runs CREATE TABLE at the same
    // moment, and Postgres fails one with a duplicate-key error on its own type
    // catalog (pg_type_typname_nsp_index). The loser here simply waits, then
    // finds every migration already recorded and applies nothing.
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await sql`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      for (const file of files) {
        const done = await sql`SELECT 1 FROM _migrations WHERE name = ${file}`;
        if (done.length > 0) continue;
        const text = await readFile(join(dir, file), "utf8");
        const statements = text
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter(Boolean);
        await sql.begin(async (tx) => {
          for (const stmt of statements) await tx.unsafe(stmt);
          await tx`INSERT INTO _migrations (name) VALUES (${file})`;
        });
        applied.push(file);
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await sql.end();
  }
  return applied;
}

/** Arbitrary but fixed: every Console process must agree on the same lock. */
const MIGRATION_LOCK_KEY = 8_675_309;
