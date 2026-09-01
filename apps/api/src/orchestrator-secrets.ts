import { decryptSecret, encryptSecret, isAgentSecretName, type AgentSecretName } from "@console/core";
import { orchestratorSecrets } from "@console/db";
import { eq } from "drizzle-orm";
import type { AppDeps } from "./context.js";

export type RetainedAgentSecrets = {
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
};

/**
 * Seal an agent token in orchestrator_secrets. The Software Factory
 * orchestrator reads this table; GitHub Actions cannot. Retention is skipped
 * (and reported) when CONSOLE_MASTER_KEY is unset.
 */
export async function retainOrchestratorSecret(
  deps: AppDeps,
  opts: { orgId: string; name: AgentSecretName; value: string; updatedBy: string },
): Promise<{ stored: boolean }> {
  const key = deps.cfg.CONSOLE_MASTER_KEY;
  if (!key) return { stored: false };
  const encryptedValue = encryptSecret(opts.value, key);
  const now = new Date();
  await deps.dbh.db
    .insert(orchestratorSecrets)
    .values({
      orgId: opts.orgId,
      name: opts.name,
      encryptedValue,
      updatedBy: opts.updatedBy,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [orchestratorSecrets.orgId, orchestratorSecrets.name],
      set: { encryptedValue, updatedBy: opts.updatedBy, updatedAt: now },
    });
  return { stored: true };
}

export async function listRetainedSecretMeta(
  deps: AppDeps,
  orgId: string,
): Promise<Array<{ name: string; updatedAt: string; updatedBy: string | null; readable: boolean }>> {
  const key = deps.cfg.CONSOLE_MASTER_KEY;
  const rows = await deps.dbh.db.select().from(orchestratorSecrets).where(eq(orchestratorSecrets.orgId, orgId));
  return rows
    .filter((r) => isAgentSecretName(r.name))
    .map((r) => ({
      name: r.name,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: r.updatedBy,
      // False when the row was sealed under a previous CONSOLE_MASTER_KEY —
      // the Settings page tells the admin to re-enter the token.
      readable: key ? canDecrypt(r.encryptedValue, key) : false,
    }));
}

function canDecrypt(sealed: string, key: string): boolean {
  try {
    decryptSecret(sealed, key);
    return true;
  } catch {
    return false;
  }
}

export async function orgHasRetainedAgentSecret(deps: AppDeps, orgId: string): Promise<boolean> {
  const rows = await deps.dbh.db
    .select({ name: orchestratorSecrets.name })
    .from(orchestratorSecrets)
    .where(eq(orchestratorSecrets.orgId, orgId));
  return rows.some((r) => r.name === "ANTHROPIC_API_KEY" || r.name === "CLAUDE_CODE_OAUTH_TOKEN");
}

/** Decrypt the org's retained Claude credentials for a Software Factory dispatch. */
export async function readRetainedAgentSecrets(deps: AppDeps, orgId: string): Promise<RetainedAgentSecrets> {
  const key = deps.cfg.CONSOLE_MASTER_KEY;
  if (!key) return {};
  const rows = await deps.dbh.db.select().from(orchestratorSecrets).where(eq(orchestratorSecrets.orgId, orgId));
  const out: RetainedAgentSecrets = {};
  for (const row of rows) {
    if (row.name !== "ANTHROPIC_API_KEY" && row.name !== "CLAUDE_CODE_OAUTH_TOKEN") continue;
    let value: string;
    try {
      value = decryptSecret(row.encryptedValue, key);
    } catch (err) {
      // Sealed under a previous CONSOLE_MASTER_KEY. The dispatch treats these
      // as optional (the orchestrator falls back to its own credentials), so
      // skip rather than fail the whole dispatch; Settings flags the row.
      console.warn(
        `retained secret ${row.name} for org ${orgId} cannot be decrypted (${(err as Error).message}) — ` +
          "CONSOLE_MASTER_KEY has changed since it was saved; re-enter the token in Settings",
      );
      continue;
    }
    if (row.name === "ANTHROPIC_API_KEY") out.anthropicApiKey = value;
    else out.claudeCodeOauthToken = value;
  }
  return out;
}
