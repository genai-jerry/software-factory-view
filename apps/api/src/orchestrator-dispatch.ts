import type { ConsoleConfig } from "@console/core";

/**
 * Ask the Software Factory orchestrator to run a role. GitHub App webhooks for
 * the Console land on PUBLIC_ORIGIN (ngrok → the Console), not on the
 * orchestrator, so labelling `factory:profile` never starts a LangGraph run by
 * itself. `/dispatch` is the Console's equivalent of "Run workflow".
 */
export type OrchestratorDispatch = {
  dispatched?: boolean;
  dispatchedAt?: string;
  dispatchId?: string;
  orchestratorUrl?: string;
  dispatchError?: string;
  run?: {
    id: string;
    htmlUrl: string;
    status: string;
    conclusion: null;
    createdAt: string;
    engine: "software-factory";
  };
};

export async function dispatchFactoryRole(
  cfg: ConsoleConfig,
  args: {
    owner: string;
    repo: string;
    role: string;
    issue: number;
    githubToken?: string;
    installationId?: number;
    anthropicApiKey?: string;
    claudeCodeOauthToken?: string;
  },
): Promise<OrchestratorDispatch> {
  const base = cfg.ORCHESTRATOR_URL.trim().replace(/\/+$/, "");
  const token = cfg.ORCHESTRATOR_DISPATCH_TOKEN.trim();
  if (!base) {
    return {
      dispatchError:
        "the Console filed the profile issue, but ORCHESTRATOR_URL is not set, so it never asked the Software Factory orchestrator to start. GitHub delivered the label event to the Console, not to :8080. Set ORCHESTRATOR_URL (from Docker: http://host.docker.internal:8080) and ORCHESTRATOR_DISPATCH_TOKEN to match the orchestrator's DISPATCH_TOKEN, then Re-run.",
    };
  }
  if (!token) {
    return {
      orchestratorUrl: base,
      dispatchError: `ORCHESTRATOR_DISPATCH_TOKEN is empty — the Console cannot call ${base}/dispatch. Set it to the orchestrator's DISPATCH_TOKEN, then Re-run.`,
    };
  }

  let res: Response;
  try {
    res = await fetch(`${base}/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        owner: args.owner,
        repo: args.repo,
        role: args.role,
        issue: args.issue,
        ...(args.githubToken ? { github_token: args.githubToken } : {}),
        ...(args.installationId ? { installation_id: args.installationId } : {}),
        ...(cfg.PUBLIC_ORIGIN ? { console_url: cfg.PUBLIC_ORIGIN.replace(/\/+$/, "") } : {}),
        ...(args.anthropicApiKey ? { anthropic_api_key: args.anthropicApiKey } : {}),
        ...(args.claudeCodeOauthToken ? { claude_code_oauth_token: args.claudeCodeOauthToken } : {}),
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    return {
      orchestratorUrl: base,
      dispatchError: `could not reach the orchestrator at ${base} (${(err as Error).message}). Is it running on :8080?`,
    };
  }

  const body = (await res.json().catch(() => ({}))) as { queued?: boolean; dispatch_id?: string; detail?: string };
  if (!res.ok) {
    return {
      orchestratorUrl: base,
      dispatchError: `orchestrator ${base}/dispatch returned ${res.status}${body.detail ? `: ${body.detail}` : ""}`,
    };
  }
  const dispatchId = typeof body.dispatch_id === "string" ? body.dispatch_id : "";
  const createdAt = new Date().toISOString();
  return {
    dispatched: true,
    dispatchedAt: createdAt,
    dispatchId,
    orchestratorUrl: base,
    run: {
      id: dispatchId || "queued",
      htmlUrl: `${base}/runs`,
      status: "queued",
      conclusion: null,
      createdAt,
      engine: "software-factory",
    },
  };
}

export type DispatchSync = { status: "pending" | "failed"; detail: Record<string, unknown> };

/**
 * /dispatch returns 200 as soon as the job is queued. Failures (bad App key,
 * clone errors) land on GET /deliveries/{id}. The onboarding poll reads that
 * so the card can leave "the Profiler is reading the repo".
 */
export async function syncDispatchStatus(
  cfg: ConsoleConfig,
  detail: Record<string, unknown>,
): Promise<DispatchSync | null> {
  const dispatchId = typeof detail.dispatchId === "string" ? detail.dispatchId : "";
  const base = (typeof detail.orchestratorUrl === "string" ? detail.orchestratorUrl : cfg.ORCHESTRATOR_URL)
    .trim()
    .replace(/\/+$/, "");
  const token = cfg.ORCHESTRATOR_DISPATCH_TOKEN.trim();
  if (!dispatchId || !base || !token || detail.dispatchError) return null;
  const run = detail.run as { status?: string; conclusion?: string | null } | undefined;
  if (run?.status === "completed" || run?.conclusion === "failure") return null;

  let res: Response;
  try {
    res = await fetch(`${base}/deliveries/${encodeURIComponent(dispatchId)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
  if (body.status !== "failed") return null;
  const error =
    typeof body.error === "string" && body.error
      ? body.error
      : "the Software Factory orchestrator failed before it started a run";
  const prev = (detail.run as Record<string, unknown> | undefined) ?? {};
  return {
    status: "failed",
    detail: {
      ...detail,
      dispatchError: error,
      error,
      run: {
        ...prev,
        id: prev.id ?? dispatchId,
        htmlUrl: typeof prev.htmlUrl === "string" ? prev.htmlUrl : `${base}/runs`,
        status: "completed",
        conclusion: "failure",
        engine: "software-factory",
      },
    },
  };
}

export type OrchestratorProxyError = { error: string; status: number };

function orchestratorBase(cfg: ConsoleConfig): { base: string; token: string } | OrchestratorProxyError {
  const base = cfg.ORCHESTRATOR_URL.trim().replace(/\/+$/, "");
  const token = cfg.ORCHESTRATOR_DISPATCH_TOKEN.trim();
  if (!base) return { error: "ORCHESTRATOR_URL is not set", status: 502 };
  if (!token) return { error: "ORCHESTRATOR_DISPATCH_TOKEN is empty", status: 502 };
  return { base, token };
}

/**
 * Whether this Console can talk to the orchestrator at all, and why not.
 * The epic workspace says this out loud rather than letting the user find out
 * by pressing a button that 502s.
 */
export function orchestratorConfigured(cfg: ConsoleConfig): { configured: boolean; detail: string | null } {
  const dest = orchestratorBase(cfg);
  if ("error" in dest) {
    return {
      configured: false,
      detail:
        dest.error === "ORCHESTRATOR_URL is not set"
          ? "ORCHESTRATOR_URL is not set, so the Console never forwards GitHub events to the orchestrator."
          : `ORCHESTRATOR_URL is ${cfg.ORCHESTRATOR_URL.trim()} but ORCHESTRATOR_DISPATCH_TOKEN is empty, so every call is rejected.`,
    };
  }
  return { configured: true, detail: null };
}

async function orchestratorGet(
  cfg: ConsoleConfig,
  path: string,
  opts: { asText?: boolean; timeoutMs?: number } = {},
): Promise<{ ok: true; status: number; body: unknown; text?: string } | OrchestratorProxyError> {
  const dest = orchestratorBase(cfg);
  if ("error" in dest) return dest;
  let res: Response;
  try {
    res = await fetch(`${dest.base}${path}`, {
      headers: { authorization: `Bearer ${dest.token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6_000),
    });
  } catch (err) {
    return { error: `could not reach the orchestrator (${(err as Error).message})`, status: 502 };
  }
  if (res.status === 404) return { error: "no such run", status: 404 };
  if (!res.ok) return { error: `orchestrator returned ${res.status}`, status: 502 };
  if (opts.asText) {
    return { ok: true, status: res.status, body: null, text: await res.text() };
  }
  return { ok: true, status: res.status, body: await res.json().catch(() => ({})) };
}

/** Console-side stand-in for GET /runs/{id} — the browser must not open :8080 JSON. */
export async function fetchOrchestratorRun(
  cfg: ConsoleConfig,
  runId: string,
): Promise<{ ok: true; run: Record<string, unknown> } | OrchestratorProxyError> {
  const got = await orchestratorGet(cfg, `/runs/${encodeURIComponent(runId)}`);
  if ("error" in got) return got;
  if (!got.body || typeof got.body !== "object" || Array.isArray(got.body)) {
    return { error: "orchestrator run was not an object", status: 502 };
  }
  return { ok: true, run: got.body as Record<string, unknown> };
}

export async function fetchOrchestratorTranscript(
  cfg: ConsoleConfig,
  runId: string,
): Promise<{ ok: true; transcript: string } | OrchestratorProxyError> {
  const got = await orchestratorGet(cfg, `/runs/${encodeURIComponent(runId)}/transcript`, { asText: true });
  if ("error" in got) return got;
  return { ok: true, transcript: got.text ?? "" };
}

export async function fetchOrchestratorRuns(
  cfg: ConsoleConfig,
  query: { repo: string; issue: number },
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; runs: unknown[] } | OrchestratorProxyError> {
  const params = new URLSearchParams({ repo: query.repo, issue: String(query.issue) });
  const got = await orchestratorGet(cfg, `/runs?${params}`, { timeoutMs: opts.timeoutMs });
  if ("error" in got) return got;
  return { ok: true, runs: Array.isArray(got.body) ? got.body : [] };
}
