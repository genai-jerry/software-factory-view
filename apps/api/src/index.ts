import { CredentialStore, loadConfig } from "@console/core";
import { connectDb, getRuntimeSetting, githubAppConfig, isLogLevel, LogStore, LOG_LEVEL_SETTING, runMigrations } from "@console/db";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { buildApp } from "./app.js";

const cfg = loadConfig();

async function main(): Promise<void> {
  // CONSOLE_MASTER_KEY is the one credential the environment must supply — it
  // decrypts everything else. GitHub App credentials are registered in-app.
  if (!cfg.CONSOLE_MASTER_KEY) {
    const message = "CONSOLE_MASTER_KEY is not set. Run ./scripts/setup.sh (or: openssl rand -base64 32).";
    if (cfg.NODE_ENV === "production") throw new Error(message);
    console.warn(`[dev] ${message} Sign-in and setup are disabled until it is.`);
  }

  await runMigrations(cfg.DATABASE_URL);
  const dbh = connectDb(cfg.DATABASE_URL);

  // Logs go to the database as well as stdout: a deployed Console is a
  // container with no shell, and the UI is the only way in. followLevel keeps
  // this process in step with the level set from that UI.
  const stored = await getRuntimeSetting(dbh.db, LOG_LEVEL_SETTING).catch(() => null);
  const logs = new LogStore(dbh.db, { service: "api", level: isLogLevel(stored) ? stored : cfg.LOG_LEVEL });
  logs.captureConsole();
  logs.start({ followLevel: true });
  const connection = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });

  const credentials = new CredentialStore({
    masterKey: cfg.CONSOLE_MASTER_KEY,
    apiUrl: cfg.GITHUB_API_URL,
    load: async () => (await dbh.db.select().from(githubAppConfig).where(eq(githubAppConfig.id, "default")).limit(1))[0] ?? null,
    env: {
      appId: cfg.GITHUB_APP_ID,
      privateKeyPem: cfg.githubAppPrivateKeyPem,
      webhookSecret: cfg.GITHUB_APP_WEBHOOK_SECRET,
      clientId: cfg.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: cfg.GITHUB_OAUTH_CLIENT_SECRET,
    },
  });

  const ingestQueue = new Queue("ingest", { connection });
  const reconcileQueue = new Queue("reconcile", { connection });

  const app = await buildApp({ cfg, dbh, credentials, ingestQueue, reconcileQueue, logs });
  await app.listen({ port: cfg.API_PORT, host: "0.0.0.0" });

  const resolved = await credentials.resolve();
  console.log(`api up on :${cfg.API_PORT}`);
  console.log(
    resolved
      ? `github app: ${resolved.slug ?? resolved.appId} (from ${resolved.source})`
      : `github app: not registered yet — open ${cfg.PUBLIC_ORIGIN}/setup to create one`,
  );
}

main().catch((err) => {
  console.error("api failed to start:", err);
  process.exit(1);
});
