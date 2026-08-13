import { defineConfig } from "vitest/config";

// Suites boot an in-process Postgres (PGlite) and apply every migration in
// beforeAll; allow for that warmup on slower machines.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 60_000 },
});
