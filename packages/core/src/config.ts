import { z } from "zod";

/**
 * Environment configuration, validated at process start. Fail fast: a missing
 * required variable is a crash at boot, not a 500 three hours later.
 */

const envSchema = z.object({
  DATABASE_URL: z.string().url().default("postgres://console:console@localhost:5432/console"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  API_PORT: z.coerce.number().default(8787),
  /** Public origin the browser sees, e.g. https://console.example.com (used for OAuth redirect). */
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:5173"),

  // GitHub App (created by the operator; see README)
  GITHUB_APP_ID: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY: z.string().default(""), // PEM, \n-escaped allowed
  GITHUB_APP_WEBHOOK_SECRET: z.string().default(""),
  GITHUB_OAUTH_CLIENT_ID: z.string().default(""),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().default(""),
  /** Base URL for GitHub API; override for GHES. */
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  GITHUB_WEB_URL: z.string().url().default("https://github.com"),

  /** 32-byte base64 master key for envelope encryption. */
  CONSOLE_MASTER_KEY: z.string().default(""),

  /** Anthropic key for the insight service; empty disables Q&A. */
  ANTHROPIC_API_KEY: z.string().default(""),
  INSIGHT_FAST_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  INSIGHT_DEEP_MODEL: z.string().default("claude-sonnet-5"),
  /** Monthly insight token budget per org (input+output tokens). */
  INSIGHT_ORG_BUDGET_TOKENS: z.coerce.number().default(5_000_000),

  /** Pinned @fission-ai/openspec version the onboarding worker installs (never `latest`: it executes on the Console host). */
  OPENSPEC_VERSION: z.string().default("1.8.0"),

  /** Staleness banner threshold, minutes since last successful sync. */
  STALENESS_THRESHOLD_MINUTES: z.coerce.number().default(15),
  /** Dev-only bypass: "1" allows login as a fixed dev user without GitHub OAuth. */
  DEV_FAKE_LOGIN: z.string().default("0"),
  NODE_ENV: z.string().default("development"),
});

export type ConsoleConfig = z.infer<typeof envSchema> & { githubAppPrivateKeyPem: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConsoleConfig {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    githubAppPrivateKeyPem: parsed.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
  };
}

export function requireProductionSecrets(cfg: ConsoleConfig): string[] {
  const missing: string[] = [];
  if (!cfg.GITHUB_APP_ID) missing.push("GITHUB_APP_ID");
  if (!cfg.githubAppPrivateKeyPem) missing.push("GITHUB_APP_PRIVATE_KEY");
  if (!cfg.GITHUB_APP_WEBHOOK_SECRET) missing.push("GITHUB_APP_WEBHOOK_SECRET");
  if (!cfg.GITHUB_OAUTH_CLIENT_ID) missing.push("GITHUB_OAUTH_CLIENT_ID");
  if (!cfg.GITHUB_OAUTH_CLIENT_SECRET) missing.push("GITHUB_OAUTH_CLIENT_SECRET");
  if (!cfg.CONSOLE_MASTER_KEY) missing.push("CONSOLE_MASTER_KEY");
  return missing;
}
