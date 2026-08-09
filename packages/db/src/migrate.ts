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
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const applied: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
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
    await sql.end();
  }
  return applied;
}
