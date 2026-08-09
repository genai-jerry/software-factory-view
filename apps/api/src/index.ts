import { AppAuth, loadConfig, requireProductionSecrets } from "@console/core";
import { connectDb, runMigrations } from "@console/db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { buildApp } from "./app.js";

const cfg = loadConfig();

async function main(): Promise<void> {
  const missing = requireProductionSecrets(cfg);
  if (missing.length > 0) {
    if (cfg.NODE_ENV === "production") {
      throw new Error(`missing required configuration: ${missing.join(", ")}`);
    }
    console.warn(`[dev] missing configuration (some features disabled): ${missing.join(", ")}`);
  }

  await runMigrations(cfg.DATABASE_URL);
  const dbh = connectDb(cfg.DATABASE_URL);
  const connection = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const auth = new AppAuth({
    apiUrl: cfg.GITHUB_API_URL,
    appId: cfg.GITHUB_APP_ID,
    privateKeyPem: cfg.githubAppPrivateKeyPem,
    oauthClientId: cfg.GITHUB_OAUTH_CLIENT_ID,
    oauthClientSecret: cfg.GITHUB_OAUTH_CLIENT_SECRET,
  });
  const ingestQueue = new Queue("ingest", { connection });
  const reconcileQueue = new Queue("reconcile", { connection });

  const app = await buildApp({ cfg, dbh, auth, ingestQueue, reconcileQueue });
  await app.listen({ port: cfg.API_PORT, host: "0.0.0.0" });
  console.log(`api up on :${cfg.API_PORT}`);
}

main().catch((err) => {
  console.error("api failed to start:", err);
  process.exit(1);
});
