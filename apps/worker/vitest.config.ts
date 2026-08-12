import { defineConfig } from "vitest/config";

/**
 * The worker's tests are integration-shaped: each one boots an in-process
 * Postgres (PGlite) or shells out to git/npx. On a loaded machine that alone
 * outruns vitest's 5s default long before the assertions get a chance, so the
 * budget is set where a genuine hang still fails but a slow boot does not.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
