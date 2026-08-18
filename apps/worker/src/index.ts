import { CredentialStore, loadConfig } from "@console/core";
import { connectDb, githubAppConfig, reconcileRuns, runMigrations, webhookDeliveries } from "@console/db";
import { Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { processWebhook, type WebhookJob } from "./ingest.js";
import { runOpenspecInit, type OpenspecJob } from "./openspec.js";
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
      try {
        // Re-read on each job: registration may have happened since boot.
        credentials.invalidate();
        const auth = await credentials.requireAuth();
        await processWebhook(db, cfg, auth, job.data);
      } catch (err) {
        // Stamp the failure on the delivery ledger so the Console's ingestion
        // log can show it — the retries still run, and success clears it.
        await db
          .update(webhookDeliveries)
          .set({ error: (err as Error).message })
          .where(eq(webhookDeliveries.deliveryGuid, job.data.deliveryGuid))
          .catch(() => undefined);
        throw err;
      }
    },
    { connection, concurrency: 4 },
  );
  ingestWorker.on("failed", (job, err) => {
    console.error(`ingest job ${job?.id} (${job?.data.event}) failed:`, err.message);
  });

  const reconcileWorker = new Worker<{ estateIds?: string[] }>(
    "reconcile",
    async (job) => {
      const startedAt = new Date();
      const trigger = job.name || "reconcile";
      try {
        credentials.invalidate();
        const auth = await credentials.requireAuth();
        const reports = await reconcileAll(db, cfg, auth, job.data.estateIds);
        for (const r of reports) {
          console.log(
            `reconciled estate ${r.estateId}: repos=${r.reposWalked} issues=${r.issuesSeen} prs=${r.pullsSeen}` +
              (r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : ""),
          );
          // One row per estate walked, so the Console's ingestion log can show
          // whether syncs run and what they tripped over.
          await db.insert(reconcileRuns).values({
            estateId: r.estateId,
            trigger,
            startedAt,
            finishedAt: new Date(),
            reposWalked: r.reposWalked,
            issuesSeen: r.issuesSeen,
            pullsSeen: r.pullsSeen,
            errors: r.errors,
          });
        }
        return reports;
      } catch (err) {
        // A run that died before producing reports (credentials, network) must
        // still leave a trace, or a broken sync looks like no sync at all.
        await db
          .insert(reconcileRuns)
          .values({ trigger, startedAt, finishedAt: new Date(), errors: [(err as Error).message] })
          .catch(() => undefined);
        throw err;
      }
    },
    { connection, concurrency: 1 },
  );
  reconcileWorker.on("failed", (job, err) => {
    console.error(`reconcile job ${job?.id} failed:`, err.message);
  });

  // Onboarding step 3: run the pinned OpenSpec CLI and push the scaffold to
  // the enablement branch. Serial — each job shells out to npx.
  const openspecWorker = new Worker<OpenspecJob>(
    "openspec",
    async (job) => {
      credentials.invalidate();
      const auth = await credentials.requireAuth();
      const result = await runOpenspecInit(db, cfg, auth, job.data);
      console.log(`openspec init for repo ${job.data.repoId}: found=${result.found} pushed=${result.pushed} skipped=${result.skipped}`);
      return result;
    },
    { connection, concurrency: 1 },
  );
  openspecWorker.on("failed", (job, err) => {
    console.error(`openspec job ${job?.id} (repo ${job?.data.repoId}) failed:`, err.message);
  });

  // Nightly reconciliation (03:17 UTC — off the top of the hour, politely off-peak).
  const reconcileQueue = new Queue("reconcile", { connection });
  await reconcileQueue.upsertJobScheduler("nightly-reconcile", { pattern: "17 3 * * *" }, { data: {} });

  const resolved = await credentials.resolve();
  console.log("worker up: queues=[ingest, reconcile, openspec]");
  if (credentials.credentialError) console.warn(`github app: ${credentials.credentialError}`);
  console.log(resolved ? `github app: ${resolved.slug ?? resolved.appId} (from ${resolved.source})` : "github app: not registered yet — jobs will wait");

  const shutdown = async () => {
    await ingestWorker.close();
    await reconcileWorker.close();
    await openspecWorker.close();
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
