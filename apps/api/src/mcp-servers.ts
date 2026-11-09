import { decryptSecret } from "@console/core";
import { mcpServers } from "@console/db";
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

export async function mcpPayloadFor(deps: AppDeps, orgId: string): Promise<McpServerPayload[]> {
  const rows = await deps.dbh.db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.orgId, orgId), eq(mcpServers.enabled, true)));
  const out: McpServerPayload[] = [];
  for (const r of rows) {
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
