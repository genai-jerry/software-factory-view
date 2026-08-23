import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";

/**
 * The silent-empty guard: a missing or .sql-less migrations directory means a
 * broken build/copy and must fail loudly BEFORE any database connection —
 * "up to date" against an empty schema surfaces later as
 * `relation "sessions" does not exist` in whatever service boots first.
 * The URL below is never dialled: the directory check throws first.
 */
const NEVER_DIALLED = "postgres://nobody:nope@127.0.0.1:1/na";

describe("runMigrations directory guard", () => {
  it("rejects a missing migrations directory with a rebuild hint", async () => {
    await expect(runMigrations(NEVER_DIALLED, "/nonexistent/migrations"))
      .rejects.toThrow(/migrations directory not found .*rebuild/);
  });

  it("rejects an empty migrations directory instead of reporting up-to-date", async () => {
    const empty = await mkdtemp(join(tmpdir(), "migrations-empty-"));
    await expect(runMigrations(NEVER_DIALLED, empty))
      .rejects.toThrow(/no \.sql migrations found .*rebuild/);
  });
});
