import { estates, reconcileRuns, webhookDeliveries } from "@console/db";
import { desc, eq, sql as dsql } from "drizzle-orm";
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
}
