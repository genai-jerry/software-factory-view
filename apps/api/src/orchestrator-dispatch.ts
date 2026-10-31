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
    /** When the token above actually dies. Without it the orchestrator can
     *  only assume, and a role that outlives the assumption 401s mid-run. */
    githubTokenExpiresAt?: string;
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
        ...(args.githubTokenExpiresAt ? { github_token_expires_at: args.githubTokenExpiresAt } : {}),
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

async function orchestratorGet(
  cfg: ConsoleConfig,
  path: string,
  opts: { asText?: boolean } = {},
): Promise<{ ok: true; status: number; body: unknown; text?: string } | OrchestratorProxyError> {
  const dest = orchestratorBase(cfg);
  if ("error" in dest) return dest;
  let res: Response;
  try {
    res = await fetch(`${dest.base}${path}`, {
      headers: { authorization: `Bearer ${dest.token}` },
      signal: AbortSignal.timeout(6_000),
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

export interface PastRun {
  id: string;
  repo: string;
  issue: number;
  role: string;
  outcome: string;
  startedAt: string;
  finishedAt: string;
  model: string | null;
  error: string | null;
  /** The transcript can still be served; false once a redeploy has cleared it. Absent on an older orchestrator. */
  hasLog: boolean | null;
}

/**
 * The orchestrator's recent runs (its newest 100), finished ones only. An
 * orchestrator that cannot be reached gives an empty list, and the page
 * simply has no history to show.
 */
export async function fetchPastRuns(cfg: ConsoleConfig): Promise<PastRun[]> {
  const got = await orchestratorGet(cfg, "/runs");
  if ("error" in got || !Array.isArray(got.body)) return [];
  const out: PastRun[] = [];
  for (const r of got.body as Array<Record<string, unknown>>) {
    if (typeof r.id !== "string" || typeof r.repo !== "string" || typeof r.issue !== "number") continue;
    if (!r.finished_at || !r.started_at) continue;
    out.push({
      id: r.id,
      repo: r.repo,
      issue: r.issue,
      role: typeof r.role === "string" ? r.role : "",
      outcome: typeof r.outcome === "string" ? r.outcome : "",
      startedAt: String(r.started_at),
      finishedAt: String(r.finished_at),
      model: typeof r.model === "string" ? r.model : null,
      error: typeof r.error === "string" && r.error ? r.error : null,
      hasLog: typeof r.has_log === "boolean" ? r.has_log : null,
    });
  }
  return out;
}

export interface ActiveRun {
  id: string;
  /** The orchestrator's role name: implementer, reviewer, qa, release, … */
  role: string;
  startedAt: string;
}

/**
 * Every run live on the orchestrator right now, keyed `owner/repo#issue`
 * (the newest, where a restart left two). The run is what a "running" badge
 * should open: its log says what the agent is doing. An orchestrator that
 * cannot be reached, or is too old to list runs, gives an empty map — the
 * badge still shows, with the role guessed from the stage and no log link.
 */
export async function fetchActiveRuns(cfg: ConsoleConfig): Promise<Map<string, ActiveRun>> {
  const out = new Map<string, ActiveRun>();
  const got = await orchestratorGet(cfg, "/runs?active=true");
  if ("error" in got || !Array.isArray(got.body)) return out;
  for (const r of got.body as Array<{ id?: string; repo?: string; issue?: number; role?: string; started_at?: string }>) {
    if (!r.id || !r.repo || typeof r.issue !== "number") continue;
    const key = `${r.repo}#${r.issue}`;
    const startedAt = r.started_at ?? "";
    const prior = out.get(key);
    if (!prior || startedAt > prior.startedAt) out.set(key, { id: r.id, role: r.role ?? "", startedAt });
  }
  return out;
}

/**
 * A person's question about a thread, answered by the orchestrator's Claude
 * CLI (POST /ask) — the subscription token works there, not on the API. The
 * session reads the repo and runs for up to five minutes, so the timeout is
 * long and the error text is the reason to show the asker.
 */
export async function askOrchestrator(
  cfg: ConsoleConfig,
  body: {
    owner: string;
    repo: string;
    question: string;
    context: string;
    branch?: string;
    /** How to answer, when the caller has its own rules (the epic panel's citations). */
    instructions?: string;
    anthropicApiKey?: string;
    claudeCodeOauthToken?: string;
  },
): Promise<{ ok: true; answer: string; model: string; inputTokens: number; outputTokens: number } | OrchestratorProxyError> {
  const dest = orchestratorBase(cfg);
  if ("error" in dest) return dest;
  let res: Response;
  try {
    res = await fetch(`${dest.base}/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${dest.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        owner: body.owner,
        repo: body.repo,
        question: body.question,
        context: body.context,
        ...(body.branch ? { branch: body.branch } : {}),
        ...(body.instructions ? { instructions: body.instructions } : {}),
        ...(body.anthropicApiKey ? { anthropic_api_key: body.anthropicApiKey } : {}),
        ...(body.claudeCodeOauthToken ? { claude_code_oauth_token: body.claudeCodeOauthToken } : {}),
      }),
      signal: AbortSignal.timeout(330_000),
    });
  } catch (err) {
    return { error: `could not reach the orchestrator (${(err as Error).message})`, status: 502 };
  }
  const json = (await res.json().catch(() => ({}))) as {
    answer?: string;
    model?: string;
    detail?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return { error: "this orchestrator is too old to answer questions — redeploy it", status: 502 };
  }
  if (!res.ok || !json.answer) {
    return { error: json.detail || `orchestrator returned ${res.status}`, status: res.status === 429 ? 429 : 502 };
  }
  return {
    ok: true,
    answer: json.answer,
    model: json.model ?? "",
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
  };
}

/**
 * The orchestrator's GET /usage: the last five hours of Claude use and any
 * usage limit in force. An orchestrator older than that endpoint answers 404,
 * which reads as "nothing to show" rather than an error.
 */
export async function fetchOrchestratorUsage(
  cfg: ConsoleConfig,
): Promise<{ ok: true; usage: Record<string, unknown> | null } | OrchestratorProxyError> {
  const got = await orchestratorGet(cfg, "/usage");
  if ("error" in got) return got.status === 404 ? { ok: true, usage: null } : got;
  const body = got.body;
  return { ok: true, usage: body && typeof body === "object" ? (body as Record<string, unknown>) : null };
}

export async function fetchOrchestratorRuns(
  cfg: ConsoleConfig,
  query: { repo: string; issue: number },
): Promise<{ ok: true; runs: unknown[] } | OrchestratorProxyError> {
  const params = new URLSearchParams({ repo: query.repo, issue: String(query.issue) });
  const got = await orchestratorGet(cfg, `/runs?${params}`);
  if ("error" in got) return got;
  return { ok: true, runs: Array.isArray(got.body) ? got.body : [] };
}
