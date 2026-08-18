import { estates, reconcileRuns, webhookDeliveries } from "@console/db";
import { asc, desc, eq, isNull, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { setupAccess } from "../setup.js";
import type { AppDeps } from "../context.js";

/**
 * The operator's ingestion log — the server-side view of the pipeline that
 * feeds every other page: webhook deliveries from the ledger (with the
 * worker's processing errors) and reconcile runs. Gated like Settings: only
 * the GitHub App owner sees it, because delivery payloads and sync errors
 * span every estate on the instance, not one caller's orgs.
 */
export function registerOpsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get("/api/ops/ingestion", async (req, reply) => {
    const { allowed } = await setupAccess(deps, req);
    if (!allowed) return reply.code(403).send({ error: "only the GitHub App owner can view the ingestion log" });

    const summary = (
      await db
        .select({
          lastReceivedAt: dsql<Date | null>`max(${webhookDeliveries.receivedAt})`,
          lastProcessedAt: dsql<Date | null>`max(${webhookDeliveries.processedAt})`,
          pending: dsql<number>`count(*) filter (where ${webhookDeliveries.processedAt} is null)`,
          failing: dsql<number>`count(*) filter (where ${webhookDeliveries.processedAt} is null and ${webhookDeliveries.error} is not null)`,
          total: dsql<number>`count(*)`,
        })
        .from(webhookDeliveries)
    )[0]!;

    const deliveries = await db
      .select({
        deliveryGuid: webhookDeliveries.deliveryGuid,
        event: webhookDeliveries.event,
        action: dsql<string | null>`${webhookDeliveries.payload}->>'action'`,
        repo: dsql<string | null>`${webhookDeliveries.payload}->'repository'->>'full_name'`,
        receivedAt: webhookDeliveries.receivedAt,
        processedAt: webhookDeliveries.processedAt,
        error: webhookDeliveries.error,
      })
      .from(webhookDeliveries)
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(50);

    const reconciles = await db
      .select({ run: reconcileRuns, estateName: estates.name })
      .from(reconcileRuns)
      .leftJoin(estates, eq(estates.id, reconcileRuns.estateId))
      .orderBy(desc(reconcileRuns.startedAt))
      .limit(20);

    return {
      summary: {
        lastReceivedAt: summary.lastReceivedAt,
        lastProcessedAt: summary.lastProcessedAt,
        pending: Number(summary.pending),
        failing: Number(summary.failing),
        total: Number(summary.total),
      },
      deliveries,
      reconciles: reconciles.map(({ run, estateName }) => ({
        id: run.id,
        estateName: estateName ?? (run.estateId ? "(disconnected)" : null),
        trigger: run.trigger,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        reposWalked: run.reposWalked,
        issuesSeen: run.issuesSeen,
        pullsSeen: run.pullsSeen,
        errors: run.errors,
      })),
    };
  });

  /**
   * Re-enqueue every unprocessed delivery from the ledger, oldest first. A
   * delivery whose retries were exhausted while the worker was down is
   * otherwise stranded forever — GitHub got its 200 and will not redeliver.
   * The ledger kept the full payload and projections are idempotent, so
   * replaying is safe; a delivery that succeeds gets its processed_at stamp
   * and drops out of the pending count.
   */
  app.post("/api/ops/ingestion/replay", async (req, reply) => {
    const { allowed } = await setupAccess(deps, req);
    if (!allowed) return reply.code(403).send({ error: "only the GitHub App owner can replay deliveries" });
    if (req.headers["x-console-csrf"] !== "1") return reply.code(403).send({ error: "missing CSRF header" });

    const pending = await db
      .select({
        deliveryGuid: webhookDeliveries.deliveryGuid,
        event: webhookDeliveries.event,
        payload: webhookDeliveries.payload,
      })
      .from(webhookDeliveries)
      .where(isNull(webhookDeliveries.processedAt))
      .orderBy(asc(webhookDeliveries.receivedAt))
      .limit(1000);

    let queued = 0;
    for (const d of pending) {
      if (!d.payload) continue; // nothing to replay from
      await deps.ingestQueue.add(
        "webhook-replay",
        { deliveryGuid: d.deliveryGuid, event: d.event, payload: d.payload },
        { removeOnComplete: 1000, removeOnFail: 5000, attempts: 5, backoff: { type: "exponential", delay: 2000 } },
      );
      queued++;
    }
    return { ok: true, queued, pending: pending.length };
  });
}
