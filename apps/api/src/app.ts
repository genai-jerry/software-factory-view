import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./auth.js";
import { registerWebhookRoutes } from "./webhooks.js";
import { registerReadRoutes } from "./routes/read.js";
import { registerGateRoutes } from "./routes/gate.js";
import { registerWriteRoutes } from "./routes/write.js";
import { registerQaRoutes } from "./routes/qa.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import type { AppDeps } from "./context.js";

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: deps.cfg.NODE_ENV === "test" ? "warn" : "info" } });
  await app.register(cookie);

  // No CORS is registered on purpose: the SPA is same-origin behind the edge
  // proxy, and the absence of CORS is one of the two CSRF layers (plan 02 §1a).
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/")) {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
    }
    return payload;
  });

  app.get("/api/health", async () => ({ ok: true, service: "console-api" }));

  registerAuthRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  registerReadRoutes(app, deps);
  registerGateRoutes(app, deps);
  registerWriteRoutes(app, deps);
  registerQaRoutes(app, deps);
  registerOnboardingRoutes(app, deps);

  return app;
}
