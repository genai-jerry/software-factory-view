import { decryptSecret } from "@console/core";
import { mcpServers, repos } from "@console/db";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "./context.js";

/**
 * An org's Compass → Tools servers as the orchestrator takes them: sent in
 * each /ask (Shape, Ask) and served to role runs on
 * GET /api/orchestrator/mcp-servers. The production orchestrator has no
 * access to Compass's database, so this is how the servers reach it; header
 * values travel only on these dispatch-token-authenticated calls.
 */
export interface McpServerPayload {
  name: string;
  label: string;
  transport: "http" | "sse";
  url: string;
  headers: Record<string, string>;
  /** Only the allowed tools. */
  tools: string[];
  use_shape: boolean;
  use_ask: boolean;
  use_build: boolean;
}

/**
 * `projectId` is the project the session is about. A server scoped to projects
 * goes only to a session in one of them; with no project known (a new product,
 * a repository outside any project) only unscoped servers go. That keeps one
 * product's production logs out of another's investigation.
 */
export async function mcpPayloadFor(deps: AppDeps, orgId: string, projectId: string | null = null): Promise<McpServerPayload[]> {
  const rows = await deps.dbh.db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.orgId, orgId), eq(mcpServers.enabled, true)));
  const out: McpServerPayload[] = [];
  for (const r of rows) {
    if (r.projectIds.length > 0 && !(projectId && r.projectIds.includes(projectId))) continue;
    const tools = r.tools.filter((t) => t.allowed).map((t) => t.name);
    if (tools.length === 0) continue;
    let headers: Record<string, string> = {};
    if (r.encryptedHeaders) {
      if (!deps.cfg.CONSOLE_MASTER_KEY) continue;
      try {
        headers = JSON.parse(decryptSecret(r.encryptedHeaders, deps.cfg.CONSOLE_MASTER_KEY)) as Record<string, string>;
      } catch {
        continue; // sealed with another key: leave the server out rather than send it broken
      }
    }
    out.push({
      name: r.name,
      label: r.label,
      transport: r.transport,
      url: r.url,
      headers,
      tools,
      use_shape: r.useShape,
      use_ask: r.useAsk,
      use_build: r.useBuild,
    });
  }
  return out;
}

/** The same, for a session in a repository: its project decides which scoped servers apply. */
export async function mcpPayloadForRepo(deps: AppDeps, orgId: string, repoId: string | null): Promise<McpServerPayload[]> {
  const repo = repoId ? (await deps.dbh.db.select({ projectId: repos.projectId }).from(repos).where(eq(repos.id, repoId)).limit(1))[0] : undefined;
  return mcpPayloadFor(deps, orgId, repo?.projectId ?? null);
}
