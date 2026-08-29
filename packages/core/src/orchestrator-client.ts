import type { ConsoleConfig } from "./config.js";

/**
 * POST a GitHub event to the Software Factory orchestrator. GitHub App
 * webhooks for the Console land on PUBLIC_ORIGIN, not on :8080, so the
 * worker (and the epic "Start factory run" button) must forward them.
 *
 * Agent tokens are sent beside the payload — the orchestrator applies them
 * in-process and must not persist them on the delivery ledger.
 */
export type OrchestratorEventResult =
  | { skipped: true }
  | { queued: boolean; deliveryGuid: string }
  | { error: string };

export async function postOrchestratorGitHubEvent(
  cfg: ConsoleConfig,
  args: {
    event: string;
    payload: Record<string, unknown>;
    deliveryGuid: string;
    githubToken?: string;
    githubTokenExpiresAt?: string;
    anthropicApiKey?: string;
    claudeCodeOauthToken?: string;
  },
): Promise<OrchestratorEventResult> {
  const base = cfg.ORCHESTRATOR_URL.trim().replace(/\/+$/, "");
  const token = cfg.ORCHESTRATOR_DISPATCH_TOKEN.trim();
  if (!base) return { skipped: true };
  if (!token) {
    return {
      error: `ORCHESTRATOR_DISPATCH_TOKEN is empty — the Console cannot call ${base}/events. Set it to the orchestrator's DISPATCH_TOKEN.`,
    };
  }

  let res: Response;
  try {
    res = await fetch(`${base}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        event: args.event,
        payload: args.payload,
        delivery_guid: args.deliveryGuid,
        ...(args.githubToken ? { github_token: args.githubToken } : {}),
        ...(args.githubTokenExpiresAt ? { github_token_expires_at: args.githubTokenExpiresAt } : {}),
        ...(cfg.PUBLIC_ORIGIN ? { console_url: cfg.PUBLIC_ORIGIN.replace(/\/+$/, "") } : {}),
        ...(args.anthropicApiKey ? { anthropic_api_key: args.anthropicApiKey } : {}),
        ...(args.claudeCodeOauthToken ? { claude_code_oauth_token: args.claudeCodeOauthToken } : {}),
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    return { error: `could not reach the orchestrator at ${base} (${(err as Error).message}). Is it running on :8080?` };
  }

  const body = (await res.json().catch(() => ({}))) as {
    queued?: boolean;
    delivery_guid?: string;
    detail?: string;
  };
  if (!res.ok) {
    return {
      error: `orchestrator ${base}/events returned ${res.status}${body.detail ? `: ${body.detail}` : ""}`,
    };
  }
  return {
    queued: body.queued !== false,
    deliveryGuid: typeof body.delivery_guid === "string" ? body.delivery_guid : args.deliveryGuid,
  };
}
