import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /ux\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:4177",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4177 --strictPort",
    url: "http://127.0.0.1:4177/e2e.html",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
