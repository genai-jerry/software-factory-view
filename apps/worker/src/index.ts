import { AppAuth, loadConfig } from "@console/core";
import { connectDb, runMigrations } from "@console/db";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { processWebhook, type WebhookJob } from "./ingest.js";
import { reconcileAll } from "./reconcile.js";

/**
 * Worker process: webhook projection, nightly + on-demand reconciliation.
 * Queues are split by concern so a slow artifact fetch never delays state
 * projection (plan 03 §6).
 */

const cfg = loadConfig();

async function main(): Promise<void> {
  await runMigrations(cfg.DATABASE_URL);
  const { db, close } = connectDb(cfg.DATABASE_URL);
  const connection = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const auth = new AppAuth({
    apiUrl: cfg.GITHUB_API_URL,
    appId: cfg.GITHUB_APP_ID,
    privateKeyPem: cfg.githubAppPrivateKeyPem,
    oauthClientId: cfg.GITHUB_OAUTH_CLIENT_ID,
    oauthClientSecret: cfg.GITHUB_OAUTH_CLIENT_SECRET,
  });

  const ingestWorker = new Worker<WebhookJob>(
    "ingest",
    async (job) => {
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

  console.log("worker up: queues=[ingest, reconcile]");

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
