import { CredentialStore, loadConfig } from "@console/core";
import { connectDb, githubAppConfig, runMigrations } from "@console/db";
import { Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { processWebhook, type WebhookJob } from "./ingest.js";
import { reconcileAll } from "./reconcile.js";

/**
 * Worker process: webhook projection, nightly + on-demand reconciliation.
 * Queues are split by concern so a slow artifact fetch never delays state
 * projection (plan 03 §6).
 *
 * GitHub App credentials are resolved per job from the shared store, so a
 * worker started before the App is registered picks it up without a restart.
 */

const cfg = loadConfig();

async function main(): Promise<void> {
  await runMigrations(cfg.DATABASE_URL);
  const { db, close } = connectDb(cfg.DATABASE_URL);
  const connection = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });

  const credentials = new CredentialStore({
    masterKey: cfg.CONSOLE_MASTER_KEY,
    apiUrl: cfg.GITHUB_API_URL,
    load: async () => (await db.select().from(githubAppConfig).where(eq(githubAppConfig.id, "default")).limit(1))[0] ?? null,
    env: {
      appId: cfg.GITHUB_APP_ID,
      privateKeyPem: cfg.githubAppPrivateKeyPem,
      webhookSecret: cfg.GITHUB_APP_WEBHOOK_SECRET,
      clientId: cfg.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: cfg.GITHUB_OAUTH_CLIENT_SECRET,
    },
  });

  const ingestWorker = new Worker<WebhookJob>(
    "ingest",
    async (job) => {
      // Re-read on each job: registration may have happened since boot.
      credentials.invalidate();
      const auth = await credentials.requireAuth();
      await processWebhook(db, cfg, auth, job.data);
    },
    { connection, concurrency: 4 },
  );
  ingestWorker.on("failed", (job, err) => {
    console.error(`ingest job ${job?.id} (${job?.data.event}) failed:`, err.message);
  });

  const reconcileWorker = new Worker<{ estateIds?: string[] }>(
    "reconcile",
    async (job) => {
      credentials.invalidate();
      const auth = await credentials.requireAuth();
      const reports = await reconcileAll(db, cfg, auth, job.data.estateIds);
      for (const r of reports) {
        console.log(
          `reconciled estate ${r.estateId}: repos=${r.reposWalked} issues=${r.issuesSeen} prs=${r.pullsSeen}` +
            (r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : ""),
        );
      }
      return reports;
    },
    { connection, concurrency: 1 },
  );
  reconcileWorker.on("failed", (job, err) => {
    console.error(`reconcile job ${job?.id} failed:`, err.message);
  });

  // Nightly reconciliation (03:17 UTC — off the top of the hour, politely off-peak).
  const reconcileQueue = new Queue("reconcile", { connection });
  await reconcileQueue.upsertJobScheduler("nightly-reconcile", { pattern: "17 3 * * *" }, { data: {} });

  const resolved = await credentials.resolve();
  console.log("worker up: queues=[ingest, reconcile]");
  console.log(resolved ? `github app: ${resolved.slug ?? resolved.appId} (from ${resolved.source})` : "github app: not registered yet — jobs will wait");

  const shutdown = async () => {
    await ingestWorker.close();
    await reconcileWorker.close();
    await reconcileQueue.close();
    await connection.quit();
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("worker failed to start:", err);
  process.exit(1);
});
