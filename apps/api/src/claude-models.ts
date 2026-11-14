import Anthropic from "@anthropic-ai/sdk";
import type { AppDeps } from "./context.js";
import { readRetainedAgentSecrets } from "./orchestrator-secrets.js";

/**
 * The Claude models offered in the picker on Compass → Models.
 *
 * With a stored API key, Compass asks the Models API (GET /v1/models) which
 * models that key can use. A Claude Code sign-in (CLAUDE_CODE_OAUTH_TOKEN) is
 * never sent to the API: a subscription token is for the Claude Code binary
 * alone (Claude Code's legal and compliance terms), so with only a sign-in
 * stored the picker offers KNOWN_MODELS, written here, and a person can still
 * type any other id. The orchestrator's own probe decides at run time whether
 * a model is reachable. Listed per org for ten minutes; a failure is said, not
 * cached.
 */

export interface AvailableModel {
  id: string;
  name: string;
  createdAt: string | null;
  deprecated: boolean;
}

export type Available =
  | { ok: true; source: "known" | "api-key"; models: AvailableModel[]; listedAt: string }
  | { ok: false; error: string };

/**
 * Offered when only a Claude sign-in is stored, newest first. Add a model here
 * when Claude Code gains one; anything missing can still be typed.
 */
export const KNOWN_MODELS: readonly AvailableModel[] = [
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", createdAt: null, deprecated: false },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", createdAt: null, deprecated: false },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", createdAt: null, deprecated: false },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", createdAt: null, deprecated: false },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", createdAt: null, deprecated: false },
];

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
  if (!key) return { ok: true, source: "known", models: [...KNOWN_MODELS], listedAt: new Date().toISOString() };
  // Credentials come only from what the org stored, never from this server's environment.
  const client = new Anthropic({ apiKey: key, authToken: null, maxRetries: 1, timeout: 15_000 });
  try {
    const models: AvailableModel[] = [];
    for await (const m of client.models.list({ limit: 100 })) {
      models.push({ id: m.id, name: m.display_name || m.id, createdAt: m.created_at ?? null, deprecated: Boolean(m.deprecated_at) });
    }
    // Newest first, retired ones last.
    models.sort((a, b) => Number(a.deprecated) - Number(b.deprecated) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    const value = { ok: true as const, source: "api-key" as const, models, listedAt: new Date().toISOString() };
    cache.set(orgId, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return { ok: false, error: "Claude refused the stored API key. Replace it in Settings, then list again." };
    }
    if (err instanceof Anthropic.RateLimitError) return { ok: false, error: "Claude is rate-limiting this API key. Try again in a minute." };
    if (err instanceof Anthropic.APIError) return { ok: false, error: `Claude could not list the models (${err.status ?? "no status"}).` };
    return { ok: false, error: "Compass could not reach Claude to list the models." };
  }
}
