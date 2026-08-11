import { isLogLevel, LOG_LEVELS, LOG_LEVEL_SETTING, getRuntimeSetting, readLogs, setRuntimeSetting } from "@console/db";
import type { FastifyInstance } from "fastify";
import { requireOwner, type AppDeps } from "../context.js";

/**
 * Reading the application's own logs, and turning the level up or down while it
 * runs.
 *
 * A production Console is a pair of containers with no shell attached, so a
 * failing sync or a rejected webhook is otherwise invisible. Both processes
 * write into log_events; the worker's lines are the ones that matter most here,
 * since that is where projection and reconciliation run.
 *
 * Owner/admin only: logs carry whatever the instance happened to be doing,
 * across every connected org.
 */
export function registerLogRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get<{ Querystring: { level?: string; service?: string; search?: string; limit?: string; afterId?: string } }>(
    "/api/logs",
    async (req, reply) => {
      if (!(await requireOwner(deps, req, reply))) return;
      const { level, service, search, limit, afterId } = req.query;
      const rows = await readLogs(db, {
        level: isLogLevel(level) ? level : undefined,
        service: service === "api" || service === "worker" ? service : undefined,
        search: search?.trim() || undefined,
        limit: limit ? Number(limit) : undefined,
        afterId: afterId ? Number(afterId) : undefined,
      });
      return {
        // Oldest first: the UI appends, so a tail reads in the order things happened.
        events: rows.reverse(),
        level: await currentLevel(),
        levels: LOG_LEVELS,
      };
    },
  );

  app.get("/api/logs/level", async (req, reply) => {
    if (!(await requireOwner(deps, req, reply))) return;
    return { level: await currentLevel(), levels: LOG_LEVELS };
  });

  app.post<{ Body: { level?: string } }>("/api/logs/level", async (req, reply) => {
    const ctx = await requireOwner(deps, req, reply);
    if (!ctx) return;
    const level = req.body?.level;
    if (!isLogLevel(level)) return reply.code(400).send({ error: `level must be one of: ${LOG_LEVELS.join(", ")}` });

    await setRuntimeSetting(db, LOG_LEVEL_SETTING, level, ctx.login);
    // This process takes it immediately; the worker picks it up on its next
    // poll, within about fifteen seconds.
    deps.logs.setLevel(level);
    app.log.level = level;
    app.log.info({ level, by: ctx.login }, "log level changed");
    return { ok: true, level, note: "the worker applies this within ~15s" };
  });

  async function currentLevel(): Promise<string> {
    const stored = await getRuntimeSetting(db, LOG_LEVEL_SETTING);
    return isLogLevel(stored) ? stored : deps.logs.level;
  }
}
