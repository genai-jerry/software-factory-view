import { verifyWebhookSignature } from "@console/core";
import { webhookDeliveries } from "@console/db";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./context.js";

/**
 * Webhook ingestion contract (spec 01 §2.2): verify signature → record in the
 * idempotency ledger → enqueue raw → 200 immediately. No inline processing.
 * This route lives outside session/CSRF middleware and never sets cookies.
 */
export function registerWebhookRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post(
    "/webhooks/github",
    {
      config: { rawBody: true },
      // Capture the raw body for HMAC verification before JSON parsing.
      preParsing: async (req, _reply, payload) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks);
        (req as unknown as { rawBodyBuffer: Buffer }).rawBodyBuffer = raw;
        const { Readable } = await import("node:stream");
        return Readable.from([raw]);
      },
    },
    async (req, reply) => {
      const raw = (req as unknown as { rawBodyBuffer: Buffer }).rawBodyBuffer;
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!verifyWebhookSignature(deps.cfg.GITHUB_APP_WEBHOOK_SECRET, raw, signature)) {
        return reply.code(401).send({ error: "bad signature" });
      }
      const event = req.headers["x-github-event"] as string | undefined;
      const deliveryGuid = req.headers["x-github-delivery"] as string | undefined;
      if (!event || !deliveryGuid) return reply.code(400).send({ error: "missing event headers" });

      const inserted = await deps.dbh.db
        .insert(webhookDeliveries)
        .values({ deliveryGuid, event, payload: req.body as Record<string, unknown> })
        .onConflictDoNothing()
        .returning({ guid: webhookDeliveries.deliveryGuid });
      if (inserted.length === 0) return reply.code(200).send({ ok: true, duplicate: true });

      await deps.ingestQueue.add(
        "webhook",
        { deliveryGuid, event, payload: req.body },
        { removeOnComplete: 1000, removeOnFail: 5000, attempts: 5, backoff: { type: "exponential", delay: 2000 } },
      );
      return reply.code(200).send({ ok: true });
    },
  );
}
