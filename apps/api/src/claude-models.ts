import Anthropic from "@anthropic-ai/sdk";
import type { AppDeps } from "./context.js";
import { readRetainedAgentSecrets } from "./orchestrator-secrets.js";

/**
 * The Claude models the factory's own credential can see, for the picker on
 * Compass → Models — asked of the Models API (GET /v1/models) with the org's
 * stored Claude credential instead of a list written into Compass.
 *
 * A Claude Code sign-in (CLAUDE_CODE_OAUTH_TOKEN) is an OAuth token: Bearer
 * auth with the `oauth-2025-04-20` beta. An API key goes as x-api-key. When
 * both are stored, the sign-in is used, because it is what the factory's runs
 * use first. Listed per org for ten minutes; a failure is said, not cached.
 */

export interface AvailableModel {
  id: string;
  name: string;
  createdAt: string | null;
  deprecated: boolean;
}

export type Available =
  | { ok: true; source: "claude-sign-in" | "api-key"; models: AvailableModel[]; listedAt: string }
  | { ok: false; error: string };

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: Available & { ok: true } }>();

/** For tests. */
export function forgetListedModels(): void {
  cache.clear();
}

export async function listAvailableModels(deps: AppDeps, orgId: string, opts: { refresh?: boolean } = {}): Promise<Available> {
  const hit = cache.get(orgId);
  if (hit && !opts.refresh && Date.now() - hit.at < TTL_MS) return hit.value;
  const secrets = await readRetainedAgentSecrets(deps, orgId);
  const token = secrets.claudeCodeOauthToken?.trim();
  const key = secrets.anthropicApiKey?.trim();
  if (!token && !key) {
    return { ok: false, error: "No Claude credential is stored for the factory yet. Add a Claude sign-in or API key in Settings, then list again." };
  }
  // Credentials come only from what the org stored, never from this server's environment.
  const client = token
    ? new Anthropic({ apiKey: null, authToken: token, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" }, maxRetries: 1, timeout: 15_000 })
    : new Anthropic({ apiKey: key!, authToken: null, maxRetries: 1, timeout: 15_000 });
  try {
    const models: AvailableModel[] = [];
    for await (const m of client.models.list({ limit: 100 })) {
      models.push({ id: m.id, name: m.display_name || m.id, createdAt: m.created_at ?? null, deprecated: Boolean(m.deprecated_at) });
    }
    // Newest first, retired ones last.
    models.sort((a, b) => Number(a.deprecated) - Number(b.deprecated) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    const value = { ok: true as const, source: token ? ("claude-sign-in" as const) : ("api-key" as const), models, listedAt: new Date().toISOString() };
    cache.set(orgId, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return { ok: false, error: "Claude refused the stored credential. Sign in again in Settings, then list again." };
    }
    if (err instanceof Anthropic.RateLimitError) return { ok: false, error: "Claude is rate-limiting this credential. Try again in a minute." };
    if (err instanceof Anthropic.APIError) return { ok: false, error: `Claude could not list the models (${err.status ?? "no status"}).` };
    return { ok: false, error: "Compass could not reach Claude to list the models." };
  }
}
