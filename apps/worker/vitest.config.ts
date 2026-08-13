import { defineConfig } from "vitest/config";

// Each test boots a fresh in-process Postgres (PGlite) and applies every
// migration; the first test in a file absorbs that warmup, which overruns the
// 5s default on slower machines.
export default defineConfig({
  test: { testTimeout: 30_000 },
});
